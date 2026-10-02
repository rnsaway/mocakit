import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { apiDocsManagedDirs, readApiSnapshotFile, resolveApiSettings } from './api-step.js';

const out = resolve('/p', 'src', 'moca.generated.ts');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe('resolveApiSettings', () => {
  it('is off by default and honours the flag', () => {
    expect(resolveApiSettings({}, undefined, '/p', out)).toBeNull();
    expect(resolveApiSettings({ api: true }, false, '/p', out)).toBeNull();
    expect(resolveApiSettings({}, true, '/p', out)).toEqual({
      groups: ['Public APIs'],
      filter: { include: undefined, exclude: undefined, methods: undefined },
      snapshot: resolve('/p', 'src', 'moca.api.json'),
      out: resolve('/p', 'src', 'moca.api.ts'),
      docs: resolve('/p', 'src', 'moca-api'),
    });
  });
  it('reads the object form', () => {
    expect(resolveApiSettings({ api: { groups: ['Public APIs', 'mcs'], methods: ['get'], docs: false, out: 'gen/api.ts' } }, undefined, '/p', out)).toMatchObject({
      groups: ['Public APIs', 'mcs'], filter: { methods: ['get'] }, docs: null, out: resolve('/p', 'gen', 'api.ts'),
    });
  });
  it.each([
    [{ api: 'yes' }, 'config.api must be true, false or an object'],
    [{ api: { groups: 'Public APIs' } }, 'api.groups must be an array of strings'],
    [{ api: { methods: ['head'] } }, 'api.methods may only contain get, post, put, delete, patch'],
  ])('rejects %j', (config, message) => {
    expect(() => resolveApiSettings(config as never, undefined, '/p', out)).toThrow(message);
  });
});

describe('readApiSnapshotFile', () => {
  it('explains a missing snapshot', async () => {
    await expect(readApiSnapshotFile(resolve('/nope/moca.api.json'))).rejects.toThrow(/API is enabled but .*moca\.api\.json does not exist; run generate against a server first, or pass --no-api/);
  });
});

describe('apiDocsManagedDirs', () => {
  it('lists existing and new operations/<tag> folders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mocakit-apidocs-'));
    dirs.push(dir);
    await mkdir(join(dir, 'operations', 'old'), { recursive: true });
    expect(await apiDocsManagedDirs(dir, new Map([['operations/widget/a.md', '']]))).toEqual(['operations/old', 'operations/widget']);
  });
});
