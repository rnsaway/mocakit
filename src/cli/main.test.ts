import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

  it('returns 1 and reports errors without a stack trace', async () => {
    const { io, err } = capture();
    const dir = await tempDir();
    expect(await runCli(['generate'], io, dir)).toBe(1);
    expect(err.at(-1)).toMatch(/^mocakit: No mocakit config found/);
  });
});
