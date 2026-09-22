import type { MocaRow } from './types.js';

export { MOCA_STATUS, MocaClient, type MocaClientDeps } from './client/client.js';
export { defaultDateCodec, formatMocaDate, parseMocaDate, type DateCodec } from './dates/codec.js';
export { defineConfig, type MocakitConfig } from './define-config.js';
export {
  MocaArgumentError,
  MocaAuthError,
  MocaCommandError,
  MocaError,
  MocaProtocolError,
  MocaTransportError,
  isMocaStatus,
  redactArgs,
  redactCommand,
  type MocaErrorOptions,
} from './errors.js';
export { MemorySessionStore, sharedSessionStore, type SessionState, type SessionStore } from './session/store.js';
export { httpTransport, type Transport, type TransportRequest } from './transport/http.js';
export type {
  ArgSpec,
  CallOptions,
  ClientDefaults,
  CommandSpec,
  FullOptions,
  MocaArgValue,
  MocaColumn,
  MocaConfig,
  MocaResult,
  MocaRow,
  MocaValue,
  NoArgs,
  RowsOptions,
  SessionInfo,
} from './types.js';
export { VERSION } from './version.js';

/**
 * Registry of known output row shapes, keyed by MOCA command name. Extend it with module augmentation:
 *
 * ```ts
 * declare module 'mocakit' {
 *   interface MocaOutputs { 'list orders': { ordnum: string; ordqty: number } }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface MocaOutputs {}

/** Row type for a command: its registered shape, or `MocaRow`. */
export type Output<C extends string> = C extends keyof MocaOutputs ? MocaOutputs[C] : MocaRow;
