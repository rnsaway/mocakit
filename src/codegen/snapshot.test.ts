import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSnapshot, writeSnapshot, type Snapshot } from './snapshot.js';

describe('snapshot IO', () => {
  it('round-trips through JSON with a trailing newline', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'mocakit-')), 'nested', 'moca.commands.json');
    const snapshot: Snapshot = {
      mocakitVersion: '0.1.0',
      generatedAt: '2026-09-22T00:00:00.000Z',
      server: 'https://m/service',
      commands: [{ name: 'list orders', args: [{ name: 'wh_id', dtype: 'S', required: true }] }],
    };
    await writeSnapshot(path, snapshot);
    expect((await readFile(path, 'utf8')).endsWith('}\n')).toBe(true);
    expect(await readSnapshot(path)).toEqual(snapshot);
  });

  it('rejects a file that is not a snapshot', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'mocakit-')), 'bad.json');
    await writeSnapshot(path, { nope: true } as never);
    await expect(readSnapshot(path)).rejects.toThrow(/not a mocakit snapshot/);
  });
});
