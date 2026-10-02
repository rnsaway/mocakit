import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readApiSnapshot, sameApi, writeApiSnapshot, type ApiSnapshot } from './api-snapshot.js';

const snapshot: ApiSnapshot = {
  mocakitVersion: '0.5.0',
  generatedAt: '2026-10-01T00:00:00.000Z',
  server: 'https://moca.test/service',
  groups: [{ name: 'Public APIs', basePath: '/api', private: false }],
  operations: [
    {
      group: 'Public APIs', tag: 'widget (v1)', tagKey: 'widget', method: 'get', path: '/widget/v1/widgets', fullPath: '/api/widget/v1/widgets',
      name: 'getWidgets', description: 'Lists widgets', permissions: ['VIEW_WIDGET'],
      parameters: [{ in: 'query', name: 'wh_id', required: true, schema: { kind: 'string' } }],
      response: { envelope: 'data', schema: { kind: 'ref', name: 'widget.v1.Widget' } },
    },
  ],
  definitions: { 'widget.v1.Widget': { kind: 'object', properties: { widget_id: { kind: 'string', description: 'Id' } }, required: ['widget_id'] } },
};

const dirs: string[] = [];
const temp = async () => { const d = await mkdtemp(join(tmpdir(), 'mocakit-api-')); dirs.push(d); return d; };
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

describe('api snapshot', () => {
  it('round-trips through disk', async () => {
    const path = join(await temp(), 'nested/moca.api.json');
    await writeApiSnapshot(path, snapshot);
    expect(await readApiSnapshot(path)).toEqual(snapshot);
  });

  it.each([
    ['not JSON', '{', /is not valid JSON/],
    ['missing operations', JSON.stringify({ ...snapshot, operations: undefined }), /is not a mocakit API snapshot/],
    ['bad method', JSON.stringify({ ...snapshot, operations: [{ ...snapshot.operations[0], method: 'head' }] }), /operation "getWidgets"/],
    ['bad schema kind', JSON.stringify({ ...snapshot, definitions: { X: { kind: 'map' } } }), /definition "X"/],
  ])('rejects %s', async (_l, content, message) => {
    const path = join(await temp(), 'a.json');
    await writeFile(path, content);
    await expect(readApiSnapshot(path)).rejects.toThrow(message);
  });

  it('compares groups, operations and definitions only', () => {
    expect(sameApi(snapshot, { ...snapshot, generatedAt: 'later', mocakitVersion: '9' })).toBe(true);
    expect(sameApi(snapshot, { ...snapshot, operations: [] })).toBe(false);
    expect(sameApi(snapshot, { ...snapshot, definitions: {} })).toBe(false);
  });
});
