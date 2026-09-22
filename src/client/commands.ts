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

/** Installs one non-enumerable method per spec on `proto`, each calling `this.call(spec, args, opts)`. */
export function defineCommands(proto: MocaClient, specs: Readonly<Record<string, CommandSpec>>): void {
  const entries = Object.entries(specs);
  for (const [name] of entries) {
    if (name in proto) {
      throw new Error(
        `Cannot define command method "${name}": the name is already a member of the client; regenerate the client with the installed mocakit version`,
      );
    }
  }
  for (const [name, spec] of entries) {
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
