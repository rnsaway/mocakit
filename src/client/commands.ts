// Generated clients type their commands through these shared callable interfaces instead of emitting
// overloads per method; that keeps type-checking a large generated file cheap.
//
// Requires TypeScript >= 5.4 in consuming projects (`NoInfer`).

import type { Output } from '../index.js';
import type { CallOptions, CommandSpec, FullOptions, MocaResult, RowsOptions } from '../types.js';
import type { MocaClient } from './client.js';

/** A generated command method whose command declares at least one required argument. */
export interface Command<A, C extends string> {
  <T = Output<C>>(args: A, opts?: RowsOptions): Promise<NoInfer<T>[]>;
  <T = Output<C>>(args: A, opts: FullOptions): Promise<MocaResult<NoInfer<T>>>;
  <T = Output<C>>(args: A, opts?: CallOptions): Promise<NoInfer<T>[] | MocaResult<NoInfer<T>>>;
}

/** A generated command method whose arguments are all optional (or that takes none). */
export interface OptionalArgsCommand<A, C extends string> {
  <T = Output<C>>(args?: A, opts?: RowsOptions): Promise<NoInfer<T>[]>;
  <T = Output<C>>(args: A | undefined, opts: FullOptions): Promise<MocaResult<NoInfer<T>>>;
  <T = Output<C>>(args?: A, opts?: CallOptions): Promise<NoInfer<T>[] | MocaResult<NoInfer<T>>>;
}

/**
 * Installs one non-enumerable method per spec on `proto`, each calling `this.call(spec, args, opts)`.
 *
 * A name that already exists anywhere on `proto`'s prototype chain (a `MocaClient` member added
 * in a newer mocakit than the one that generated the client, or an `Object.prototype` name) is
 * skipped with a process warning rather than overwriting that member or throwing at import time.
 * The generator never emits such names itself; regenerating with the installed mocakit renames
 * the command (e.g. `cmdExec`).
 */
export function defineCommands(proto: MocaClient, specs: Readonly<Record<string, CommandSpec>>): void {
  for (const [name, spec] of Object.entries(specs)) {
    if (name in proto) {
      process.emitWarning(
        `mocakit: generated command "${name}" clashes with a MocaClient member and was not installed; regenerate the client with the installed mocakit version`,
      );
      continue;
    }
    Object.defineProperty(proto, name, {
      value: function (this: MocaClient, args?: object, opts?: CallOptions) {
        return this.call(spec, args, opts);
      },
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
