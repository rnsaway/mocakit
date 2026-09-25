// Generated clients type their commands through these shared callable interfaces instead of emitting
// overloads per method; that keeps type-checking a large generated file cheap.
//
// Requires TypeScript >= 5.4 in consuming projects (`NoInfer`).

import { defaultDateCodec } from '../dates/codec.js';
import { MocaArgumentError, MocaError } from '../errors.js';
import type { Output } from '../index.js';
import type { CallOptions, CommandSpec, FullOptions, MocaResult, RowsOptions } from '../types.js';
import type { MocaClient } from './client.js';
import { renderCommand } from './render.js';

/**
 * Type-only brand telling `Command` and `OptionalArgsCommand` apart. The two are otherwise
 * structurally assignable to each other (TypeScript is lenient about optional parameters), so a
 * conditional type could not distinguish them. The property is optional and never exists at
 * runtime, so it changes nothing about how generated code type-checks.
 */
declare const commandKind: unique symbol;

/** A generated command method whose command declares at least one required argument. */
export interface Command<A, C extends string> {
  readonly [commandKind]?: 'required';
  <T = Output<C>>(args: A, opts?: RowsOptions): Promise<NoInfer<T>[]>;
  <T = Output<C>>(args: A, opts: FullOptions): Promise<MocaResult<NoInfer<T>>>;
  <T = Output<C>>(args: A, opts?: CallOptions): Promise<NoInfer<T>[] | MocaResult<NoInfer<T>>>;
}

/** A generated command method whose arguments are all optional (or that takes none). */
export interface OptionalArgsCommand<A, C extends string> {
  readonly [commandKind]?: 'optional';
  <T = Output<C>>(args?: A, opts?: RowsOptions): Promise<NoInfer<T>[]>;
  <T = Output<C>>(args: A | undefined, opts: FullOptions): Promise<MocaResult<NoInfer<T>>>;
  <T = Output<C>>(args?: A, opts?: CallOptions): Promise<NoInfer<T>[] | MocaResult<NoInfer<T>>>;
}

declare const batchStepBrand: unique symbol;

/** One command in a `moca.batch()`. Opaque: build it with the batch builder (`b.<command>()` or `b.raw()`). */
export interface BatchStep {
  /** The rendered MOCA text of this step. */
  readonly moca: string;
  readonly [batchStepBrand]: true;
}

/**
 * The builder handed to `moca.batch()`: every generated command of client type `C`, taking the same
 * arguments but returning a `BatchStep` instead of running, plus `raw(mocaText)`.
 */
export type BatchBuilder<C> = {
  readonly [K in keyof C as K extends 'raw' ? never : typeof commandKind extends keyof C[K] ? K : never]: C[K] extends OptionalArgsCommand<
    infer A,
    any // eslint-disable-line @typescript-eslint/no-explicit-any
  >
    ? (args?: A) => BatchStep
    : C[K] extends Command<infer A, any> // eslint-disable-line @typescript-eslint/no-explicit-any
      ? (args: A) => BatchStep
      : never;
} & {
  /** A step of raw MOCA text. The caller is responsible for quoting. */
  readonly raw: (mocaText: string) => BatchStep;
};

/** Module-private: the spec of each method installed by `defineCommands`. */
const specKey = Symbol('mocakit.commandSpec');

/** The `CommandSpec` attached to a method installed by `defineCommands`, or `undefined`. */
export function commandSpecOf(value: unknown): CommandSpec | undefined {
  if (typeof value !== 'function') return undefined;
  return Object.hasOwn(value, specKey) ? ((value as unknown as Record<symbol, CommandSpec>)[specKey]) : undefined;
}

const batchSteps = new WeakSet<object>();

function batchStep(moca: string): BatchStep {
  const step = Object.freeze({ moca }) as BatchStep;
  batchSteps.add(step);
  return step;
}

/** True only for steps created by a batch builder; look-alike objects are rejected. */
export function isBatchStep(value: unknown): value is BatchStep {
  return typeof value === 'object' && value !== null && batchSteps.has(value);
}

function rawStep(mocaText: string): BatchStep {
  if (typeof mocaText !== 'string' || mocaText.trim() === '') {
    throw new MocaArgumentError('b.raw() needs non-empty MOCA text', 'raw');
  }
  return batchStep(mocaText);
}

/**
 * A builder whose `raw` makes a raw step and whose every other property looks up the same name on
 * `client`: a method installed by `defineCommands` becomes a step factory that renders (and so
 * validates) its arguments immediately; anything else is `undefined`.
 */
export function batchBuilder<C extends MocaClient>(client: C): BatchBuilder<C> {
  const target = Object.create(null) as object;
  return new Proxy(target, {
    get(_target, name) {
      if (name === 'raw') return rawStep;
      const spec = commandSpecOf(Reflect.get(client, name));
      if (spec === undefined) return undefined;
      return (args?: object): BatchStep => {
        try {
          return batchStep(renderCommand(spec, args, undefined, defaultDateCodec));
        } catch (error) {
          if (error instanceof MocaError) {
            error.command ??= spec[0];
            error.args ??= { ...(args ?? {}) };
          }
          throw error;
        }
      };
    },
  }) as BatchBuilder<C>;
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
    const method = function (this: MocaClient, args?: object, opts?: CallOptions) {
      return this.call(spec, args, opts);
    };
    // Lets `moca.batch()` turn this method into a step factory (see `batchBuilder`).
    Object.defineProperty(method, specKey, { value: spec });
    Object.defineProperty(proto, name, {
      value: method,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
