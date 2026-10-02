// src/codegen/emit-api-docs.test.ts
import { describe, expect, it } from 'vitest';
import type { ApiSnapshot } from './api-snapshot.js';
import { DOC_MARKER, PRIVATE_NOTICE } from './docs-writer.js';
import { apiDocFile, emitApiDocs } from './emit-api-docs.js';

const snapshot: ApiSnapshot = {
  mocakitVersion: '0.5.0', generatedAt: 'x', server: 'https://u:p@moca.test/service',
  groups: [{ name: 'Public APIs', basePath: '/api', private: false }, { name: 'gizmo', basePath: '', private: true }],
  operations: [
    {
      group: 'Public APIs', tag: 'widget (v1)', tagKey: 'widget', method: 'get', path: '/widget/v1/widgets', fullPath: '/api/widget/v1/widgets',
      name: 'getWidgets', description: 'Lists widgets. Second | sentence.', permissions: ['VIEW_WIDGET'],
      parameters: [{ in: 'query', name: 'status', required: false, schema: { kind: 'string', enum: ['A', 'X'] }, description: 'Status' }],
      response: { envelope: 'data', schema: { kind: 'ref', name: 'W' } },
    },
    {
      group: 'Public APIs', tag: 'widget (v1)', tagKey: 'widget', method: 'post', path: '/widget/v1/widgetMove', fullPath: '/api/widget/v1/widgetMove',
      name: 'postWidgetMove', permissions: [], parameters: [],
      body: { required: true, schema: { kind: 'object', properties: { wh_id: { kind: 'string', description: 'Warehouse' }, loc: { kind: 'object', properties: { stoloc: { kind: 'string' } }, required: [] } }, required: ['wh_id'] } },
    },
    { group: 'gizmo', tag: 'gizmo-controller', tagKey: 'gizmo', method: 'get', path: '/gizmos', fullPath: '/gizmos', name: 'getGizmos', permissions: [], parameters: [] },
  ],
  definitions: { W: { kind: 'object', properties: { widget_id: { kind: 'string', description: 'Id' }, qty: { kind: 'number', integer: true } }, required: ['widget_id'] } },
};

describe('emitApiDocs', () => {
  const { files, warnings } = emitApiDocs(snapshot, { version: '0.5.0' });

  it('writes README, INDEX and one page per operation with marker and notice', () => {
    expect([...files.keys()]).toEqual(['README.md', 'INDEX.md', 'operations/gizmo/getGizmos.md', 'operations/widget/getWidgets.md', 'operations/widget/postWidgetMove.md']);
    for (const c of files.values()) expect(c.startsWith(DOC_MARKER)).toBe(true);
    for (const f of ['README.md', 'INDEX.md']) expect(files.get(f)!.split('\n')[1]).toBe(PRIVATE_NOTICE);
    expect(files.get('README.md')).toContain('change data immediately');
    expect(files.get('README.md')).not.toContain('u:p@');
    expect(warnings).toEqual([]);
    expect(apiDocFile(snapshot.operations[0]!)).toBe('operations/widget/getWidgets.md');
  });

  it('indexes by tag with method, path, permissions and first sentence; marks private groups', () => {
    const index = files.get('INDEX.md')!;
    expect(index).toContain('## widget');
    expect(index).toContain('- [`getWidgets`](operations/widget/getWidgets.md) · GET /widget/v1/widgets · VIEW_WIDGET · Lists widgets.');
    expect(index).toContain('## gizmo (internal group "gizmo")');
  });

  it('renders parameters, body and response field tables and an example', () => {
    const get = files.get('operations/widget/getWidgets.md')!;
    expect(get).toContain('# widget.getWidgets');
    expect(get).toContain('`GET /api/widget/v1/widgets`');
    expect(get).toContain('Permissions: `VIEW_WIDGET`');
    expect(get).toContain('| query | status | string (A, X) | no | Status |');
    expect(get).toContain('| widget_id | string | yes | Id |');
    expect(get).toContain('| qty | integer | no |  |');
    expect(get).toContain("await moca.api.widget.getWidgets({ query: { /* … */ } });");
    const post = files.get('operations/widget/postWidgetMove.md')!;
    expect(post).toContain('| wh_id | string | yes | Warehouse |');
    expect(post).toContain('| loc.stoloc | string | no |  |');
    expect(post).toContain('Writes change data immediately');
  });

  it('keeps backticks, pipes and newlines in descriptions on one line without breaking tables', () => {
    const op = { ...snapshot.operations[0]!, description: 'Uses `code` | pipes.\nSecond line.' };
    const prop = { kind: 'string' as const, description: 'a | b `c`' };
    const out = emitApiDocs({ ...snapshot, operations: [op], definitions: { W: { kind: 'object', properties: { f: prop }, required: [] } } }, { version: '0.5.0' }).files;
    const page = out.get('operations/widget/getWidgets.md')!;
    expect(page).toContain('Uses \\`code\\` | pipes. Second line.');
    expect(page).toContain('| f | string | no | a \\| b \\`c\\` |');
    expect(out.get('INDEX.md')).toContain('Uses \\`code\\` \\| pipes.');
  });
});
