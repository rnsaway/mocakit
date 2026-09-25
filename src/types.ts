import type { SessionStore } from './session/store.js';

/** Column metadata from a moca-results `<metadata>` block. */
export interface MocaColumn {
  name: string;
  type?: string;
  length?: number;
}

/** A converted cell value. Nested result sets become nested row arrays. */
export type MocaValue = string | number | boolean | null | MocaRow[];

/** One result row, keyed by column name exactly as MOCA returns it. */
export interface MocaRow {
  [column: string]: MocaValue;
}

/** A value accepted as a command argument. `null` and `undefined` remove the argument. */
export type MocaArgValue = string | number | boolean | Date | null | undefined;

export interface MocaResult<T = MocaRow> {
  status: number;
  message: string | null;
  columns: MocaColumn[];
  rows: T[];
}

export interface CallOptions {
  /** `'rows'` (default) resolves to `T[]`; `'full'` resolves to `MocaResult<T>`. */
  format?: 'rows' | 'full';
  /** Convert values using column metadata (numbers, booleans). Default `true`. */
  convert?: boolean;
  /** Throw on status 510 instead of returning no rows. Default `false`. */
  noRowsIsError?: boolean;
  /**
   * Run the command, then roll back everything it wrote, still returning its rows. The MOCA
   * text is wrapped in `try { ... } finally { try { [rollback] } catch (@?) { noop } }` (sent with
   * `autocommit="true"` like every request, so if the wrapper itself fails MOCA rolls back). A
   * command that commits internally cannot be undone. Per call only. Default `false`.
   */
  dryRun?: boolean;
  /** Extra or overriding environment variables for this call. */
  env?: Record<string, string>;
  /** Arguments the command spec does not declare, appended to the where clause. */
  extraArgs?: Readonly<Record<string, MocaArgValue>>;
  signal?: AbortSignal;
}

export type RowsOptions = CallOptions & { format?: 'rows' };
export type FullOptions = CallOptions & { format: 'full' };

/**
 * Options for `moca.batch()`: every `CallOptions` field except `extraArgs` and `noRowsIsError`. A
 * batch always treats status 510 as an error, because MOCA rolls the whole request back when any
 * step finds no rows.
 */
export type BatchOptions = Omit<CallOptions, 'extraArgs' | 'noRowsIsError'>;

/**
 * Client-wide call defaults. There is deliberately no `autocommit` (removed in 0.2.0: every
 * request commits at its end, or rolls back on error) and no `dryRun` (per call only).
 */
export type ClientDefaults = Pick<CallOptions, 'convert' | 'noRowsIsError'>;

/** `[argument name, MOCA dtype, required (1) or optional (0)]` */
export type ArgSpec = readonly [name: string, dtype: string, required: 0 | 1];
/** `[MOCA command name, declared arguments]` */
export type CommandSpec = readonly [command: string, args: readonly ArgSpec[]];

/** Argument type for commands that declare no arguments. */
export type NoArgs = Record<string, never>;

export interface MocaConfig {
  url: string;
  username: string;
  password: string;
  /** Sent as `WH_ID`. */
  warehouse?: string;
  /** Sent as `DEVCOD`. */
  device?: string;
  /** Sent as `LOCALE_ID`; falls back to the locale returned at login. */
  locale?: string;
  ignoreSslIssues?: boolean;
  /** Per HTTP request. Default 300000. */
  timeoutMs?: number;
  session?: {
    /** Share cached sessions across clients with the same credentials. Default `true`. */
    reuse?: boolean;
    /** Default 30. `0` or any negative value reuses a session until the server rejects it. */
    maxAgeMinutes?: number;
    /**
     * Defaults to a process-wide in-memory store. Cannot be combined with `reuse: false`
     * (throws `MocaArgumentError`). A persistent store holds live session keys as its values,
     * so protect it like a credential.
     */
    store?: SessionStore;
  };
  defaults?: ClientDefaults;
}

export interface SessionInfo {
  active: boolean;
  locale: string | null;
  ageMs: number | null;
}
