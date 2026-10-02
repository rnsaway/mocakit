import { describe, expect, it } from 'vitest';
import { MocaTransportError } from '../errors.js';
import type { RestRequest, RestResponse, RestTransport } from '../transport/rest.js';
import { apiBaseUrl, introspectApi } from './introspect-api.js';

const json = (status: number, body: unknown): RestResponse => ({ status, headers: { 'content-type': 'application/json' }, setCookies: [], body: JSON.stringify(body) });
const list = [
  { name: 'Public APIs', url: '/api/api-docs/v2' },
  { name: 'gizmo', url: '/ws/gizmo/v2/api-docs?group=private' },
];
const publicSpec = {
  swagger: '2.0', basePath: '/api',
  paths: { '/widget/v1/widgets': { get: { tags: ['widget (v1)'], responses: { 200: { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/definitions/W' } } } } } } } } },
  definitions: { W: { type: 'object', properties: { a: { type: 'string' } } }, Unused: { type: 'object' } },
};
const gizmoSpec = { swagger: '2.0', paths: { '/gizmos': { get: { tags: ['gizmo-controller'], responses: {} } } } };

function fake(overrides: Record<string, () => RestResponse> = {}) {
  const requests: RestRequest[] = [];
  const transport: RestTransport = async (req) => {
    requests.push(req);
    const path = new URL(req.url).pathname + new URL(req.url).search;
    if (overrides[path]) return overrides[path]!();
    if (path === '/app/ws/admin/publicApis') return json(200, list);
    if (path === '/app/api/api-docs/v2') return json(200, publicSpec);
    if (path === '/app/ws/gizmo/v2/api-docs?group=private') return json(200, gizmoSpec);
    return json(404, {});
  };
  return { transport, requests };
}

const base = { url: 'https://moca.test/app/service', ignoreSslIssues: false, version: '0.5.0', sleep: async () => {} };

describe('apiBaseUrl', () => {
  it('strips the trailing /service', () => {
    expect(apiBaseUrl('https://h/x/service')).toBe('https://h/x/');
    expect(apiBaseUrl('https://h/service/')).toBe('https://h/');
    expect(apiBaseUrl('https://h/')).toBe('https://h/');
  });
});

describe('introspectApi', () => {
  it('fetches the public group by default and builds a snapshot with reachable definitions', async () => {
    const { transport, requests } = fake();
    const { snapshot, warnings } = await introspectApi({ ...base, groups: ['Public APIs'], transport });
    expect(requests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ['GET', '/app/ws/admin/publicApis'],
      ['GET', '/app/api/api-docs/v2'],
    ]);
    expect(snapshot.groups).toEqual([{ name: 'Public APIs', basePath: '/api', private: false }]);
    expect(snapshot.operations.map((o) => `${o.tagKey}.${o.name}`)).toEqual(['widget.getWidgets']);
    expect(Object.keys(snapshot.definitions)).toEqual(['W']);
    expect(snapshot.server).toBe('https://moca.test/app/service');
    expect(warnings).toEqual([]);
  });

  it('includes named private groups under their own namespace', async () => {
    const { transport } = fake();
    const { snapshot } = await introspectApi({ ...base, groups: ['Public APIs', 'gizmo'], transport });
    expect(snapshot.operations.map((o) => `${o.tagKey}.${o.name}`)).toEqual(['gizmo.getGizmos', 'widget.getWidgets']);
    expect(snapshot.groups[1]).toEqual({ name: 'gizmo', basePath: '', private: true });
  });

  it('rejects unknown groups with the available names', async () => {
    await expect(introspectApi({ ...base, groups: ['nope'], transport: fake().transport })).rejects.toThrow(
      'Unknown API group "nope"; available: Public APIs, gizmo',
    );
  });

  it('retries resets and transient statuses, then succeeds', async () => {
    let n = 0;
    const { transport } = fake({
      '/app/api/api-docs/v2': () => {
        n++;
        if (n === 1) throw new MocaTransportError('reset');
        if (n === 2) return json(503, {});
        return json(200, publicSpec);
      },
    });
    const { snapshot } = await introspectApi({ ...base, groups: ['Public APIs'], transport });
    expect(n).toBe(3);
    expect(snapshot.operations).toHaveLength(1);
  });

  it('does not retry non-transport errors thrown by the transport', async () => {
    let n = 0;
    const { transport } = fake({
      '/app/api/api-docs/v2': () => {
        n++;
        throw new TypeError('boom');
      },
    });
    await expect(introspectApi({ ...base, groups: ['Public APIs'], transport })).rejects.toThrow('boom');
    expect(n).toBe(1);
  });

  it('fails clearly on non-200 and non-2.0 specs', async () => {
    await expect(introspectApi({ ...base, groups: ['Public APIs'], transport: fake({ '/app/api/api-docs/v2': () => json(403, {}) }).transport })).rejects.toThrow(
      'Fetching API spec "Public APIs" failed (HTTP 403)',
    );
    await expect(
      introspectApi({ ...base, groups: ['Public APIs'], transport: fake({ '/app/api/api-docs/v2': () => json(200, { openapi: '3.0.0', paths: {} }) }).transport }),
    ).rejects.toThrow('API spec "Public APIs" is not Swagger 2.0 (found openapi 3.0.0)');
  });
});
