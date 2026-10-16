import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseClasspath, selectEntries } from './classpath.js';
import {
  cachedBytes,
  localPathFor,
  readJavaManifest,
  sameJavaManifest,
  staleFiles,
  writeJavaManifest,
  type JavaManifest,
} from './manifest.js';

const sha = (b: string) => createHash('sha256').update(b).digest('hex');

function entriesFor(cp: string, sep: ':' | ';', les: string, fam: 'posix' | 'windows') {
  return selectEntries(parseClasspath(cp, sep), ['$LESDIR'], les, fam).entries;
}

const LES = '/opt/acme/cust';
const WLES = 'C:\\acme\\cust';

describe('localPathFor', () => {
  const posix = entriesFor(
    '/opt/acme/cust/lib/*:/opt/acme/core/lib/single.jar:/opt/acme/cust/build/classes:/srv/other/lib/*:/srv/cls',
    ':',
    '/opt/acme/cust',
    'posix',
  );
  it('maps a wildcard JAR under its component', () => {
    expect(localPathFor(posix[0], '/opt/acme/cust/lib/widgets.jar', 'posix', LES)).toBe('jars/cust/lib/widgets.jar');
  });
  it('maps a single JAR', () => {
    expect(localPathFor(posix[1], '/opt/acme/core/lib/single.jar', 'posix', LES)).toBe('jars/core/lib/single.jar');
  });
  it('maps a loose class', () => {
    expect(localPathFor(posix[2], '/opt/acme/cust/build/classes/com/acme/cust/Widgets.class', 'posix', LES)).toBe(
      'classes/cust/build/classes/com/acme/cust/Widgets.class',
    );
  });
  it('maps external entries by slug', () => {
    expect(posix[3].component).toBe('external');
    expect(localPathFor(posix[3], '/srv/other/lib/x.jar', 'posix', LES)).toBe(`jars/external/${posix[3].slug}/x.jar`);
    expect(localPathFor(posix[4], '/srv/cls/a/B.class', 'posix', LES)).toBe(`classes/external/${posix[4].slug}/a/B.class`);
  });
  it('gives posix separators for windows inputs', () => {
    const win = entriesFor('C:\\acme\\cust\\lib\\*;C:\\acme\\cust\\build\\classes', ';', 'C:\\acme\\cust', 'windows');
    expect(localPathFor(win[0], 'C:\\acme\\cust\\lib\\widgets.jar', 'windows', WLES)).toBe('jars/cust/lib/widgets.jar');
    expect(localPathFor(win[1], 'C:\\acme\\cust\\build\\classes\\com\\acme\\W.class', 'windows', WLES)).toBe(
      'classes/cust/build/classes/com/acme/W.class',
    );
  });
  it('uses the lesDir to find the component folder when its name repeats in an ancestor', () => {
    const les = '/opt/cust/acme/cust';
    const e = entriesFor('/opt/cust/acme/cust/lib/*', ':', les, 'posix');
    expect(localPathFor(e[0], '/opt/cust/acme/cust/lib/a.jar', 'posix', les)).toBe('jars/cust/lib/a.jar');
  });
  it('handles a windows lesDir with an ancestor of the same name, case-insensitively', () => {
    const les = 'C:\\cust\\acme\\cust';
    const e = entriesFor('C:\\cust\\acme\\cust\\lib\\*', ';', les, 'windows');
    expect(localPathFor(e[0], 'c:\\CUST\\acme\\cust\\lib\\a.jar', 'windows', les)).toBe('jars/cust/lib/a.jar');
  });
  it('throws when the path would escape the folder', () => {
    expect(() => localPathFor(posix[0], '/opt/acme/cust/lib/../../x.jar', 'posix', LES)).toThrow();
    expect(() => localPathFor(posix[4], '/srv/cls/../x.class', 'posix', LES)).toThrow();
  });
  it('throws for an unusable entry', () => {
    const rel = entriesFor('relative/a.jar:/opt/acme/cust/lib/*', ':', '/opt/acme/cust', 'posix');
    expect(rel[0].usable).toBe(false);
    expect(() => localPathFor(rel[0], 'relative/a.jar', 'posix', LES)).toThrow();
  });
});

function manifest(over: Partial<JavaManifest> = {}): JavaManifest {
  return {
    mocakitVersion: '0.6.0',
    generatedAt: '2026-10-16T00:00:00.000Z',
    server: 'acme-dev',
    os: 'posix',
    lesDir: '/opt/acme/cust',
    roots: ['$LESDIR'],
    entries: [
      {
        index: 0,
        path: '/opt/acme/cust/lib',
        type: 'dir-wildcard',
        component: 'cust',
        slug: 'lib',
        selected: true,
        missing: false,
        files: [
          { path: '/opt/acme/cust/lib/a.jar', local: 'jars/cust/lib/a.jar', size: 3, sha256: sha('aaa'), classes: 1, readable: true },
          { path: '/opt/acme/cust/lib/b.jar', local: 'jars/cust/lib/b.jar', size: 3, sha256: sha('bbb'), classes: 1, readable: true },
        ],
      },
    ],
    overridden: [],
    src: ['src/com/acme/cust/Widgets.java'],
    ...over,
  };
}

describe('manifest io', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mocakit-manifest-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round trips as pretty JSON with a trailing newline', async () => {
    const m = manifest();
    await writeJavaManifest(dir, m);
    expect(await readJavaManifest(dir)).toEqual(m);
    const text = await readFile(join(dir, 'manifest.json'), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "entries"');
  });

  it('returns null when missing or corrupt', async () => {
    expect(await readJavaManifest(dir)).toBeNull();
    await writeFile(join(dir, 'manifest.json'), '{nope', 'utf8');
    expect(await readJavaManifest(dir)).toBeNull();
  });

  it('cachedBytes returns bytes only while the stored file still matches', async () => {
    await mkdir(join(dir, 'jars/cust/lib'), { recursive: true });
    await writeFile(join(dir, 'jars/cust/lib/a.jar'), 'aaa');
    const get = cachedBytes(dir, manifest());
    expect(Buffer.from((await get(sha('aaa')))!).toString()).toBe('aaa');
    expect(await get(sha('bbb'))).toBeNull(); // file missing
    expect(await get(sha('zzz'))).toBeNull(); // unknown hash
    await writeFile(join(dir, 'jars/cust/lib/a.jar'), 'edited');
    expect(await get(sha('aaa'))).toBeNull();
    expect(await cachedBytes(dir, null)(sha('aaa'))).toBeNull();
  });

  it('cachedBytes ignores manifest paths that escape the folder', async () => {
    const inner = join(dir, 'moca-java');
    await mkdir(inner);
    await writeFile(join(dir, 'outside.jar'), 'aaa');
    const m = manifest();
    m.entries[0].files[0].local = '../outside.jar';
    expect(await cachedBytes(inner, m)(sha('aaa'))).toBeNull();
  });
});

describe('sameJavaManifest', () => {
  it('ignores generatedAt and mocakitVersion only', () => {
    const a = manifest();
    expect(sameJavaManifest(a, manifest({ generatedAt: 'later', mocakitVersion: '0.6.1' }))).toBe(true);
    expect(sameJavaManifest(a, manifest({ server: 'other' }))).toBe(false);
  });
});

describe('staleFiles', () => {
  it('lists files of removed entries and dropped src files', () => {
    const prev = manifest();
    const next = manifest({ src: [] });
    next.entries[0].files = [next.entries[0].files[0]];
    expect(staleFiles(prev, next)).toEqual(['jars/cust/lib/b.jar', 'src/com/acme/cust/Widgets.java']);
    expect(staleFiles(prev, manifest({ entries: [], src: prev.src }))).toEqual([
      'jars/cust/lib/a.jar',
      'jars/cust/lib/b.jar',
    ]);
    expect(staleFiles(null, next)).toEqual([]);
    expect(staleFiles(prev, prev)).toEqual([]);
  });

  it('never returns paths that are unsafe or outside jars/, classes/ and src/', () => {
    const prev = manifest({
      src: ['../../README.md', '/etc/x', 'C:\\x', 'C:/x', 'docs/other.md', 'jars/../../x.jar', 'src/old/Gone.java'],
      entries: [],
    });
    prev.entries.push({ ...manifest().entries[0], files: [{ ...manifest().entries[0].files[0], local: 'jars/cust/lib/old.jar' }] });
    expect(staleFiles(prev, manifest({ entries: [], src: [] }))).toEqual(['jars/cust/lib/old.jar', 'src/old/Gone.java']);
  });
});
