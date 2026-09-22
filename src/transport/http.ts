import { Agent, fetch } from 'undici';
import { MocaTransportError } from '../errors.js';

export const MOCA_CONTENT_TYPE = 'application/moca-xml';

export interface TransportRequest {
  url: string;
  body: string;
  timeoutMs: number;
  ignoreSslIssues: boolean;
  signal?: AbortSignal;
}

/** Sends one moca-request body and resolves to the raw response text. */
export type Transport = (request: TransportRequest) => Promise<string>;

let insecureAgent: Agent | undefined;

function dispatcherFor(ignoreSslIssues: boolean): Agent | undefined {
  if (!ignoreSslIssues) return undefined;
  insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  return insecureAgent;
}

export const httpTransport: Transport = async ({ url, body, timeoutMs, ignoreSslIssues, signal }) => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const reason = (error: unknown): string => {
    if (timeout.aborted) return `timed out after ${timeoutMs} ms`;
    if (signal?.aborted) return 'was aborted';
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  };

  let status: number;
  let ok: boolean;
  let text: string;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': MOCA_CONTENT_TYPE, Accept: MOCA_CONTENT_TYPE },
      body,
      signal: combined,
      dispatcher: dispatcherFor(ignoreSslIssues),
    });
    status = response.status;
    ok = response.ok;
    text = await response.text();
  } catch (error) {
    throw new MocaTransportError(`Request to ${url} ${reason(error)}`, { cause: error });
  }

  if (!ok) throw new MocaTransportError(`MOCA server responded with HTTP ${status}`, { httpStatus: status });
  if (text.trim() === '') {
    throw new MocaTransportError(`The MOCA server returned an empty response; check that ${url} is the MOCA service endpoint`, {
      httpStatus: status,
    });
  }
  return text;
};
