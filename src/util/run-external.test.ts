import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canStart, runExternal, substitute } from './run-external.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'fake-decompiler.mjs');

describe('runExternal', () => {
  it('returns stdout bytes, exit code and a capped stderr', async () => {
    const r = await runExternal(process.execPath, [FAKE], { timeoutMs: 10_000, env: { FAKE_DECOMPILER_MODE: 'stdout' } });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
    expect([...r.stdout]).toEqual([1, 2, 3, 250]);
    expect(r.stderr.length).toBeLessThanOrEqual(4096);
    expect(r.stderr.startsWith('xxx')).toBe(true);
  });

  it('is ok on exit code 0', async () => {
    const r = await runExternal(process.execPath, [FAKE], { timeoutMs: 10_000, env: { FAKE_DECOMPILER_MODE: 'empty' } });
    expect(r).toMatchObject({ ok: true, code: 0, timedOut: false });
  });

  it('kills a hanging process at the timeout and resolves promptly', async () => {
    const started = Date.now();
    const r = await runExternal(process.execPath, [FAKE], { timeoutMs: 200, env: { FAKE_DECOMPILER_MODE: 'hang' } });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('fails when stdout exceeds 64 MiB', async () => {
    const r = await runExternal(process.execPath, [FAKE], { timeoutMs: 30_000, env: { FAKE_DECOMPILER_MODE: 'bigout' } });
    expect(r.ok).toBe(false);
    expect(r.stdout.length).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it('reports a spawn failure as not ok', async () => {
    const r = await runExternal('mocakit-no-such-command-xyz', [], { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
    expect(r.startFailed).toBe(true);
  });
});

describe('canStart', () => {
  it('is true for a real command and false for a missing one', async () => {
    expect(await canStart(process.execPath)).toBe(true);
    expect(await canStart('mocakit-no-such-command-xyz')).toBe(false);
  });
});

describe('substitute', () => {
  it('replaces {input} and {output} and leaves other args alone', () => {
    expect(
      substitute(['-jar', 'x.jar', '{input}', '--out={output}', '--flag'], { input: '/in/a.jar', output: '/out' }),
    ).toEqual(['-jar', 'x.jar', '/in/a.jar', '--out=/out', '--flag']);
  });
});
