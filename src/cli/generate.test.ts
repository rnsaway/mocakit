import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeMoca, loginOk, mocaXml } from '../../test/helpers/fake-moca.js';
import { runGenerate } from './generate.js';

const fixture = fileURLToPath(new URL('../../test/fixtures/snapshot.json', import.meta.url));

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) } };
}

const tempDirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'mocakit-gen-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runGenerate', () => {
  it('generates from a snapshot without a config or server, applying CLI --out', async () => {
    const dir = await tempDir();
    const { io: cliIo, out, err } = io();
    await runGenerate({ fromSnapshot: fixture, out: 'gen/moca.ts', dryRun: false, cwd: dir, env: {}, io: cliIo });
    const code = await readFile(join(dir, 'gen/moca.ts'), 'utf8');
    expect(code).toContain('export class Moca extends mk.MocaClient');
    expect(out.at(-1)).toBe(`Wrote 5 commands to ${join(dir, 'gen/moca.ts')}`);
    expect(err).toEqual(['warning: Commands "list orders", "list-orders" map to the same method name; generated listOrders, listOrders_2']);
  });

  it('introspects a server, writes the snapshot next to out, and applies config filters', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'mocakit.config.json'),
      JSON.stringify({ url: 'https://moca.test/service', out: 'src/moca.generated.ts', exclude: ['create *'] }),
    );
    const fake = fakeMoca((r) => {
      if (r.query.startsWith('login user')) return loginOk();
      if (r.query === 'list active commands') {
        return mocaXml(0, { columns: [{ name: 'command' }], rows: [['list orders'], ['create inventory']] });
      }
      if (r.query === 'list active command arguments') {
        return mocaXml(0, { columns: [{ name: 'command' }, { name: 'argnam' }, { name: 'dtype' }, { name: 'argreq' }], rows: [['list orders', 'wh_id', 'S', '1']] });
      }
      return mocaXml(0);
    });
    const { io: cliIo } = io();
    await runGenerate({
      dryRun: false,
      cwd: dir,
      env: { MOCA_USER: 'u', MOCA_PASSWORD: 'p' },
      io: cliIo,
      deps: { transport: fake.transport },
    });
    const snapshot = JSON.parse(await readFile(join(dir, 'src/moca.commands.json'), 'utf8'));
    expect(snapshot.commands.map((c: { name: string }) => c.name)).toEqual(['create inventory', 'list orders']);
    const code = await readFile(join(dir, 'src/moca.generated.ts'), 'utf8');
    expect(code).toContain('listOrders');
    expect(code).not.toContain('createInventory');
    expect(fake.requests.at(-1)?.query).toBe('logout user');
  });

  it('writes nothing on --dry-run', async () => {
    const dir = await tempDir();
    const { io: cliIo, out } = io();
    await runGenerate({ fromSnapshot: fixture, out: 'gen/moca.ts', dryRun: true, cwd: dir, env: {}, io: cliIo });
    await expect(readFile(join(dir, 'gen/moca.ts'), 'utf8')).rejects.toThrow();
    expect(out.at(-1)).toMatch(/^Would write 5 commands/);
  });

  it('resolves a config-relative out against the config file directory, not the cwd', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'cfgdir'), { recursive: true });
    await writeFile(join(dir, 'cfgdir', 'mocakit.config.json'), JSON.stringify({ out: 'gen/moca.ts' }));
    const { io: cliIo } = io();
    await runGenerate({
      configPath: 'cfgdir/mocakit.config.json',
      fromSnapshot: fixture,
      dryRun: false,
      cwd: dir,
      env: {},
      io: cliIo,
    });
    const code = await readFile(join(dir, 'cfgdir', 'gen', 'moca.ts'), 'utf8');
    expect(code).toContain('export class Moca extends mk.MocaClient');
  });

  it('resolves --out and --from-snapshot against the cwd even with a config elsewhere', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'cfgdir'), { recursive: true });
    await writeFile(join(dir, 'cfgdir', 'mocakit.config.json'), JSON.stringify({ out: 'gen/should-not-be-used.ts' }));
    const { io: cliIo } = io();
    await runGenerate({
      configPath: 'cfgdir/mocakit.config.json',
      fromSnapshot: fixture,
      out: 'flag-out/moca.ts',
      dryRun: false,
      cwd: dir,
      env: {},
      io: cliIo,
    });
    const code = await readFile(join(dir, 'flag-out', 'moca.ts'), 'utf8');
    expect(code).toContain('export class Moca extends mk.MocaClient');
    await expect(readFile(join(dir, 'cfgdir', 'gen', 'should-not-be-used.ts'), 'utf8')).rejects.toThrow();
  });

  it('proceeds without a config file when the full connection is in env', async () => {
    const dir = await tempDir();
    const fake = fakeMoca((r) => {
      if (r.query.startsWith('login user')) return loginOk();
      if (r.query === 'list active commands') return mocaXml(0, { columns: [{ name: 'command' }], rows: [['list orders']] });
      return mocaXml(0);
    });
    const { io: cliIo, out } = io();
    await runGenerate({
      dryRun: false,
      cwd: dir,
      env: { MOCA_URL: 'https://moca.test/service', MOCA_USER: 'u', MOCA_PASSWORD: 'p' },
      io: cliIo,
      deps: { transport: fake.transport },
    });
    expect(out.at(-1)).toMatch(/^Wrote 1 commands/);
  });

  it('reports the No mocakit config error, mentioning env vars, when neither a config nor a full env is present', async () => {
    const dir = await tempDir();
    const { io: cliIo } = io();
    await expect(runGenerate({ dryRun: false, cwd: dir, env: {}, io: cliIo })).rejects.toThrow(
      /No mocakit config found.*MOCA_URL, MOCA_USER and MOCA_PASSWORD/s,
    );
  });

  it('wraps a missing --from-snapshot file as "Cannot read snapshot"', async () => {
    const dir = await tempDir();
    const missing = join(dir, 'nope.json');
    const { io: cliIo } = io();
    await expect(runGenerate({ fromSnapshot: missing, out: 'gen/moca.ts', dryRun: false, cwd: dir, env: {}, io: cliIo })).rejects.toThrow(
      `Cannot read snapshot ${missing}: ENOENT`,
    );
  });

  it('does not double the path when the underlying snapshot error already includes it', async () => {
    const dir = await tempDir();
    const badSnapshot = join(dir, 'bad-snapshot.json');
    await writeFile(badSnapshot, 'not json');
    const { io: cliIo } = io();
    let caught: unknown;
    try {
      await runGenerate({ fromSnapshot: badSnapshot, out: 'gen/moca.ts', dryRun: false, cwd: dir, env: {}, io: cliIo });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toBe(`${badSnapshot} is not valid JSON: Unexpected token 'o', "not json" is not valid JSON`);
    expect(message.match(new RegExp(badSnapshot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  it('wraps an unwritable output path as "Cannot write", failing before introspecting the server', async () => {
    const dir = await tempDir();
    // Create a plain file where a directory component of `out` needs to be, so mkdir(recursive) fails.
    await writeFile(join(dir, 'blocked'), 'not a directory');
    const fake = fakeMoca(() => {
      throw new Error('should not be called');
    });
    const { io: cliIo } = io();
    await expect(
      runGenerate({
        out: 'blocked/sub/moca.ts',
        dryRun: false,
        cwd: dir,
        env: { MOCA_URL: 'https://moca.test/service', MOCA_USER: 'u', MOCA_PASSWORD: 'p' },
        io: cliIo,
        deps: { transport: fake.transport },
      }),
    ).rejects.toThrow(/^Cannot write .*blocked.sub.moca\.ts: /);
    expect(fake.requests).toEqual([]);
  });
});
