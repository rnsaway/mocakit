import { defaultDateCodec } from '../dates/codec.js';
import { MocaAuthError, MocaCommandError, MocaError, redactCommand } from '../errors.js';
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

export class MocaClient {
  readonly #config: MocaConfig;
  readonly #transport: Transport;
  readonly #now: () => number;
  readonly #sessions: SessionManager;

  constructor(config: MocaConfig, deps: MocaClientDeps = {}) {
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

  /** Logs in now (fail fast) and returns the converted login row. */
  async login(): Promise<MocaRow> {
    const { state, row } = await this.#login();
    await this.#sessions.adopt(state);
    return row;
  }

  /** Sends `logout user` and evicts the cached session, even if the server call fails. */
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
      let session = await this.#sessions.acquire();
      let response = await this.#post(command, this.#environment(session, options.env), options.autocommit, options.signal);
      if (response.status === MOCA_STATUS.SESSION_EXPIRED) {
        await this.#sessions.invalidate(session);
        session = await this.#sessions.acquire();
        response = await this.#post(command, this.#environment(session, options.env), options.autocommit, options.signal);
        if (response.status === MOCA_STATUS.SESSION_EXPIRED) {
          throw new MocaAuthError('The MOCA session expired again immediately after logging in', {
            status: MOCA_STATUS.SESSION_EXPIRED,
          });
        }
      }
      return this.#shape(response, options);
    } catch (error) {
      if (error instanceof MocaError) {
        error.command ??= command;
        error.args ??= args;
      }
      throw error;
    }
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
