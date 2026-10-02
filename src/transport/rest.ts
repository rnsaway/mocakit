import { fetch } from 'undici';
import { MocaTransportError } from '../errors.js';
import { redactUrl } from '../util/url.js';
import { dispatcherFor, networkFailureMessage } from './http.js';

export interface RestRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  ignoreSslIssues: boolean;
  signal?: AbortSignal;
}

export interface RestResponse {
  status: number;
  /** Lowercased header names; `set-cookie` is in `setCookies`. */
  headers: Record<string, string>;
  setCookies: string[];
  body: string;
}

/** Sends one HTTP request. Treat a custom transport as trusted: it sees passwords (login) and session cookies. */
export type RestTransport = (request: RestRequest) => Promise<RestResponse>;

export const httpRestTransport: RestTransport = async ({ method, url, headers, body, timeoutMs, ignoreSslIssues, signal }) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MocaTransportError('The REST URL is not a valid URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new MocaTransportError('The MOCA URL must not contain credentials; use the username/password settings');
  }
  const safeUrl = redactUrl(url);
  if (signal?.aborted === true) throw new MocaTransportError(`Request to ${safeUrl} was aborted`, { cause: signal.reason });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(parsed, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
      dispatcher: dispatcherFor(ignoreSslIssues),
    });
    const text = await response.text();
    const out: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') out[key] = value;
    });
    return { status: response.status, headers: out, setCookies: response.headers.getSetCookie(), body: text };
  } catch (error) {
    if (timedOut) throw new MocaTransportError(`Request to ${safeUrl} timed out after ${timeoutMs} ms`, { cause: error });
    if (signal?.aborted) throw new MocaTransportError(`Request to ${safeUrl} was aborted`, { cause: error });
    throw new MocaTransportError(networkFailureMessage(safeUrl, error), { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

export function isTransientStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `attempt`, retrying after each delay while `retryOn` says so and the caller has not aborted. */
export async function withRetry<T>(
  attempt: () => Promise<T>,
  options: { delays: number[]; retryOn: (outcome: { result?: T; error?: unknown }) => boolean; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let i = 0; ; i++) {
    let outcome: { result?: T; error?: unknown };
    try {
      outcome = { result: await attempt() };
    } catch (error) {
      outcome = { error };
    }
    const canRetry = i < options.delays.length && options.signal?.aborted !== true && options.retryOn(outcome);
    if (!canRetry) {
      if ('error' in outcome && outcome.error !== undefined) throw outcome.error;
      return outcome.result as T;
    }
    await sleep(options.delays[i]!);
  }
}
