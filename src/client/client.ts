import { defaultDateCodec } from '../dates/codec.js';
import { MocaArgumentError, MocaAuthError, MocaCommandError, MocaError, MocaTransportError, redactCommand } from '../errors.js';
import { toRows } from '../protocol/convert.js';
import { buildRequest, type MocaEnvironment } from '../protocol/request.js';
import { parseResponse, type RawResponse } from '../protocol/response.js';
import { SessionManager } from '../session/session-manager.js';
import { MemorySessionStore, sessionCacheKey, sharedSessionStore, type SessionState } from '../session/store.js';
import { httpTransport, type Transport } from '../transport/http.js';
import type {
  CallOptions,
  CommandSpec,
  FullOptions,
  MocaConfig,
  MocaResult,
  MocaRow,
  RowsOptions,
  SessionInfo,
} from '../types.js';
import { redactUrl } from '../util/url.js';
import { quoteMocaString, renderCommand } from './render.js';

export const MOCA_STATUS = { OK: 0, NO_ROWS: 510, SESSION_EXPIRED: 523 } as const;

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_AGE_MINUTES = 30;

export interface MocaClientDeps {
  transport?: Transport;
  now?: () => number;
}

interface ResolvedOptions {
  format: 'rows' | 'full';
  convert: boolean;
  noRowsIsError: boolean;
  autocommit: boolean;
  env: Record<string, string> | undefined;
  signal: AbortSignal | undefined;
}

function pick(row: MocaRow | undefined, column: string, fallbackPosition: number): string | null {
  if (row === undefined) return null;
  const match = Object.keys(row).find((key) => key.toLowerCase() === column);
  const value = match !== undefined ? row[match] : Object.values(row)[fallbackPosition - 1];
  return typeof value === 'string' && value !== '' ? value : null;
}

const PROTECTED_ENV_KEYS = new Set(['usr_id', 'session_key']);

/** `USR_ID`/`SESSION_KEY` are how the client identifies its own session; letting a per-call
 * `env` override them would let a caller silently run commands as a different user/session. */
function assertNoProtectedEnvOverride(env: Record<string, string> | undefined): void {
  if (env === undefined) return;
  for (const key of Object.keys(env)) {
    if (PROTECTED_ENV_KEYS.has(key.toLowerCase())) {
      throw new MocaArgumentError('USR_ID and SESSION_KEY cannot be overridden per call', key);
    }
  }
}

export class MocaClient {
  readonly #config: MocaConfig;
  readonly #transport: Transport;
  readonly #now: () => number;
  readonly #sessions: SessionManager;

  constructor(config: MocaConfig, deps: MocaClientDeps = {}) {
    if (config.url === '') throw new MocaArgumentError('MocaConfig.url must not be empty', 'url');
    if (config.username === '') throw new MocaArgumentError('MocaConfig.username must not be empty', 'username');
    if (config.password === '') throw new MocaArgumentError('MocaConfig.password must not be empty', 'password');
    if (config.session?.maxAgeMinutes !== undefined && !Number.isFinite(config.session.maxAgeMinutes)) {
      throw new MocaArgumentError('MocaConfig.session.maxAgeMinutes must be a finite number', 'session.maxAgeMinutes');
    }
    if (config.timeoutMs !== undefined && !(Number.isFinite(config.timeoutMs) && config.timeoutMs > 0)) {
      throw new MocaArgumentError('MocaConfig.timeoutMs must be a positive, finite number of milliseconds', 'timeoutMs');
    }

    this.#config = config;
    this.#transport = deps.transport ?? httpTransport;
    this.#now = deps.now ?? Date.now;
    const reuse = config.session?.reuse ?? true;
    const minutes = config.session?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES;
    this.#sessions = new SessionManager({
      cacheKey: sessionCacheKey(config.url, config.username, config.password),
      store: reuse ? (config.session?.store ?? sharedSessionStore) : new MemorySessionStore(),
      maxAgeMs: minutes <= 0 ? Number.POSITIVE_INFINITY : minutes * 60_000,
      login: async () => (await this.#login()).state,
      now: this.#now,
    });
  }

  /** Runs raw MOCA text. The caller is responsible for quoting. */
  exec<T = MocaRow>(moca: string, opts?: RowsOptions): Promise<T[]>;
  exec<T = MocaRow>(moca: string, opts: FullOptions): Promise<MocaResult<T>>;
  exec(moca: string, opts?: CallOptions): Promise<unknown[] | MocaResult<unknown>>;
  async exec(moca: string, opts: CallOptions = {}): Promise<unknown[] | MocaResult<unknown>> {
    return this.#execute(moca, undefined, opts);
  }

  /** Validates and renders `args` against `spec`, then runs the command. Used by generated code. */
  call<T = MocaRow>(spec: CommandSpec, args?: object, opts?: RowsOptions): Promise<T[]>;
  call<T = MocaRow>(spec: CommandSpec, args: object | undefined, opts: FullOptions): Promise<MocaResult<T>>;
  call(spec: CommandSpec, args?: object, opts?: CallOptions): Promise<unknown[] | MocaResult<unknown>>;
  async call(spec: CommandSpec, args?: object, opts: CallOptions = {}): Promise<unknown[] | MocaResult<unknown>> {
    const allArgs: Record<string, unknown> = { ...(args ?? {}), ...(opts.extraArgs ?? {}) };
    let command: string;
    try {
      command = renderCommand(spec, args, opts.extraArgs, defaultDateCodec);
    } catch (error) {
      if (error instanceof MocaError) {
        error.command ??= spec[0];
        error.args ??= allArgs;
      }
      throw error;
    }
    return this.#execute(command, allArgs, opts);
  }

  /**
   * Logs in now (fail fast) and returns the converted login row.
   *
   * Unlike `exec`/`call`, this does not go through the single-flight login path: it always
   * performs its own `login user` request, even if another call is already logging in. Any
   * session it replaces is not logged out first; only the local/shared cache entry is
   * overwritten, so the old session (if the server hasn't already expired it) is abandoned
   * rather than ended.
   */
  async login(): Promise<MocaRow> {
    const { state, row } = await this.#login();
    await this.#sessions.adopt(state);
    return row;
  }

  /**
   * Sends `logout user` and evicts the cached session, even if the server call fails.
   *
   * Two limitations worth knowing:
   * - With the default `session.reuse: true`, this ends the session for every `MocaClient`
   *   sharing the same URL/username/password, not just this instance.
   * - Calling it while a login is still in flight has no effect: this only acts on a session
   *   that is already cached (see `SessionManager#peek`), so a login that has not yet
   *   resolved is left completely untouched.
   */
  async logout(): Promise<void> {
    const session = await this.#sessions.peek();
    if (session === null) return;
    try {
      const response = await this.#post('logout user', this.#environment(session, undefined), true, undefined);
      if (response.status !== MOCA_STATUS.OK && response.status !== MOCA_STATUS.SESSION_EXPIRED) {
        throw new MocaCommandError(response.status, response.message, { command: 'logout user' });
      }
    } finally {
      await this.#sessions.invalidate(session);
    }
  }

  get session(): SessionInfo {
    const state = this.#sessions.current;
    if (state === null) return { active: false, locale: null, ageMs: null };
    return { active: this.#sessions.isFresh(state), locale: state.locale, ageMs: this.#now() - state.createdAt };
  }

  async #execute(
    command: string,
    args: Record<string, unknown> | undefined,
    opts: CallOptions,
  ): Promise<unknown[] | MocaResult<unknown>> {
    const options = this.#resolve(opts);
    try {
      assertNoProtectedEnvOverride(options.env);
    } catch (error) {
      this.#enrich(error, command, args);
    }

    // Session acquisition is deliberately kept out of the enrichment try/catch below. A
    // single-flight login's rejection is the *same error object*, by reference, handed to
    // every concurrent caller awaiting that login (see SessionManager); enriching it here
    // with this call's `command`/`args` would leak one caller's args onto every other
    // caller's error. `#login` already attaches the (redacted) login command itself.
    let session = await this.#acquireSession(options.signal);

    try {
      let response = await this.#post(command, this.#environment(session, options.env), options.autocommit, options.signal);
      if (response.status === MOCA_STATUS.SESSION_EXPIRED) {
        await this.#sessions.invalidate(session);
        this.#throwIfAborted(options.signal);

        // Retrying is safe: MOCA rejects an invalid/expired session before executing the
        // command itself, so re-sending under a freshly logged-in session cannot cause the
        // command to run (or its side effects to apply) twice. This is the only automatic
        // retry mocakit performs (spec §10).
        session = await this.#acquireSession(options.signal);
        response = await this.#post(command, this.#environment(session, options.env), options.autocommit, options.signal);
        if (response.status === MOCA_STATUS.SESSION_EXPIRED) {
          await this.#sessions.invalidate(session);
          throw new MocaAuthError('The MOCA session expired again immediately after logging in', {
            status: MOCA_STATUS.SESSION_EXPIRED,
          });
        }
      }
      return this.#shape(response, options);
    } catch (error) {
      this.#enrich(error, command, args);
    }
  }

  /** Attaches `command`/`args` to a `MocaError` (a no-op for anything else) and rethrows. */
  #enrich(error: unknown, command: string, args: Record<string, unknown> | undefined): never {
    if (error instanceof MocaError) {
      error.command ??= command;
      error.args ??= args;
    }
    throw error;
  }

  #throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new MocaTransportError(`Request to ${redactUrl(this.#config.url)} was aborted`, { cause: signal.reason });
    }
  }

  /**
   * Resolves to a fresh session, racing the wait against `signal` without cancelling the
   * underlying login: that login may be a single-flight shared with other callers, and one
   * caller aborting its own wait must not stop it for everyone else.
   */
  async #acquireSession(signal: AbortSignal | undefined): Promise<SessionState> {
    const acquiring = this.#sessions.acquire();
    if (signal === undefined) return acquiring;
    this.#throwIfAborted(signal);

    return new Promise<SessionState>((resolve, reject) => {
      const onAbort = (): void => {
        reject(new MocaTransportError(`Request to ${redactUrl(this.#config.url)} was aborted`, { cause: signal.reason }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      acquiring.then(
        (session) => {
          signal.removeEventListener('abort', onAbort);
          resolve(session);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  #shape(response: RawResponse, options: ResolvedOptions): MocaRow[] | MocaResult<MocaRow> {
    const emptyIsFine = response.status === MOCA_STATUS.NO_ROWS && !options.noRowsIsError;
    const rows = emptyIsFine ? [] : toRows(response, options.convert);
    const result: MocaResult<MocaRow> = {
      status: response.status,
      message: response.message,
      columns: response.columns,
      rows,
    };
    if (response.status !== MOCA_STATUS.OK && !emptyIsFine) {
      throw new MocaCommandError(response.status, response.message, { result });
    }
    return options.format === 'full' ? result : rows;
  }

  async #post(
    query: string,
    environment: MocaEnvironment,
    autocommit: boolean,
    signal: AbortSignal | undefined,
  ): Promise<RawResponse> {
    const text = await this.#transport({
      url: this.#config.url,
      body: buildRequest(query, environment, autocommit),
      timeoutMs: this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ignoreSslIssues: this.#config.ignoreSslIssues ?? false,
      signal,
    });
    return parseResponse(text);
  }

  #environment(session: SessionState, extra: Record<string, string> | undefined): MocaEnvironment {
    const config = this.#config;
    return {
      USR_ID: config.username,
      SESSION_KEY: session.key,
      WH_ID: config.warehouse,
      DEVCOD: config.device,
      LOCALE_ID: config.locale || session.locale || undefined,
      ...extra,
    };
  }

  async #login(): Promise<{ state: SessionState; row: MocaRow }> {
    const { username, password } = this.#config;
    const command = `login user where usr_id = ${quoteMocaString(username)} and usr_pswd = ${quoteMocaString(password)}`;
    try {
      const response = await this.#post(command, { USR_ID: username }, false, undefined);
      if (response.status !== MOCA_STATUS.OK) {
        throw new MocaAuthError(
          `MOCA login failed with status ${response.status}${response.message ? `: ${response.message}` : ''}`,
          { status: response.status },
        );
      }
      const rawRow = toRows(response, false)[0];
      const key = pick(rawRow, 'session_key', 5);
      if (key === null) {
        throw new MocaAuthError('MOCA login succeeded but no session_key was returned', { status: MOCA_STATUS.OK });
      }
      return {
        state: { key, locale: pick(rawRow, 'locale_id', 2), createdAt: this.#now() },
        row: toRows(response, true)[0] ?? {},
      };
    } catch (error) {
      if (error instanceof MocaError) error.command = redactCommand(command);
      throw error;
    }
  }

  #resolve(opts: CallOptions): ResolvedOptions {
    const defaults = this.#config.defaults ?? {};
    return {
      format: opts.format ?? 'rows',
      convert: opts.convert ?? defaults.convert ?? true,
      noRowsIsError: opts.noRowsIsError ?? defaults.noRowsIsError ?? false,
      autocommit: opts.autocommit ?? defaults.autocommit ?? true,
      env: opts.env,
      signal: opts.signal,
    };
  }
}
