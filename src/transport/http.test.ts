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

  it('wraps connection failures', async () => {
    const error = await request('http://127.0.0.1:1/service').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MocaTransportError);
    expect((error as MocaTransportError).cause).toBeDefined();
  }, 10_000);

  it('rejects URLs with embedded credentials without leaking the secret', async () => {
    const error = await request('http://admin:s3cret@127.0.0.1:1/service').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MocaTransportError);
    const mocaError = error as MocaTransportError;
    expect(mocaError.message).not.toContain('s3cret');
    expect(String(mocaError.cause)).not.toContain('s3cret');
  }, 10_000);

  it('does not leak credentials from the URL in the empty-body message', async () => {
    const url = await serve((_req, _body, res) => res.end('   '));
    const parsed = new URL(url);
    parsed.username = 'admin';
    parsed.password = 's3cret';
    const error = await request(parsed.toString()).catch((e: unknown) => e);
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
    const error = await request('http://127.0.0.1:1/service').catch((e: unknown) => e);
    expect((error as MocaTransportError).message).toMatch(/ECONNREFUSED|failed/i);
  }, 10_000);

  it('rejects redirects instead of silently following them', async () => {
    const url = await serve((_req, _body, res) => {
      res.writeHead(302, { Location: '/elsewhere' });
      res.end();
    });
    await expect(request(url)).rejects.toBeInstanceOf(MocaTransportError);
  });
});
