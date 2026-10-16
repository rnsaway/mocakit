import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MocaCommandError } from '../errors.js';
import { baseConfig, fakeMoca, loginOk, mocaXml } from '../../test/helpers/fake-moca.js';
import { fakeOs, type FakeOsOptions } from '../../test/helpers/fake-os.js';
import { buildZip } from '../../test/helpers/zip-builder.js';
import { MocaClient } from '../client/client.js';
import { readJavaServer, osExecFor, type JavaServerRead } from './server-reader.js';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const jar = (cls: string, pad = 0): Uint8Array =>
  buildZip({ [`${cls}.class`]: 'x'.repeat(pad + 1), 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\n' });
const bytes = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

const WIDGETS = jar('com/acme/cust/Widgets');
const ONE = jar('com/acme/cust/One');
const CORE = jar('com/acme/base/Core');
const BASE_LIB = jar('com/acme/base/Lib');
const CLS = new TextEncoder().encode('class-bytes');

function posixFiles(): Record<string, Uint8Array> {
  return {
    '/opt/acme/cust/lib/widgets.jar': WIDGETS,
    '/opt/acme/cust/ext/one.jar': ONE,
    '/opt/acme/cust/classes/com/acme/cust/Thing.class': CLS,
    '/opt/acme/base/core.jar': CORE,
    '/opt/acme/base/lib/lib.jar': BASE_LIB,
  };
}

const POSIX_CP = '/opt/acme/cust/lib/*:/opt/acme/cust/classes:/opt/acme/cust/ext/one.jar:/opt/acme/base/lib/*:/opt/acme/base/core.jar';

function posix(extra: Partial<FakeOsOptions> = {}): FakeOsOptions {
  return {
    family: 'posix',
    env: { LESDIR: '/opt/acme/cust', CLASSPATH: POSIX_CP },
    files: posixFiles(),
    ...extra,
  };
}

const defaults = { roots: ['$LESDIR'], maxFileSize: 25 * 1024 * 1024, cached: () => false };

function pathsOf(read: JavaServerRead): string[] {
  return read.files.map((f) => f.path);
}

describe('readJavaServer (posix)', () => {
  it('selects only the entries under the root and reads their bytes and checksums', async () => {
    const fake = fakeOs(posix());
    const read = await readJavaServer(fake.exec, defaults);
    expect(read.family).toBe('posix');
    expect(read.lesDir).toBe('/opt/acme/cust');
    expect(read.classpath).toBe(POSIX_CP);
    expect(read.entries.filter((e) => e.selected).map((e) => e.index)).toEqual([0, 1, 2]);
    expect(pathsOf(read)).toEqual([
      '/opt/acme/cust/lib/widgets.jar',
      '/opt/acme/cust/classes/com/acme/cust/Thing.class',
      '/opt/acme/cust/ext/one.jar',
    ]);
    expect(read.files.map((f) => f.entryIndex)).toEqual([0, 1, 2]);
    const widgets = read.files[0]!;
    expect(widgets.size).toBe(WIDGETS.length);
    expect(widgets.sha256).toBe(sha(WIDGETS));
    expect(Buffer.from(widgets.bytes!).equals(Buffer.from(WIDGETS))).toBe(true);
    expect(Buffer.from(read.files[1]!.bytes!).equals(Buffer.from(CLS))).toBe(true);
    expect(read.missing).toEqual([]);
    expect(read.warnings).toEqual([]);
    // never downloads unselected entries
    expect(fake.commands.some((c) => c.includes('/opt/acme/base/core.jar') && c.startsWith('base64'))).toBe(false);
    expect(fake.commands.filter((c) => c.includes('MOCAKIT-FILE')).join(' ')).not.toContain('/opt/acme/base/');
  });

  it('only issues commands built from the templates', async () => {
    const fake = fakeOs(posix());
    await readJavaServer(fake.exec, defaults);
    // fakeOs throws on any command that is not a rebuilt template, so reaching here means all matched
    expect(fake.commands[0]).toBe('uname -s');
    expect(fake.commands).toContain('printenv LESDIR');
    expect(fake.commands).toContain('printenv CLASSPATH');
    expect(fake.commands.every((c) => !/>(?!\s*\/dev\/null)/.test(c.replace('2>/dev/null', '')))).toBe(true);
  });

  it('fetches a 250-byte file in 3 ranges and puts two 40-byte files in one batch', async () => {
    const big = bytes(250, 1);
    const a = bytes(40, 2);
    const b = bytes(40, 3);
    const fake = fakeOs({
      family: 'posix',
      env: { LESDIR: '/opt/acme/cust', CLASSPATH: '/opt/acme/cust/lib/*' },
      files: { '/opt/acme/cust/lib/big.jar': big, '/opt/acme/cust/lib/a.jar': a, '/opt/acme/cust/lib/b.jar': b },
    });
    const read = await readJavaServer(fake.exec, { ...defaults, batchBytes: 100, rangeBytes: 100 });
    expect(fake.commands.filter((c) => c.startsWith('tail '))).toHaveLength(3);
    const batches = fake.commands.filter((c) => c.includes('MOCAKIT-FILE'));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toContain('/opt/acme/cust/lib/a.jar');
    expect(batches[0]).toContain('/opt/acme/cust/lib/b.jar');
    const byPath = new Map(read.files.map((f) => [f.path, f]));
    expect(Buffer.from(byPath.get('/opt/acme/cust/lib/big.jar')!.bytes!).equals(Buffer.from(big))).toBe(true);
    expect(Buffer.from(byPath.get('/opt/acme/cust/lib/a.jar')!.bytes!).equals(Buffer.from(a))).toBe(true);
    expect(Buffer.from(byPath.get('/opt/acme/cust/lib/b.jar')!.bytes!).equals(Buffer.from(b))).toBe(true);
  });

  it('splits small files into several batches when they exceed batchBytes', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i++) files[`/opt/acme/cust/lib/f${i}.jar`] = bytes(40, i);
    const fake = fakeOs({ family: 'posix', env: { LESDIR: '/opt/acme/cust', CLASSPATH: '/opt/acme/cust/lib/*' }, files });
    const read = await readJavaServer(fake.exec, { ...defaults, batchBytes: 100, rangeBytes: 100 });
    expect(fake.commands.filter((c) => c.includes('MOCAKIT-FILE'))).toHaveLength(3);
    expect(read.files.every((f) => f.bytes !== undefined)).toBe(true);
  });

  it('skips the download when cached returns true', async () => {
    const fake = fakeOs(posix());
    const seen: string[] = [];
    const read = await readJavaServer(fake.exec, {
      ...defaults,
      cached: (h) => {
        seen.push(h);
        return true;
      },
    });
    expect(read.files).toHaveLength(3);
    expect(read.files.every((f) => f.bytes === undefined)).toBe(true);
    expect(seen).toContain(sha(WIDGETS));
    expect(fake.commands.some((c) => c.includes('base64'))).toBe(false);
    expect(read.files[0]!.sha256).toBe(sha(WIDGETS));
  });

  it('only downloads the files that are not cached', async () => {
    const fake = fakeOs(posix());
    const read = await readJavaServer(fake.exec, { ...defaults, cached: (h) => h === sha(WIDGETS) });
    expect(read.files[0]!.bytes).toBeUndefined();
    expect(read.files[1]!.bytes).toBeDefined();
    expect(read.files[2]!.bytes).toBeDefined();
  });

  it('throws on a checksum mismatch naming the path and both hashes', async () => {
    const fake = fakeOs(posix({ corrupt: ['/opt/acme/cust/ext/one.jar'] }));
    const flipped = Uint8Array.from(ONE);
    flipped[0] = flipped[0]! ^ 0xff;
    await expect(readJavaServer(fake.exec, defaults)).rejects.toThrow(
      `checksum mismatch for /opt/acme/cust/ext/one.jar (server ${sha(ONE)}, downloaded ${sha(flipped)})`,
    );
  });

  it('treats a read that came back empty as a mismatch', async () => {
    const fake = fakeOs(posix({ unreadable: ['/opt/acme/cust/ext/one.jar'] }));
    await expect(readJavaServer(fake.exec, defaults)).rejects.toThrow(
      `checksum mismatch for /opt/acme/cust/ext/one.jar (server ${sha(ONE)}, downloaded ${sha(new Uint8Array())})`,
    );
  });

  it('detects corruption in a ranged download', async () => {
    const big = bytes(250, 1);
    const fake = fakeOs({
      family: 'posix',
      env: { LESDIR: '/opt/acme/cust', CLASSPATH: '/opt/acme/cust/lib/*' },
      files: { '/opt/acme/cust/lib/big.jar': big },
      corrupt: ['/opt/acme/cust/lib/big.jar'],
    });
    await expect(readJavaServer(fake.exec, { ...defaults, batchBytes: 100, rangeBytes: 100 })).rejects.toThrow(
      /^checksum mismatch for \/opt\/acme\/cust\/lib\/big\.jar \(server [0-9a-f]{64}, downloaded [0-9a-f]{64}\)$/,
    );
  });

  it('skips a file over maxFileSize with a warning', async () => {
    const fake = fakeOs(posix());
    const read = await readJavaServer(fake.exec, { ...defaults, maxFileSize: WIDGETS.length - 1 });
    expect(pathsOf(read)).not.toContain('/opt/acme/cust/lib/widgets.jar');
    expect(read.warnings.some((w) => w.includes('/opt/acme/cust/lib/widgets.jar') && w.includes('maxFileSize'))).toBe(true);
    expect(fake.commands.some((c) => c.includes('widgets.jar') && c.includes('base64'))).toBe(false);
  });

  it('skips a listed file with an unsafe path with a warning', async () => {
    const files = { ...posixFiles(), '/opt/acme/cust/lib/odd$name.jar': WIDGETS };
    const fake = fakeOs(posix({ files }));
    const read = await readJavaServer(fake.exec, defaults);
    expect(pathsOf(read).some((p) => p.includes('odd'))).toBe(false);
    expect(read.warnings.some((w) => w.includes('/opt/acme/cust/lib/odd$name.jar'))).toBe(true);
    expect(fake.commands.some((c) => c.includes('odd'))).toBe(false);
  });

  it('skips an unsafe classpath entry with a warning instead of throwing', async () => {
    const env = { LESDIR: '/opt/acme/cust', CLASSPATH: '/opt/acme/cust/lib/*:/opt/acme/cust/we$ird.jar' };
    const fake = fakeOs(posix({ env }));
    const read = await readJavaServer(fake.exec, defaults);
    expect(read.warnings.some((w) => w.includes('/opt/acme/cust/we$ird.jar'))).toBe(true);
    expect(pathsOf(read)).toEqual(['/opt/acme/cust/lib/widgets.jar']);
  });

  it('passes selectEntries warnings (relative entries) through', async () => {
    const env = { LESDIR: '/opt/acme/cust', CLASSPATH: 'lib/x.jar:/opt/acme/cust/lib/*' };
    const read = await readJavaServer(fakeOs(posix({ env })).exec, defaults);
    expect(read.warnings.some((w) => w.includes('lib/x.jar') && w.includes('not an absolute path'))).toBe(true);
  });

  it('is fine with an empty or missing wildcard folder', async () => {
    const env = {
      LESDIR: '/opt/acme/cust',
      CLASSPATH: '/opt/acme/cust/empty/*:/opt/acme/cust/nothere/*:/opt/acme/cust/lib/*',
    };
    const fake = fakeOs(posix({ env, dirs: ['/opt/acme/cust/empty'] }));
    const read = await readJavaServer(fake.exec, defaults);
    expect(pathsOf(read)).toEqual(['/opt/acme/cust/lib/widgets.jar']);
    expect(read.missing).toEqual([]);
    expect(read.warnings).toEqual([]);
  });

  it('reports a missing jar entry and a missing classes folder', async () => {
    const env = {
      LESDIR: '/opt/acme/cust',
      CLASSPATH: '/opt/acme/cust/lib/*:/opt/acme/cust/gone.jar:/opt/acme/cust/nodir:/opt/acme/cust/emptydir',
    };
    const fake = fakeOs(posix({ env, dirs: ['/opt/acme/cust/emptydir'] }));
    const read = await readJavaServer(fake.exec, defaults);
    expect(read.missing).toEqual([1, 2]);
    expect(read.warnings).toContain('classpath entry /opt/acme/cust/gone.jar does not exist on the server');
    expect(read.warnings).toContain('classpath entry /opt/acme/cust/nodir does not exist on the server');
    expect(read.warnings.filter((w) => w.includes('emptydir'))).toEqual([]);
    expect(pathsOf(read)).toEqual(['/opt/acme/cust/lib/widgets.jar']);
  });

  it('downloads a file whose path contains a space', async () => {
    const spaced = jar('com/acme/cust/Spaced');
    const env = { LESDIR: '/opt/acme/cust', CLASSPATH: '/opt/acme/cust/my lib/*:/opt/acme/cust/ext dir/two.jar' };
    const two = jar('com/acme/cust/Two');
    const fake = fakeOs(
      posix({ env, files: { '/opt/acme/cust/my lib/spaced one.jar': spaced, '/opt/acme/cust/ext dir/two.jar': two } }),
    );
    const read = await readJavaServer(fake.exec, defaults);
    expect(pathsOf(read)).toEqual(['/opt/acme/cust/my lib/spaced one.jar', '/opt/acme/cust/ext dir/two.jar']);
    expect(Buffer.from(read.files[0]!.bytes!).equals(Buffer.from(spaced))).toBe(true);
    expect(Buffer.from(read.files[1]!.bytes!).equals(Buffer.from(two))).toBe(true);
  });

  it('lists the classes of unselected jars when unzip is installed', async () => {
    const read = await readJavaServer(fakeOs(posix()).exec, defaults);
    expect([...read.zipListings.keys()].sort()).toEqual(['/opt/acme/base/core.jar', '/opt/acme/base/lib/lib.jar']);
    expect(read.zipListings.get('/opt/acme/base/core.jar')).toEqual(['com/acme/base/Core.class']);
    expect(read.zipListings.get('/opt/acme/base/lib/lib.jar')).toEqual(['com/acme/base/Lib.class']);
    expect(read.warnings).toEqual([]);
  });

  it('gives an empty listing map and one warning when unzip is missing', async () => {
    const fake = fakeOs(posix({ unzip: false }));
    const read = await readJavaServer(fake.exec, defaults);
    expect(read.zipListings.size).toBe(0);
    expect(read.warnings).toEqual(['unzip is not available on the server; classes of non-downloaded entries are unknown']);
    expect(fake.commands.some((c) => c.startsWith('unzip'))).toBe(false);
  });

  it('does not warn about unzip when every entry is selected', async () => {
    const env = { LESDIR: '/opt/acme/cust', CLASSPATH: '/opt/acme/cust/lib/*' };
    const read = await readJavaServer(fakeOs(posix({ env, unzip: false })).exec, defaults);
    expect(read.warnings).toEqual([]);
  });

  it('honours a custom root', async () => {
    const read = await readJavaServer(fakeOs(posix()).exec, { ...defaults, roots: ['$LESDIR', 'base'] });
    expect(read.files.map((f) => f.path)).toContain('/opt/acme/base/core.jar');
    expect(read.zipListings.size).toBe(0);
  });

  it('throws when LESDIR or CLASSPATH is empty', async () => {
    await expect(
      readJavaServer(fakeOs(posix({ env: { CLASSPATH: POSIX_CP } })).exec, defaults),
    ).rejects.toThrow('Java introspection: LESDIR is empty on the server');
    await expect(
      readJavaServer(fakeOs(posix({ env: { LESDIR: '/opt/acme/cust', CLASSPATH: '' } })).exec, defaults),
    ).rejects.toThrow('Java introspection: CLASSPATH is empty on the server');
  });

  it('throws the unavailable error with the last status when both detections fail', async () => {
    const fake = fakeOs(posix({ unavailable: 127 }));
    await expect(readJavaServer(fake.exec, defaults)).rejects.toThrow(
      'Java introspection needs the MOCA command "execute os command", which is unavailable on this server (status 127)',
    );
    expect(fake.commands).toEqual(['uname -s', 'ver']);
  });

  it('rethrows errors that are not command failures', async () => {
    await expect(
      readJavaServer(async () => {
        throw new TypeError('boom');
      }, defaults),
    ).rejects.toThrow('boom');
  });

  it('sorts files by entry index then path', async () => {
    const files = { ...posixFiles(), '/opt/acme/cust/lib/a-first.jar': ONE };
    const read = await readJavaServer(fakeOs(posix({ files })).exec, defaults);
    expect(pathsOf(read).slice(0, 2)).toEqual(['/opt/acme/cust/lib/a-first.jar', '/opt/acme/cust/lib/widgets.jar']);
  });
});

describe('readJavaServer (windows)', () => {
  const WIN_CP = 'C:\\acme\\cust\\lib\\*;C:\\acme\\cust\\classes;C:\\acme\\cust\\ext\\one.jar;C:\\acme\\base\\lib\\*;C:\\acme\\base\\core.jar';
  const win = (extra: Partial<FakeOsOptions> = {}): FakeOsOptions => ({
    family: 'windows',
    env: { LESDIR: 'C:\\acme\\cust', CLASSPATH: WIN_CP },
    files: {
      'C:\\acme\\cust\\lib\\widgets.jar': WIDGETS,
      'C:\\acme\\cust\\ext\\one.jar': ONE,
      'C:\\acme\\cust\\classes\\com\\acme\\cust\\Thing.class': CLS,
      'C:\\acme\\base\\core.jar': CORE,
      'C:\\acme\\base\\lib\\lib.jar': BASE_LIB,
    },
    ...extra,
  });

  it('reads the same files as the posix flow', async () => {
    const fake = fakeOs(win());
    const read = await readJavaServer(fake.exec, defaults);
    expect(read.family).toBe('windows');
    expect(read.lesDir).toBe('C:\\acme\\cust');
    expect(pathsOf(read)).toEqual([
      'C:\\acme\\cust\\lib\\widgets.jar',
      'C:\\acme\\cust\\classes\\com\\acme\\cust\\Thing.class',
      'C:\\acme\\cust\\ext\\one.jar',
    ]);
    expect(read.files.map((f) => f.sha256)).toEqual([sha(WIDGETS), sha(CLS), sha(ONE)]);
    expect(Buffer.from(read.files[0]!.bytes!).equals(Buffer.from(WIDGETS))).toBe(true);
    expect(Buffer.from(read.files[1]!.bytes!).equals(Buffer.from(CLS))).toBe(true);
    expect(Buffer.from(read.files[2]!.bytes!).equals(Buffer.from(ONE))).toBe(true);
    expect(fake.commands.slice(0, 2)).toEqual(['uname -s', 'ver']);
    expect(read.zipListings.size).toBe(0);
    expect(read.warnings).toEqual(['unzip is not available on the server; classes of non-downloaded entries are unknown']);
  });

  it('ranges and batches the same way', async () => {
    const big = bytes(250, 1);
    const fake = fakeOs({
      family: 'windows',
      env: { LESDIR: 'C:\\acme\\cust', CLASSPATH: 'C:\\acme\\cust\\lib\\*' },
      files: { 'C:\\acme\\cust\\lib\\big.jar': big, 'C:\\acme\\cust\\lib\\a.jar': bytes(40, 2), 'C:\\acme\\cust\\lib\\b.jar': bytes(40, 3) },
    });
    const read = await readJavaServer(fake.exec, { ...defaults, batchBytes: 100, rangeBytes: 100 });
    expect(fake.commands.filter((c) => c.includes('Seek('))).toHaveLength(3);
    expect(fake.commands.filter((c) => c.includes('==MOCAKIT-FILE'))).toHaveLength(1);
    expect(Buffer.from(read.files.find((f) => f.path.endsWith('big.jar'))!.bytes!).equals(Buffer.from(big))).toBe(true);
  });

  it('treats an unset variable as empty and reports a missing jar', async () => {
    await expect(readJavaServer(fakeOs(win({ env: { LESDIR: 'C:\\acme\\cust' } })).exec, defaults)).rejects.toThrow(
      'Java introspection: CLASSPATH is empty on the server',
    );
    const env = { LESDIR: 'C:\\acme\\cust', CLASSPATH: 'C:\\acme\\cust\\lib\\*;C:\\acme\\cust\\gone.jar' };
    const read = await readJavaServer(fakeOs(win({ env })).exec, defaults);
    expect(read.missing).toEqual([1]);
    expect(read.warnings).toContain('classpath entry C:\\acme\\cust\\gone.jar does not exist on the server');
  });

  it('reports a checksum mismatch', async () => {
    const fake = fakeOs(win({ corrupt: ['C:\\acme\\cust\\ext\\one.jar'] }));
    await expect(readJavaServer(fake.exec, defaults)).rejects.toThrow(
      /^checksum mismatch for C:\\acme\\cust\\ext\\one\.jar \(server [0-9a-f]{64}, downloaded [0-9a-f]{64}\)$/,
    );
  });
});

describe('osExecFor', () => {
  it('runs execute os command with the quoted command and joins the rows in order', async () => {
    const fake = fakeMoca((req) =>
      req.query.startsWith('login user')
        ? loginOk()
        : mocaXml(0, { columns: [{ name: 'result' }], rows: [['12 /a/x.j'], ['ar\n7 /a/y.jar\n']] }),
    );
    const client = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    const out = await osExecFor(client)("echo 'hi'");
    expect(out).toBe('12 /a/x.jar\n7 /a/y.jar\n');
    expect(fake.requests.at(-1)!.query).toBe("execute os command where cmd = 'echo ''hi'''");
  });

  it('throws MocaCommandError on a non-zero status', async () => {
    const fake = fakeMoca((req) => (req.query.startsWith('login user') ? loginOk() : mocaXml(127, {}, 'not found')));
    const client = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    await expect(osExecFor(client)('ver')).rejects.toBeInstanceOf(MocaCommandError);
  });

  it('returns an empty string when the command prints nothing', async () => {
    const fake = fakeMoca((req) => (req.query.startsWith('login user') ? loginOk() : mocaXml(510, {})));
    const client = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    expect(await osExecFor(client)('true')).toBe('');
  });
});
