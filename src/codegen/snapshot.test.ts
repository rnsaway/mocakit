import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSnapshot, writeSnapshot, type Snapshot } from './snapshot.js';

const tempDirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'mocakit-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('snapshot IO', () => {
  it('round-trips through JSON with a trailing newline', async () => {
    const path = join(await tempDir(), 'nested', 'moca.commands.json');
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
    const path = join(await tempDir(), 'bad.json');
    await writeSnapshot(path, { nope: true } as never);
    await expect(readSnapshot(path)).rejects.toThrow(/not a mocakit snapshot/);
  });

  it('loads a file with a leading BOM', async () => {
    const path = join(await tempDir(), 'bom.json');
    const snapshot: Snapshot = {
      mocakitVersion: '0.1.0',
      generatedAt: '2026-09-22T00:00:00.000Z',
      server: 'https://m/service',
      commands: [],
    };
    const BOM = '\uFEFF';
    await writeFile(path, `${BOM}${JSON.stringify(snapshot)}`, 'utf8');
    expect(await readSnapshot(path)).toEqual(snapshot);
  });

  it('rejects a file that is JSON null', async () => {
    const path = join(await tempDir(), 'null.json');
    await writeFile(path, 'null', 'utf8');
    await expect(readSnapshot(path)).rejects.toThrow(/not a mocakit snapshot/);
  });

  it('rejects invalid JSON with a JSON-specific message', async () => {
    const path = join(await tempDir(), 'invalid.json');
    await writeFile(path, '{ not json', 'utf8');
    await expect(readSnapshot(path)).rejects.toThrow(/is not valid JSON/);
  });

  it('rejects a command with no args, naming the offending command', async () => {
    const path = join(await tempDir(), 'noargs.json');
    await writeFile(
      path,
      JSON.stringify({
        mocakitVersion: '0.1.0',
        generatedAt: '2026-09-22T00:00:00.000Z',
        server: 'https://m/service',
        commands: [{ name: 'list orders' }],
      }),
      'utf8',
    );
    await expect(readSnapshot(path)).rejects.toThrow(/not a mocakit snapshot.*list orders/);
  });

  it('rejects a command with a non-string level, naming the offending command', async () => {
    const path = join(await tempDir(), 'badlevel.json');
    await writeFile(
      path,
      JSON.stringify({
        mocakitVersion: '0.1.0',
        generatedAt: '2026-09-22T00:00:00.000Z',
        server: 'https://m/service',
        commands: [{ name: 'list orders', level: 5, args: [] }],
      }),
      'utf8',
    );
    await expect(readSnapshot(path)).rejects.toThrow(/not a mocakit snapshot.*list orders/);
  });
});
