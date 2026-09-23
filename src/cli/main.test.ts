import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMoca, loginOk, mocaXml } from '../../test/helpers/fake-moca.js';
import { runCli } from './main.js';

const fixture = fileURLToPath(new URL('../../test/fixtures/snapshot.json', import.meta.url));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) } };
}

const tempDirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'mocakit-cli-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runCli', () => {
  it('prints usage and returns 1 for unknown commands', async () => {
    const { io, err } = capture();
    expect(await runCli(['frobnicate'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/Usage: mocakit generate/);
  });

  it('prints usage and returns 0 for --help', async () => {
    const { io, out } = capture();
    expect(await runCli(['--help'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Usage: mocakit generate/);
  });

  it('prints usage and returns 0 for generate --help', async () => {
    const { io, out } = capture();
    expect(await runCli(['generate', '--help'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Usage: mocakit generate/);
  });

  it('prints usage and returns 0 for generate -h', async () => {
    const { io, out } = capture();
    expect(await runCli(['generate', '-h'], io)).toBe(0);
    expect(out.join('\n')).toMatch(/Usage: mocakit generate/);
  });

  it('rejects unknown flags', async () => {
    const { io } = capture();
    expect(await runCli(['generate', '--nope'], io)).toBe(1);
  });

  it('runs generate with flags', async () => {
    const dir = await tempDir();
    const { io } = capture();
    const out = join(dir, 'moca.ts');
    expect(await runCli(['generate', '--from-snapshot', fixture, '--out', out], io, dir)).toBe(0);
    expect(await readFile(out, 'utf8')).toContain('createMoca');
  });

  it('documents --verbose in the usage text', async () => {
    const { io, out } = capture();
    await runCli(['--help'], io);
    expect(out.join('\n')).toMatch(/--verbose\s+Print every warning/);
  });

  it('passes --verbose through, printing every warning', async () => {
    const dir = await tempDir();
    const commands = Array.from({ length: 51 }, (_, i) => ({
      name: `cmd ${String(i).padStart(2, '0')}`,
      args: [{ name: 'bad-name', dtype: 'STRING', required: false }],
    }));
    const snapshotFile = join(dir, 'snap.json');
    await writeFile(snapshotFile, JSON.stringify({ mocakitVersion: '0.1.0', generatedAt: '', server: 'https://moca.test', commands }));

    const quiet = capture();
    expect(await runCli(['generate', '--from-snapshot', snapshotFile, '--dry-run'], quiet.io, dir)).toBe(0);
    expect(quiet.err.at(-1)).toBe('... and 1 more warnings (use --verbose to see all)');

    const verbose = capture();
    expect(await runCli(['generate', '--from-snapshot', snapshotFile, '--dry-run', '--verbose'], verbose.io, dir)).toBe(0);
    expect(verbose.err).toHaveLength(51);
  });

  it('returns 1 and reports errors without a stack trace', async () => {
    const { io, err } = capture();
    const dir = await tempDir();
    expect(await runCli(['generate'], io, dir)).toBe(1);
    expect(err.at(-1)).toMatch(/^mocakit: No mocakit config found/);
  });
});

describe('runCli .env loading', () => {
  const MOCA_VARS = ['MOCA_URL', 'MOCA_USER', 'MOCA_PASSWORD', 'MOCA_IGNORE_SSL'] as const;
  // Invented values only; the password is distinctive so a leak is easy to spot.
  const PASSWORD = 'pw-Zq8-never-print-me';
  const DOTENV = `MOCA_URL=https://file.moca.test/service\nMOCA_USER=fileuser\nMOCA_PASSWORD=${PASSWORD}\n`;

  beforeEach(() => {
    // Make the tests independent of whatever the developer's shell exports.
    for (const name of MOCA_VARS) vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function fakeServer() {
    return fakeMoca((r) => {
      if (r.query.startsWith('login user')) return loginOk();
      if (r.query === 'list active commands') return mocaXml(0, { columns: [{ name: 'command' }], rows: [['list orders']] });
      if (r.query === 'list active command arguments') {
        return mocaXml(0, { columns: [{ name: 'command' }, { name: 'argnam' }, { name: 'dtype' }, { name: 'argreq' }], rows: [] });
      }
      return mocaXml(0);
    });
  }

  it('loads .env from the cwd automatically and uses its credentials', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '.env'), DOTENV);
    const fake = fakeServer();
    const { io, out, err } = capture();
    expect(await runCli(['generate', '--out', 'moca.ts'], io, dir, { deps: { transport: fake.transport } })).toBe(0);
    expect(out[0]).toBe(`Loaded 3 variables from ${join(dir, '.env')}`);
    expect(out.at(-1)).toBe(`Wrote 1 commands to ${join(dir, 'moca.ts')}`);
    expect(fake.requests[0]?.url).toMatch(/^https:\/\/file\.moca\.test\/service/);
    expect(fake.requests[0]?.query).toContain("usr_id = 'fileuser'");
    expect([...out, ...err].join('\n')).not.toContain(PASSWORD);
    // The file's values are not left behind in process.env.
    expect(process.env.MOCA_PASSWORD).toBeUndefined();
  });

  it('lets the real environment override values from the file', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '.env'), DOTENV);
    vi.stubEnv('MOCA_URL', 'https://real.moca.test/service');
    vi.stubEnv('MOCA_USER', 'realuser');
    const fake = fakeServer();
    const { io } = capture();
    expect(await runCli(['generate', '--out', 'moca.ts'], io, dir, { deps: { transport: fake.transport } })).toBe(0);
    expect(fake.requests[0]?.url).toMatch(/^https:\/\/real\.moca\.test\/service/);
    expect(fake.requests[0]?.query).toContain("usr_id = 'realuser'");
    expect(process.env.MOCA_USER).toBe('realuser');
  });

  it('carries on silently when there is no .env', async () => {
    const dir = await tempDir();
    const { io, out, err } = capture();
    expect(await runCli(['generate', '--from-snapshot', fixture, '--out', 'moca.ts'], io, dir)).toBe(0);
    expect(out.join('\n')).not.toMatch(/Loaded|env file/);
    expect(err.join('\n')).not.toMatch(/env file/);
  });

  it('skips the automatic .env with --no-env-file', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '.env'), DOTENV);
    const fake = fakeServer();
    const { io, out, err } = capture();
    expect(await runCli(['generate', '--no-env-file'], io, dir, { deps: { transport: fake.transport } })).toBe(1);
    expect(out.join('\n')).not.toMatch(/Loaded/);
    expect(err.at(-1)).toMatch(/^mocakit: No mocakit config found/);
    expect(fake.requests).toHaveLength(0);
  });

  it('loads an explicit --env-file resolved against the cwd instead of .env', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'moca.local.env'), DOTENV);
    await writeFile(join(dir, '.env'), 'MOCA_USER=should-not-be-used\n');
    const fake = fakeServer();
    const { io, out } = capture();
    expect(
      await runCli(['generate', '--env-file', 'moca.local.env', '--out', 'moca.ts'], io, dir, { deps: { transport: fake.transport } }),
    ).toBe(0);
    expect(out[0]).toBe(`Loaded 3 variables from ${join(dir, 'moca.local.env')}`);
    expect(fake.requests[0]?.query).toContain("usr_id = 'fileuser'");
  });

  it('fails when an explicit --env-file does not exist', async () => {
    const dir = await tempDir();
    const { io, err } = capture();
    expect(await runCli(['generate', '--env-file', 'missing.env', '--from-snapshot', fixture], io, dir)).toBe(1);
    expect(err.at(-1)).toBe(`mocakit: Cannot read env file ${join(dir, 'missing.env')}: ENOENT`);
  });

  it('rejects --env-file combined with --no-env-file', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'x.env'), DOTENV);
    const { io, err } = capture();
    expect(await runCli(['generate', '--env-file', 'x.env', '--no-env-file', '--from-snapshot', fixture], io, dir)).toBe(1);
    expect(err[0]).toBe('mocakit: --env-file and --no-env-file cannot be used together');
  });

  it('makes .env values visible to a .ts config that reads process.env, only during the run', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, '.env'), 'MOCA_URL=https://from-dotenv.moca.test\n');
    await writeFile(
      join(dir, 'mocakit.config.ts'),
      "export default { out: process.env.MOCA_URL === 'https://from-dotenv.moca.test' ? 'seen.ts' : 'unseen.ts' };\n",
    );
    const { io } = capture();
    expect(await runCli(['generate', '--from-snapshot', fixture], io, dir)).toBe(0);
    expect(await readFile(join(dir, 'seen.ts'), 'utf8')).toContain('createMoca');
    expect(process.env.MOCA_URL).toBeUndefined();
  });

  it('prints variable names (never values) with --verbose, and never echoes file content', async () => {
    const dir = await tempDir();
    // A line parseEnv can't make sense of, containing a secret, must not be echoed either.
    await writeFile(join(dir, '.env'), `${DOTENV}this line is garbage ${PASSWORD}-garbage\n`);
    const fake = fakeServer();
    const { io, out, err } = capture();
    expect(await runCli(['generate', '--out', 'moca.ts', '--verbose'], io, dir, { deps: { transport: fake.transport } })).toBe(0);
    expect(out[0]).toBe(`Loaded 3 variables from ${join(dir, '.env')}: MOCA_PASSWORD, MOCA_URL, MOCA_USER`);
    const all = [...out, ...err].join('\n');
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain('fileuser');
    expect(all).not.toContain('garbage');
  });

  it('reports an unreadable env file by error code only', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.env')); // a directory, so reading it fails (EISDIR)
    const { io, err } = capture();
    expect(await runCli(['generate', '--from-snapshot', fixture], io, dir)).toBe(1);
    expect(err.at(-1)).toMatch(/^mocakit: Cannot read env file .*\.env: E[A-Z]+$/);
  });

  it('documents the env-file flags in the usage text', async () => {
    const { io, out } = capture();
    await runCli(['--help'], io);
    expect(out.join('\n')).toMatch(/--env-file <path>/);
    expect(out.join('\n')).toMatch(/--no-env-file/);
  });
});
