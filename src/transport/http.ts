import { Agent, fetch } from 'undici';
import { MocaTransportError } from '../errors.js';
import { redactUrl } from '../util/url.js';

export const MOCA_CONTENT_TYPE = 'application/moca-xml';

export interface TransportRequest {
  url: string;
  body: string;
  timeoutMs: number;
  ignoreSslIssues: boolean;
  signal?: AbortSignal;
}

/**
 * Sends one moca-request body and resolves to the raw response text.
 *
 * A custom transport sees every request body verbatim, which includes the password (in the
 * `login user` request) and the live `SESSION_KEY` (in every other request's environment). Treat
 * it as trusted code, and don't log request bodies.
 */
export type Transport = (request: TransportRequest) => Promise<string>;

let insecureAgent: Agent | undefined;

function dispatcherFor(ignoreSslIssues: boolean): Agent | undefined {
  if (!ignoreSslIssues) return undefined;
  insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  return insecureAgent;
}

function networkFailureMessage(safeUrl: string, error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause !== null && typeof cause === 'object') {
    const code = 'code' in cause ? String((cause as { code?: unknown }).code) : undefined;
    const causeMessage = 'message' in cause ? String((cause as { message?: unknown }).message) : undefined;
    const detail = code !== undefined && causeMessage !== undefined ? `${code} ${causeMessage}`.trim() : (code ?? causeMessage);
    if (detail !== undefined) return `Request to ${safeUrl} failed: ${detail}`;
  }
  return `Request to ${safeUrl} failed: ${error instanceof Error ? error.message : String(error)}`;
}

export const httpTransport: Transport = async ({ url, body, timeoutMs, ignoreSslIssues, signal }) => {
  // Parse the URL up front, before it can reach undici/fetch: a URL that fails to parse there
  // ends up embedded verbatim in the thrown error's `cause`, which can include credentials.
  // Throwing here, with no cause, keeps that raw text out of the error entirely.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new MocaTransportError('The MOCA service URL is not a valid URL');
  }
  const safeUrl = redactUrl(url);

  if (parsedUrl.username !== '' || parsedUrl.password !== '') {
    throw new MocaTransportError('The MOCA service URL must not contain credentials; use the username/password settings');
  }

  // `addEventListener('abort', ...)` never fires for a signal that is already aborted, so an
  // already-aborted signal must be checked explicitly here -- the caller has already cancelled,
  // and MOCA commands have side effects, so this request must not be sent at all.
  if (signal?.aborted === true) {
    throw new MocaTransportError(`Request to ${safeUrl} was aborted`, { cause: signal.reason });
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });

  const abortReasonMessage = (): string => {
    if (timedOut) return `timed out after ${timeoutMs} ms`;
    if (signal?.aborted) return 'was aborted';
    return '';
  };

  let status: number;
  let ok: boolean;
  let text: string;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': MOCA_CONTENT_TYPE, Accept: MOCA_CONTENT_TYPE },
      body,
      signal: controller.signal,
      redirect: 'error',
      dispatcher: dispatcherFor(ignoreSslIssues),
    });
    status = response.status;
    ok = response.ok;
    text = await response.text();
  } catch (error) {
    const abortReason = abortReasonMessage();
    const message = abortReason !== '' ? `Request to ${safeUrl} ${abortReason}` : networkFailureMessage(safeUrl, error);
    throw new MocaTransportError(message, { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }

  if (!ok) throw new MocaTransportError(`MOCA server responded with HTTP ${status}`, { httpStatus: status });
  if (text.trim() === '') {
    throw new MocaTransportError(`The MOCA server returned an empty response; check that ${safeUrl} is the MOCA service endpoint`, {
      httpStatus: status,
    });
  }
  return text;
};
