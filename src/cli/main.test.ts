import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
