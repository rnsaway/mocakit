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
});
