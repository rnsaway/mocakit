import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resolveConnection } from './load-config.js';

const tempDirs: string[] = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mocakit-cfg-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

  it('mentions the env-var fallback when no config is found and none is optional', async () => {
    const dir = await tempDir();
    await expect(loadConfig(undefined, dir)).rejects.toThrow(/MOCA_URL, MOCA_USER and MOCA_PASSWORD/);
  });

  it('does not write a .ts config (or its secrets) anywhere under the OS temp dir', async () => {
    const dir = await tempDir();
    // A unique marker per test run: any leaked copy of it under the OS temp dir (jiti's
    // fs cache, or its ESM-native-import tempfile workaround) proves the leak, regardless of
    // what other tests or processes are doing concurrently with that shared directory.
    const marker = `hunter2SECRET-${Math.random().toString(36).slice(2)}`;
    await writeFile(join(dir, 'mocakit.config.ts'), `export default { password: '${marker}' as string };\n`);
    const loaded = await loadConfig(undefined, dir);
    expect((loaded?.config as { password?: string }).password).toBe(marker);

    const jitiTmpDir = join(tmpdir(), 'jiti');
    let leaked = false;
    try {
      for (const entry of await readdir(jitiTmpDir)) {
        const content = await readFile(join(jitiTmpDir, entry), 'utf8').catch(() => '');
        if (content.includes(marker)) leaked = true;
      }
    } catch {
      // No jiti tmp dir at all is also fine -- nothing to check.
    }
    expect(leaked).toBe(false);
  });

  it('strips a leading BOM from JSON config and reports invalid JSON without leaking its content', async () => {
    const dir = await tempDir();
    const path = join(dir, 'bom.json');
    await writeFile(path, `﻿${JSON.stringify({ out: 'x.ts' })}`);
    expect((await loadConfig('bom.json', dir))?.config).toEqual({ out: 'x.ts' });

    const badPath = join(dir, 'bad.json');
    await writeFile(badPath, '{"password": hunter2SECRET}');
    let caught: unknown;
    try {
      await loadConfig('bad.json', dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toBe(`${badPath} is not valid JSON`);
    expect(message).not.toContain('hunter2');
    expect((caught as Error).cause).toBeUndefined();
  });

  it('rejects a non-object JSON config', async () => {
    const dir = await tempDir();
    const path = join(dir, 'null.json');
    await writeFile(path, 'null');
    await expect(loadConfig('null.json', dir)).rejects.toThrow(`${path} must export a config object`);
  });

  it('rejects a non-object .ts config', async () => {
    const dir = await tempDir();
    const path = join(dir, 'mocakit.config.ts');
    await writeFile(path, 'export default 42;\n');
    await expect(loadConfig(undefined, dir)).rejects.toThrow(`${path} must export a config object`);
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

  it.each(['1', 'yes', 'true', 'YES', 'TRUE', '1'])('treats MOCA_IGNORE_SSL=%s as true', (value) => {
    expect(
      resolveConnection({ url: 'https://c', username: 'u', password: 'p' }, { MOCA_IGNORE_SSL: value }).ignoreSslIssues,
    ).toBe(true);
  });

  it('treats other MOCA_IGNORE_SSL values as unset', () => {
    expect(
      resolveConnection({ url: 'https://c', username: 'u', password: 'p' }, { MOCA_IGNORE_SSL: 'nope' }).ignoreSslIssues,
    ).toBeUndefined();
  });
});
