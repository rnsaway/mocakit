import { describe, expect, it } from 'vitest';
import { MocaApiError, MocaAuthError, MocaTransportError } from '../errors.js';
import type { RestRequest, RestResponse, RestTransport } from '../transport/rest.js';
import { ApiClient, defineApi, type ApiOperationSpec } from './api.js';
import { MocaClient } from './client.js';

const res = (status: number, body: unknown = {}, setCookies: string[] = []): RestResponse => ({
  status, headers: { 'content-type': 'application/json' }, setCookies, body: body === undefined ? '' : JSON.stringify(body),
});
const LOGIN_OK = res(200, undefined, ['MOCA-WS-SESSIONKEY=abc123; Path=/; HttpOnly', '__cf_bm=cf1; Path=/']);

function server(handler: (req: RestRequest, n: number) => RestResponse | Promise<RestResponse>) {
  const requests: RestRequest[] = [];
  const transport: RestTransport = async (req) => {
    requests.push(req);
    if (new URL(req.url).pathname.endsWith('/ws/auth/login')) return LOGIN_OK;
    return handler(req, requests.filter((r) => !r.url.includes('/ws/auth/login')).length);
  };
  return { transport, requests };
}

const ctx = (transport: RestTransport) =>
  new ApiClient({ url: 'https://moca.test/app/service', username: 'JDOE', password: 'pa$$', ignoreSslIssues: false, timeoutMs: 1000, transport, sleep: async () => {} });

const GET_WIDGETS: ApiOperationSpec = ['get', '/api/widget/v1/widgets/{widget_id}', 'data'];
const POST_MOVE: ApiOperationSpec = ['post', '/api/widget/v1/widgetMove', 'body'];

describe('ApiClient', () => {
  it('logs in lazily, sends the cookie, encodes path and query, unwraps data', async () => {
    const { transport, requests } = server(() => res(200, { data: [{ widget_id: 'W 1' }] }));
    const rows = await ctx(transport).call(GET_WIDGETS, {
      path: { widget_id: 'W 1/2' },
      query: { wh_id: 'WMD1', skip: null, later: undefined, since: new Date(2026, 8, 30, 13, 5, 9), active: true, n: 5 },
    });
    expect(rows).toEqual([{ widget_id: 'W 1' }]);
    expect(requests[0]).toMatchObject({ method: 'POST', url: 'https://moca.test/app/ws/auth/login', body: JSON.stringify({ usr_id: 'JDOE', password: 'pa$$' }) });
    const call = requests[1]!;
    expect(call.url).toBe('https://moca.test/app/api/widget/v1/widgets/W%201%2F2?wh_id=WMD1&since=20260930130509&active=true&n=5');
    expect(call.headers?.cookie).toBe('MOCA-WS-SESSIONKEY=abc123; __cf_bm=cf1');
  });

  it('logs in once for concurrent first calls', async () => {
    const { transport, requests } = server(() => res(200, { data: [] }));
    const client = ctx(transport);
    await Promise.all([client.call(GET_WIDGETS, { path: { widget_id: 'a' } }), client.call(GET_WIDGETS, { path: { widget_id: 'b' } })]);
    expect(requests.filter((r) => r.url.endsWith('/ws/auth/login'))).toHaveLength(1);
  });

  it('re-logs in once on 401 and retries (any method)', async () => {
    const { transport, requests } = server((_r, n) => (n === 1 ? res(401, { errors: [{ userMessage: 'Not authorized.' }] }) : res(200, { ok: 1 })));
    expect(await ctx(transport).call(POST_MOVE, { body: { a: 1 } })).toEqual({ ok: 1 });
    expect(requests.filter((r) => r.url.endsWith('/ws/auth/login'))).toHaveLength(2);
  });

  it('shares a single forced re-login between concurrent calls that both get a 401', async () => {
    const seen = new Set<string>();
    const { transport, requests } = server((req) => {
      if (!seen.has(req.url)) {
        seen.add(req.url);
        return res(401, {});
      }
      return res(200, { data: [{ ok: 1 }] });
    });
    const client = ctx(transport);
    const results = await Promise.all([client.call(GET_WIDGETS, { path: { widget_id: 'a' } }), client.call(GET_WIDGETS, { path: { widget_id: 'b' } })]);
    expect(results).toEqual([[{ ok: 1 }], [{ ok: 1 }]]);
    expect(requests.filter((r) => r.url.endsWith('/ws/auth/login'))).toHaveLength(2);
  });

  it('a stale 401 that clears the cookie never blanks the session of a newer login', async () => {
    const clear = ['MOCA-WS-SESSIONKEY=; Max-Age=0; Path=/'];
    const seen = new Set<string>();
    const retried: (string | undefined)[] = [];
    const { transport, requests } = server(async (req) => {
      if (!seen.has(req.url)) {
        seen.add(req.url);
        // The second call's 401 arrives after the first call's re-login has completed.
        if (req.url.endsWith('/b')) await new Promise((resolve) => setTimeout(resolve, 20));
        return res(401, {}, clear);
      }
      retried.push(req.headers?.cookie);
      return res(200, { data: [{ ok: 1 }] });
    });
    const client = ctx(transport);
    const results = await Promise.all([client.call(GET_WIDGETS, { path: { widget_id: 'a' } }), client.call(GET_WIDGETS, { path: { widget_id: 'b' } })]);
    expect(results).toEqual([[{ ok: 1 }], [{ ok: 1 }]]);
    expect(requests.filter((r) => r.url.endsWith('/ws/auth/login'))).toHaveLength(2);
    expect(retried).toHaveLength(2);
    for (const cookie of retried) expect(cookie).toContain('MOCA-WS-SESSIONKEY=abc123');
  });

  it('removes a cookie the server deletes', async () => {
    let n = 0;
    const { transport, requests } = server(() => (++n === 1 ? res(200, { data: [] }, ['__cf_bm=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/']) : res(200, { data: [] })));
    const client = ctx(transport);
    await client.call(GET_WIDGETS, { path: { widget_id: 'a' } });
    await client.call(GET_WIDGETS, { path: { widget_id: 'a' } });
    const calls = requests.filter((r) => !r.url.endsWith('/ws/auth/login'));
    expect(calls[0]!.headers?.cookie).toBe('MOCA-WS-SESSIONKEY=abc123; __cf_bm=cf1');
    expect(calls[1]!.headers?.cookie).toBe('MOCA-WS-SESSIONKEY=abc123');
  });

  it('retries GETs on transient failures but never retries a write', async () => {
    const flaky = server((_r, n) => (n === 1 ? res(503) : res(200, { data: [{ ok: 1 }] })));
    expect(await ctx(flaky.transport).call(GET_WIDGETS, { path: { widget_id: 'a' } })).toEqual([{ ok: 1 }]);

    let posts = 0;
    const reset: RestTransport = async (req) => {
      if (req.url.endsWith('/ws/auth/login')) return LOGIN_OK;
      posts++;
      throw new MocaTransportError('reset');
    };
    await expect(ctx(reset).call(POST_MOVE, { body: {} })).rejects.toThrow('reset');
    expect(posts).toBe(1);
    const unavailable = server(() => res(503, { errors: [{ userMessage: 'busy' }] }));
    await expect(ctx(unavailable.transport).call(POST_MOVE, { body: {} })).rejects.toThrow(MocaApiError);
    expect(unavailable.requests.filter((r) => !r.url.endsWith('/ws/auth/login'))).toHaveLength(1);
  });

  it('retries a GET on a transport error from the call itself', async () => {
    let calls = 0;
    const transport: RestTransport = async (req) => {
      if (req.url.endsWith('/ws/auth/login')) return LOGIN_OK;
      if (++calls === 1) throw new MocaTransportError('reset');
      return res(200, { data: [{ ok: 1 }] });
    };
    expect(await ctx(transport).call(GET_WIDGETS, { path: { widget_id: 'a' } })).toEqual([{ ok: 1 }]);
    expect(calls).toBe(2);
  });

  it('never retries a failed login, even for a GET', async () => {
    const requests: RestRequest[] = [];
    const loginDenied: RestTransport = async (req) => {
      requests.push(req);
      return res(401, {});
    };
    await expect(ctx(loginDenied).call(GET_WIDGETS, { path: { widget_id: 'a' } })).rejects.toThrow(MocaAuthError);
    expect(requests).toHaveLength(1);
  });

  it('sends JSON bodies and form bodies', async () => {
    const { transport, requests } = server(() => res(200, {}));
    await ctx(transport).call(POST_MOVE, { body: { wh_id: 'W' } });
    expect(requests[1]).toMatchObject({ body: '{"wh_id":"W"}', headers: expect.objectContaining({ 'content-type': 'application/json' }) });
    await ctx(transport).call(['post', '/api/x', 'body'], { form: { a: 'b c' } });
    expect(requests.at(-1)).toMatchObject({ body: 'a=b+c', headers: expect.objectContaining({ 'content-type': 'application/x-www-form-urlencoded' }) });
  });

  it('returns status and body with format full', async () => {
    const { transport } = server(() => res(200, { data: [{ a: 1 }] }));
    expect(await ctx(transport).call(GET_WIDGETS, { path: { widget_id: 'a' } }, { format: 'full' })).toEqual({ status: 200, body: { data: [{ a: 1 }] } });
  });

  it('resolves a GET list answered with 404 "no rows affected" to no rows', async () => {
    const noRows = (message: string) => res(404, { timestamp: 't', errors: [{ errorCode: null, userMessage: message }], responseId: 'r-1' });
    const { transport } = server(() => noRows('no rows affected'));
    expect(await ctx(transport).call(GET_WIDGETS, { path: { widget_id: 'a' } })).toEqual([]);
    expect(await ctx(transport).call(GET_WIDGETS, { path: { widget_id: 'a' } }, { format: 'full' })).toEqual({ status: 404, body: { data: [] } });
    expect(await ctx(server(() => noRows(' No rows affected. ')).transport).call(GET_WIDGETS, { path: { widget_id: 'a' } })).toEqual([]);
  });

  it('still raises other 404s, and no-rows 404s for writes or non-list operations', async () => {
    const noRows = res(404, { errors: [{ userMessage: 'no rows affected' }] });
    const other = server(() => res(404, { errors: [{ userMessage: 'Widget not found' }] }));
    await expect(ctx(other.transport).call(GET_WIDGETS, { path: { widget_id: 'a' } })).rejects.toMatchObject({ httpStatus: 404, userMessage: 'Widget not found' });
    await expect(ctx(server(() => res(404, '')).transport).call(GET_WIDGETS, { path: { widget_id: 'a' } })).rejects.toBeInstanceOf(MocaApiError);
    await expect(ctx(server(() => noRows).transport).call(['delete', '/api/widget/v1/widgets', 'data'])).rejects.toMatchObject({ httpStatus: 404 });
    await expect(ctx(server(() => noRows).transport).call(['get', '/api/widget/v1/summary', 'body'])).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('raises MocaApiError with server details and never leaks credentials', async () => {
    const { transport } = server(() => res(422, { errors: [{ errorCode: 'E9', userMessage: 'Bad wh_id' }], responseId: 'r-9' }));
    const error = (await ctx(transport).call(GET_WIDGETS, { path: { widget_id: 'a' } }).catch((e: unknown) => e)) as MocaApiError;
    expect(error).toBeInstanceOf(MocaApiError);
    expect(error).toMatchObject({ httpStatus: 422, userMessage: 'Bad wh_id', errorCode: 'E9', responseId: 'r-9', method: 'GET', path: '/api/widget/v1/widgets/{widget_id}' });
    expect(error.message).not.toContain('pa$$');
    expect(error.message).not.toContain('abc123');
  });

  it('fails login clearly without leaking the password', async () => {
    const bad: RestTransport = async () => res(401, {});
    const error = (await ctx(bad).call(GET_WIDGETS, { path: { widget_id: 'a' } }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(MocaAuthError);
    expect(error.message).toBe('REST login failed with HTTP 401');
    const noCookie: RestTransport = async () => res(200, {});
    await expect(ctx(noCookie).call(GET_WIDGETS, { path: { widget_id: 'a' } })).rejects.toThrow('REST login did not return a MOCA-WS-SESSIONKEY cookie');
  });

  it('rejects a missing path parameter before sending', async () => {
    const { transport, requests } = server(() => res(200, {}));
    await expect(ctx(transport).call(GET_WIDGETS, {})).rejects.toThrow('Missing path parameter "widget_id" for GET /api/widget/v1/widgets/{widget_id}');
    expect(requests).toEqual([]);
  });
});

describe('defineApi', () => {
  it('attaches a lazily created, per-instance api namespace using the client config and rest transport', async () => {
    class Generated extends MocaClient {}
    defineApi(Generated.prototype, { widget: { getWidgets: ['get', '/api/widget/v1/widgets', 'data'] } });
    const { transport, requests } = server(() => res(200, { data: [{ n: 1 }] }));
    const moca = new Generated({ url: 'https://moca.test/service', username: 'u', password: 'p', session: { reuse: false } }, { restTransport: transport });
    const api = (moca as unknown as { api: { widget: { getWidgets: (p?: object) => Promise<unknown> } } }).api;
    expect(api).toBe((moca as unknown as { api: unknown }).api);
    expect(await api.widget.getWidgets()).toEqual([{ n: 1 }]);
    expect(requests.at(-1)!.url).toBe('https://moca.test/api/widget/v1/widgets');
  });
});

describe('ApiClient path parameter safety', () => {
  const NOTES: ApiOperationSpec = ['delete', '/api/widget/v1/widgets/{widget_id}/notes', 'body'];

  it.each(['', '.', '..'])('rejects path value %j before sending anything', async (value) => {
    const { transport, requests } = server(() => res(200, {}));
    await expect(ctx(transport).call(NOTES, { path: { widget_id: value } })).rejects.toMatchObject({ name: 'MocaArgumentError' });
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['a.b', 'a.b'],
    ['..a', '..a'],
    ['a/..', 'a%2F..'],
  ])('still allows %j', async (value, encoded) => {
    const { transport, requests } = server(() => res(200, {}));
    await ctx(transport).call(NOTES, { path: { widget_id: value } });
    expect(requests[1]!.url).toBe(`https://moca.test/app/api/widget/v1/widgets/${encoded}/notes`);
  });
});
