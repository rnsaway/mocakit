import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MocaTransportError } from '../errors.js';
import { httpRestTransport, isTransientStatus, withRetry } from './rest.js';

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/slow') return; // never answers
      res.setHeader('set-cookie', ['A=1; Path=/', 'B=2; HttpOnly']);
      res.setHeader('content-type', 'application/json');
      res.statusCode = req.url === '/missing' ? 404 : 200;
      res.end(JSON.stringify({ method: req.method, url: req.url, body, ct: req.headers['content-type'] ?? null, cookie: req.headers.cookie ?? null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('httpRestTransport', () => {
  it('sends method, headers and body and returns status, headers, cookies and body', async () => {
    const res = await httpRestTransport({
      method: 'POST', url: `${base}/x?y=1`, headers: { 'content-type': 'application/json', cookie: 'S=k' },
      body: '{"a":1}', timeoutMs: 5000, ignoreSslIssues: false,
    });
    expect(res.status).toBe(200);
    expect(res.setCookies).toEqual(['A=1; Path=/', 'B=2; HttpOnly']);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual({ method: 'POST', url: '/x?y=1', body: '{"a":1}', ct: 'application/json', cookie: 'S=k' });
  });

  it('returns non-2xx responses instead of throwing', async () => {
    expect((await httpRestTransport({ method: 'GET', url: `${base}/missing`, timeoutMs: 5000, ignoreSslIssues: false })).status).toBe(404);
  });

  it('times out with a MocaTransportError', async () => {
    await expect(httpRestTransport({ method: 'GET', url: `${base}/slow`, timeoutMs: 100, ignoreSslIssues: false })).rejects.toThrow(MocaTransportError);
  });

  it('rejects URLs with credentials without echoing them', async () => {
    const error = await httpRestTransport({ method: 'GET', url: 'http://u:secret@127.0.0.1:1/', timeoutMs: 100, ignoreSslIssues: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MocaTransportError);
    expect(String((error as Error).message)).not.toContain('secret');
  });
});

describe('withRetry', () => {
  const noSleep = async () => {};
  it('retries per retryOn and returns the first accepted result', async () => {
    let n = 0;
    const result = await withRetry(async () => ++n, { delays: [1, 1], retryOn: ({ result }) => (result ?? 0) < 3, sleep: noSleep });
    expect(result).toBe(3);
  });
  it('rethrows the last error when attempts run out', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error(`e${n}`); }, { delays: [1], retryOn: () => true, sleep: noSleep })).rejects.toThrow('e2');
  });
  it('does not retry after the caller aborted', async () => {
    const ac = new AbortController();
    let n = 0;
    await expect(withRetry(async () => { n++; ac.abort(); throw new Error('x'); }, { delays: [1, 1], retryOn: () => true, signal: ac.signal, sleep: noSleep })).rejects.toThrow('x');
    expect(n).toBe(1);
  });
  it('classifies transient statuses', () => {
    expect([429, 502, 503, 504].map(isTransientStatus)).toEqual([true, true, true, true]);
    expect([200, 401, 404, 422, 500].map(isTransientStatus)).toEqual([false, false, false, false, false]);
  });
});
