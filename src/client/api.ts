import { formatMocaDate } from '../dates/codec.js';
import { MocaApiError, MocaArgumentError, MocaAuthError, MocaTransportError } from '../errors.js';
import { httpRestTransport, isTransientStatus, withRetry, type RestResponse, type RestTransport } from '../transport/rest.js';
import { apiBaseUrl } from '../util/url.js';
import { clientContext, type MocaClient } from './client.js';

export type ApiOperationSpec = readonly [method: 'get' | 'post' | 'put' | 'delete' | 'patch', fullPath: string, envelope: 'data' | 'body'];
export type ApiSpecTable = Readonly<Record<string, Readonly<Record<string, ApiOperationSpec>>>>;
export interface ApiCallOptions {
  /** 'rows' (default) unwraps `{ data: [...] }`; 'full' resolves to `{ status, body }`. */
  format?: 'rows' | 'full';
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type ApiRowsOptions = ApiCallOptions & { format?: 'rows' };
export type ApiFullOptions = ApiCallOptions & { format: 'full' };
export interface ApiFullResult<T> {
  status: number;
  body: T;
}
export interface ApiParams {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  form?: Record<string, unknown>;
}
export interface ApiClientContext {
  url: string;
  username: string;
  password: string;
  ignoreSslIssues: boolean;
  timeoutMs: number;
  transport: RestTransport;
  sleep?: (ms: number) => Promise<void>;
}

const SESSION_COOKIE = 'MOCA-WS-SESSIONKEY';
const GET_RETRY_DELAYS = [500, 1500];
const NO_ROWS = /^\s*no rows affected\.?\s*$/i;

function scalar(value: unknown): string {
  if (value instanceof Date) return formatMocaDate(value);
  return String(value);
}

/** True for a cookie that asks to be removed: Max-Age <= 0 or an Expires in the past. */
function isExpired(attrs: string[]): boolean {
  for (const attr of attrs) {
    const eq = attr.indexOf('=');
    if (eq < 0) continue;
    const key = attr.slice(0, eq).trim().toLowerCase();
    const value = attr.slice(eq + 1).trim();
    if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds <= 0) return true;
    } else if (key === 'expires') {
      const at = Date.parse(value);
      if (Number.isFinite(at) && at < Date.now()) return true;
    }
  }
  return false;
}

export class ApiClient {
  readonly #ctx: ApiClientContext;
  readonly #base: string;
  #cookies = new Map<string, string>();
  #login: Promise<void> | null = null;

  constructor(ctx: ApiClientContext) {
    this.#ctx = ctx;
    this.#base = apiBaseUrl(ctx.url);
  }

  #absorb(response: RestResponse, into: Map<string, string> = this.#cookies): void {
    for (const cookie of response.setCookies) {
      const [pair, ...attrs] = cookie.split(';');
      const eq = pair!.indexOf('=');
      if (eq <= 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === '' || isExpired(attrs)) into.delete(name);
      else into.set(name, value);
    }
  }

  /** Returns the login in flight (or completed), starting one if there is none. Never retried. */
  #ensureLogin(): Promise<void> {
    if (this.#login !== null) return this.#login;
    const login: Promise<void> = (async () => {
      const response = await this.#ctx.transport({
        method: 'POST',
        url: new URL('ws/auth/login', this.#base).href,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ usr_id: this.#ctx.username, password: this.#ctx.password }),
        timeoutMs: this.#ctx.timeoutMs,
        ignoreSslIssues: this.#ctx.ignoreSslIssues,
      });
      if (response.status !== 200 && response.status !== 201) throw new MocaAuthError(`REST login failed with HTTP ${response.status}`);
      const fresh = new Map<string, string>();
      this.#absorb(response, fresh);
      if (!fresh.has(SESSION_COOKIE)) throw new MocaAuthError(`REST login did not return a ${SESSION_COOKIE} cookie`);
      this.#cookies = fresh;
    })().catch((error: unknown) => {
      if (this.#login === login) this.#login = null;
      throw error;
    });
    this.#login = login;
    return login;
  }

  /**
   * Forces a fresh login after a 401, single-flight: only if `failed` (the login the rejected
   * request used) is still the current one. Otherwise another call already replaced it, so share that.
   */
  #relogin(failed: Promise<void>): Promise<void> {
    if (this.#login === failed) this.#login = null;
    return this.#ensureLogin();
  }

  async call(spec: ApiOperationSpec, params: ApiParams = {}, opts: ApiCallOptions = {}): Promise<unknown> {
    const [method, fullPath, envelope] = spec;
    const label = `${method.toUpperCase()} ${fullPath}`;
    const path = fullPath.replace(/\{([^}]+)\}/g, (_m, name: string) => {
      const value = params.path?.[name];
      if (value === undefined || value === null) throw new MocaArgumentError(`Missing path parameter "${name}" for ${label}`, name);
      const text = scalar(value);
      // new URL() collapses dot segments, which would silently retarget the request.
      if (text === '' || text === '.' || text === '..') {
        throw new MocaArgumentError(`Invalid path parameter "${name}" for ${label}: must not be empty, "." or ".."`, name);
      }
      return encodeURIComponent(text);
    });
    const url = new URL(path.replace(/^\//, ''), this.#base);
    for (const [key, value] of Object.entries(params.query ?? {})) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, scalar(item));
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    let body: string | undefined;
    if (params.form !== undefined) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(params.form)) if (v !== undefined && v !== null) form.append(k, scalar(v));
      body = form.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (params.body !== undefined) {
      body = JSON.stringify(params.body);
      headers['content-type'] = 'application/json';
    }

    // Only the transport call is retried. Login happens outside, so a failed login is never repeated.
    const send = async (): Promise<RestResponse> => {
      // Use the jar the request was sent with, so a stale response never touches a newer login's jar.
      const jar = this.#cookies;
      const response = await this.#ctx.transport({
        method: method.toUpperCase(),
        url: url.href,
        headers: { ...headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
        body,
        timeoutMs: opts.timeoutMs ?? this.#ctx.timeoutMs,
        ignoreSslIssues: this.#ctx.ignoreSslIssues,
        signal: opts.signal,
      });
      this.#absorb(response, jar);
      return response;
    };
    const attempt =
      method === 'get'
        ? () =>
            withRetry(send, {
              delays: GET_RETRY_DELAYS,
              retryOn: ({ result, error }) => error instanceof MocaTransportError || (result !== undefined && isTransientStatus(result.status)),
              signal: opts.signal,
              sleep: this.#ctx.sleep,
            })
        : send;

    let login = this.#ensureLogin();
    await login;
    let response = await attempt();
    if (response.status === 401) {
      login = this.#relogin(login);
      await login;
      response = await attempt();
    }

    let parsed: unknown = null;
    if (response.body.trim() !== '') {
      try {
        parsed = JSON.parse(response.body);
      } catch {
        parsed = response.body;
      }
    }
    if (response.status < 200 || response.status >= 300) {
      const info = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const first = Array.isArray(info.errors) && typeof info.errors[0] === 'object' && info.errors[0] !== null ? (info.errors[0] as Record<string, unknown>) : {};
      // The server answers an empty list with 404 "no rows affected"; for a GET list that is just no rows.
      if (method === 'get' && envelope === 'data' && response.status === 404 && typeof first.userMessage === 'string' && NO_ROWS.test(first.userMessage)) {
        return opts.format === 'full' ? { status: response.status, body: { data: [] } } : [];
      }
      throw new MocaApiError({
        method: method.toUpperCase(),
        path: fullPath,
        httpStatus: response.status,
        userMessage: typeof first.userMessage === 'string' ? first.userMessage : null,
        errorCode: typeof first.errorCode === 'string' ? first.errorCode : null,
        responseId: typeof info.responseId === 'string' ? info.responseId : null,
      });
    }
    if (opts.format === 'full') return { status: response.status, body: parsed };
    if (envelope === 'data' && typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { data?: unknown }).data)) {
      return (parsed as { data: unknown[] }).data;
    }
    return envelope === 'data' && parsed === null ? [] : parsed;
  }
}

/** Installs a lazily created, per-instance `api` namespace on a generated client class. */
export function defineApi(proto: MocaClient, table: ApiSpecTable): void {
  const cache = new WeakMap<object, unknown>();
  Object.defineProperty(proto, 'api', {
    configurable: true,
    get(this: MocaClient) {
      let namespace = cache.get(this);
      if (namespace === undefined) {
        const { config, deps } = clientContext(this);
        const client = new ApiClient({
          url: config.url,
          username: config.username,
          password: config.password,
          ignoreSslIssues: config.ignoreSslIssues ?? false,
          timeoutMs: config.timeoutMs ?? 300_000,
          transport: deps.restTransport ?? httpRestTransport,
        });
        namespace = Object.fromEntries(
          Object.entries(table).map(([tag, ops]) => [
            tag,
            Object.fromEntries(Object.entries(ops).map(([name, spec]) => [name, (params?: ApiParams, opts?: ApiCallOptions) => client.call(spec, params, opts)])),
          ]),
        );
        cache.set(this, namespace);
      }
      return namespace;
    },
  });
}
