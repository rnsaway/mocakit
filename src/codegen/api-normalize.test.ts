import { describe, expect, it } from 'vitest';
import { assignOperationNames, convertSchema, identifierFrom, normalizeSwagger, operationName, reachableDefinitions, tagKeys } from './api-normalize.js';

describe('identifiers and names', () => {
  it.each([
    ['API Platform', 'apiPlatform'],
    ['inventory', 'inventory'],
    ['wcs-integration', 'wcsIntegration'],
    ['2fa', '_2fa'],
  ])('identifierFrom(%j) = %j', (input, expected) => expect(identifierFrom(input)).toBe(expected));

  it('derives tag keys and version-suffixes collisions', () => {
    expect([...tagKeys(['widget (v1)', 'API Platform', 'gizmo (v1)', 'gizmo (v2)'])]).toEqual([
      ['widget (v1)', 'widget'],
      ['API Platform', 'apiPlatform'],
      ['gizmo (v1)', 'gizmoV1'],
      ['gizmo (v2)', 'gizmoV2'],
    ]);
  });

  it.each([
    ['get', '/widget/v1/widgets', 'getWidgets'],
    ['post', '/widget/v1/widgetMove', 'postWidgetMove'],
    ['get', '/widget/v1/widgets/{widget_id}', 'getWidgetsByWidgetId'],
    ['delete', '/widget/v1/widgets/{wh_id}/{widget_id}/notes', 'deleteWidgetsByWhIdByWidgetIdNotes'],
    ['get', '/widget/v1', 'getWidget'],
    ['put', '/widget/v1/re-index.all', 'putReIndexAll'],
    ['get', '/batch', 'getBatch'],
  ] as const)('%s %s → %s', (method, path, expected) => expect(operationName(method, path, 'widget')).toBe(expected));

  it('suffixes collisions in sorted order and avoids reserved names', () => {
    const base = { group: 'Public APIs', tag: 'widget (v1)', tagKey: 'widget', permissions: [], parameters: [], fullPath: '' };
    const { operations, warnings } = assignOperationNames([
      { ...base, method: 'get', path: '/widget/v1/a-b' },
      { ...base, method: 'get', path: '/widget/v1/aB' },
      { ...base, method: 'get', path: '/widget/v1/constructor', tagKey: 'x' },
    ]);
    expect(operations.map((o) => o.name)).toEqual(['getAB', 'getAB_2', 'getConstructor']);
    expect(warnings).toEqual(['API operations GET /widget/v1/a-b, GET /widget/v1/aB map to the same name widget.getAB; generated getAB, getAB_2']);
  });
});

describe('convertSchema', () => {
  it('converts types, refs, arrays, enums, objects and unknowns', () => {
    expect(convertSchema({ type: 'string', format: 'date-time' })).toEqual({ kind: 'string', format: 'date-time' });
    expect(convertSchema({ type: 'string', enum: ['A', 'B'] })).toEqual({ kind: 'string', enum: ['A', 'B'] });
    expect(convertSchema({ type: 'integer', format: 'int32' })).toEqual({ kind: 'number', integer: true, format: 'int32' });
    expect(convertSchema({ type: 'number' })).toEqual({ kind: 'number', integer: false });
    expect(convertSchema({ type: 'boolean' })).toEqual({ kind: 'boolean' });
    expect(convertSchema({ $ref: '#/definitions/widget.v1.Widget' })).toEqual({ kind: 'ref', name: 'widget.v1.Widget' });
    expect(convertSchema({ type: 'array', items: { type: 'string' } })).toEqual({ kind: 'array', items: { kind: 'string' } });
    expect(convertSchema({ type: 'object', properties: { a: { type: 'string', description: ' Id ' } }, required: ['a'] })).toEqual({
      kind: 'object', properties: { a: { kind: 'string', description: 'Id' } }, required: ['a'],
    });
    expect(convertSchema({ properties: { a: { type: 'boolean' } } })).toEqual({ kind: 'object', properties: { a: { kind: 'boolean' } }, required: [] });
    expect(convertSchema({ type: 'object', additionalProperties: { type: 'integer' } })).toEqual({
      kind: 'object', properties: {}, required: [], additional: { kind: 'number', integer: true },
    });
    expect(convertSchema({ type: 'file' })).toEqual({ kind: 'unknown' });
    expect(convertSchema(undefined)).toEqual({ kind: 'unknown' });
  });
});

const spec = {
  swagger: '2.0',
  basePath: '/api',
  paths: {
    '/widget/v1/widgets': {
      get: {
        tags: ['widget (v1)'], operationId: 'GET /widget/v1/widgets', description: ' Lists widgets. ', 'x-permissions': ['VIEW_WIDGET'],
        parameters: [
          { in: 'query', name: 'wh_id', type: 'string', required: true, description: 'Warehouse' },
          { in: 'query', name: 'status', type: 'string', enum: ['A', 'X'] },
          { in: 'header', name: 'X-Trace', type: 'string' },
        ],
        responses: { 200: { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/definitions/widget.v1.Widget' } } } } } },
      },
      post: {
        tags: ['widget (v1)'], operationId: 'POST /widget/v1/widgets',
        parameters: [{ in: 'body', name: 'argMap', required: true, schema: { type: 'object', properties: { wh_id: { type: 'string' } }, required: ['wh_id'] } }],
        responses: { 200: { schema: { type: 'object', properties: { inventory: { type: 'string' } } } } },
      },
    },
    '/widget/v1/widgets/{widget_id}': {
      delete: { tags: ['widget (v1)'], parameters: [{ in: 'path', name: 'widget_id', type: 'string', required: true }], responses: { 204: {} } },
    },
  },
  definitions: {
    'widget.v1.Widget': { type: 'object', properties: { widget_id: { type: 'string' }, part: { $ref: '#/definitions/widget.v1.Part' } } },
    'widget.v1.Part': { type: 'object', properties: { prtnum: { type: 'string' } } },
    'widget.v1.Unused': { type: 'object', properties: {} },
  },
};

describe('normalizeSwagger', () => {
  it('normalises operations, parameters, bodies and envelopes', () => {
    const result = normalizeSwagger({ name: 'Public APIs', private: false }, spec);
    expect(result.group).toEqual({ name: 'Public APIs', basePath: '/api', private: false });
    const [get, post, del] = result.operations;
    expect(get).toEqual({
      group: 'Public APIs', tag: 'widget (v1)', tagKey: 'widget', method: 'get', path: '/widget/v1/widgets', fullPath: '/api/widget/v1/widgets',
      description: 'Lists widgets.', permissions: ['VIEW_WIDGET'],
      parameters: [
        { in: 'query', name: 'wh_id', required: true, schema: { kind: 'string' }, description: 'Warehouse' },
        { in: 'query', name: 'status', required: false, schema: { kind: 'string', enum: ['A', 'X'] } },
      ],
      response: { envelope: 'data', schema: { kind: 'ref', name: 'widget.v1.Widget' } },
    });
    expect(post!.body).toEqual({ required: true, schema: { kind: 'object', properties: { wh_id: { kind: 'string' } }, required: ['wh_id'] } });
    expect(post!.response).toEqual({ envelope: 'body', schema: { kind: 'object', properties: { inventory: { kind: 'string' } }, required: [] } });
    expect(del!.response).toBeUndefined();
    expect(del!.permissions).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('namespaces private groups by group name (ruling P1)', () => {
    const result = normalizeSwagger({ name: 'mcs', private: true }, { ...spec, basePath: undefined });
    expect(result.operations.every((o) => o.tagKey === 'mcs' && o.fullPath === o.path)).toBe(true);
    expect(result.group).toEqual({ name: 'mcs', basePath: '', private: true });
  });

  it('rejects non-2.0 specs', () => {
    expect(() => normalizeSwagger({ name: 'Public APIs', private: false }, { openapi: '3.0.1', paths: {} })).toThrow(
      'API spec "Public APIs" is not Swagger 2.0 (found openapi 3.0.1)',
    );
  });

  it('keeps only reachable definitions, transitively', () => {
    const normalized = normalizeSwagger({ name: 'Public APIs', private: false }, spec);
    const { operations } = assignOperationNames(normalized.operations);
    expect(Object.keys(reachableDefinitions(operations, normalized.definitions)).sort()).toEqual(['widget.v1.Part', 'widget.v1.Widget']);
  });
});
