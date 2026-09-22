import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, resolveConnection } from './load-config.js';

const tempDir = () => mkdtemp(join(tmpdir(), 'mocakit-cfg-'));

describe('loadConfig', () => {
  it('finds mocakit.config.ts in cwd and loads its default export', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'mocakit.config.ts'), `export default { out: 'gen/moca.ts' as string, include: ['list *'] };\n`);
    const loaded = await loadConfig(undefined, dir);
    expect(loaded?.config).toEqual({ out: 'gen/moca.ts', include: ['list *'] });
    expect(loaded?.path).toBe(join(dir, 'mocakit.config.ts'));
  });

  it('loads JSON from an explicit path', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'custom.json'), JSON.stringify({ out: 'x.ts' }));
    expect((await loadConfig('custom.json', dir))?.config).toEqual({ out: 'x.ts' });
  });

  it('returns null when optional and nothing is found, and throws otherwise', async () => {
    const dir = await tempDir();
    expect(await loadConfig(undefined, dir, { optional: true })).toBeNull();
    await expect(loadConfig(undefined, dir)).rejects.toThrow(/No mocakit config found/);
  });
});

describe('resolveConnection', () => {
  it('prefers config values and falls back to env', () => {
    expect(
      resolveConnection({ url: 'https://c', ignoreSslIssues: true }, { MOCA_USER: 'u', MOCA_PASSWORD: 'p', MOCA_URL: 'https://e' }),
    ).toEqual({ url: 'https://c', username: 'u', password: 'p', ignoreSslIssues: true });
  });

  it('lists every missing setting', () => {
    expect(() => resolveConnection({}, {})).toThrow(/url \(MOCA_URL\), username \(MOCA_USER\), password \(MOCA_PASSWORD\)/);
  });
});
