import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MocaTransportError } from '../errors.js';
import { httpTransport, MOCA_CONTENT_TYPE } from './http.js';

let server: Server | undefined;

async function serve(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<string> {
  const instance = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => handler(req, body, res));
  });
  server = instance;
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}/service`;
}

afterEach(async () => {
  const instance = server;
  server = undefined;
  if (instance === undefined) return;
  // Timeout/abort tests leave requests hanging; drop them so close() can finish.
  instance.closeAllConnections();
  await new Promise<void>((resolve) => instance.close(() => resolve()));
});

/**
 * Returns a port that is free at the moment of the call, by briefly listening on port 0 and
 * closing again. Port 1 is an undici "bad port" (it refuses the request before even attempting
 * a connection), so it does not exercise a real ECONNREFUSED.
 */
async function getFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const request = (url: string, extra: Partial<Parameters<typeof httpTransport>[0]> = {}) =>
  httpTransport({ url, body: '<moca-request/>', timeoutMs: 2_000, ignoreSslIssues: false, ...extra });

describe('httpTransport', () => {
  it('POSTs moca-xml and returns the body text', async () => {
    let seen: { method?: string; type?: string; accept?: string; body?: string } = {};
    const url = await serve((req, body, res) => {
      seen = { method: req.method, type: req.headers['content-type'], accept: req.headers.accept, body };
      res.end('<moca-response/>');
    });
    await expect(request(url)).resolves.toBe('<moca-response/>');
    expect(seen).toEqual({ method: 'POST', type: MOCA_CONTENT_TYPE, accept: MOCA_CONTENT_TYPE, body: '<moca-request/>' });
  });

  it('throws MocaTransportError with httpStatus on non-2xx', async () => {
    const url = await serve((_req, _body, res) => {
      res.statusCode = 503;
      res.end('down');
    });
    await expect(request(url)).rejects.toMatchObject({ name: 'MocaTransportError', httpStatus: 503 });
  });

  it('throws on an empty body', async () => {
    const url = await serve((_req, _body, res) => res.end('   '));
    await expect(request(url)).rejects.toThrow(/empty response/);
  });

  it('throws on timeout', async () => {
    const url = await serve(() => undefined);
    await expect(request(url, { timeoutMs: 100 })).rejects.toThrow(/timed out after 100 ms/);
  });

  it('throws when aborted by the caller', async () => {
    const url = await serve(() => undefined);
    const controller = new AbortController();
    const pending = request(url, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it('throws immediately for an already-aborted signal, without sending the request', async () => {
    let requestsReceived = 0;
    const url = await serve((_req, _body, res) => {
      requestsReceived += 1;
      res.end('<moca-response/>');
    });
    await expect(request(url, { signal: AbortSignal.abort() })).rejects.toThrow(/aborted/);
    expect(requestsReceived).toBe(0);
  });

  it('wraps connection failures', async () => {
    const port = await getFreePort();
    const error = await request(`http://127.0.0.1:${port}/service`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MocaTransportError);
    expect((error as MocaTransportError).cause).toBeDefined();
  }, 10_000);

  it('rejects an unparseable URL without leaking it via the error cause', async () => {
    const error = await request('http://u:p@ss@h:99999/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MocaTransportError);
    const mocaError = error as MocaTransportError;
    expect(mocaError.message).not.toContain('p@ss');
    expect(String(mocaError.cause)).not.toContain('p@ss');
  });

  it('rejects URLs with embedded credentials without leaking the secret', async () => {
    const error = await request('http://admin:s3cret@127.0.0.1:1/service').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MocaTransportError);
    const mocaError = error as MocaTransportError;
    expect(mocaError.message).not.toContain('s3cret');
    expect(String(mocaError.cause)).not.toContain('s3cret');
  }, 10_000);

  it('does not leak a URL query token in the empty-body message', async () => {
    const base = await serve((_req, _body, res) => res.end('   '));
    const url = `${base}?token=s3cret`;
    const error = await request(url).catch((e: unknown) => e);
    expect((error as MocaTransportError).message).toMatch(/empty response/);
    expect((error as MocaTransportError).message).not.toContain('s3cret');
  });

  it('times out while reading a stalled response body', async () => {
    const url = await serve((_req, _body, res) => {
      res.writeHead(200);
      res.write('<moca');
      // never end the response
    });
    await expect(request(url, { timeoutMs: 150 })).rejects.toThrow(/timed out/);
  });

  it('includes the underlying cause code/message for network failures', async () => {
    const port = await getFreePort();
    const error = await request(`http://127.0.0.1:${port}/service`).catch((e: unknown) => e);
    expect((error as MocaTransportError).message).toMatch(/ECONNREFUSED/);
  }, 10_000);

  it('rejects redirects instead of silently following them', async () => {
    const url = await serve((_req, _body, res) => {
      res.writeHead(302, { Location: '/elsewhere' });
      res.end();
    });
    await expect(request(url)).rejects.toBeInstanceOf(MocaTransportError);
  });
});
