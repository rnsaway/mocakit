import type { DateCodec } from '../dates/codec.js';
import { MocaArgumentError } from '../errors.js';
import type { CommandSpec, MocaArgValue } from '../types.js';

const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteMocaString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function checkName(name: string): string {
  if (!ARG_NAME.test(name)) throw new MocaArgumentError(`Invalid argument name "${name}"`, name);
  return name;
}

function renderValue(name: string, value: unknown, codec: DateCodec): string {
  if (typeof value === 'string') return quoteMocaString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MocaArgumentError(`Argument "${name}" must be a finite number`, name);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new MocaArgumentError(`Argument "${name}" is an invalid Date`, name);
    return quoteMocaString(codec.format(value));
  }
  throw new MocaArgumentError(`Argument "${name}" has unsupported type ${typeof value}`, name);
}

const isAbsent = (value: unknown): boolean => value === undefined || value === null;

/** Renders `command where a = 'x' and b = 5`. `null`/`undefined` arguments are removed. */
export function renderCommand(
  spec: CommandSpec,
  args: object | undefined,
  extraArgs: Readonly<Record<string, MocaArgValue>> | undefined,
  codec: DateCodec,
): string {
  const [command, argSpecs] = spec;
  const values = (args ?? {}) as Record<string, unknown>;
  const declared = new Set(argSpecs.map(([name]) => name));
  const clauses: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (!declared.has(key) && !isAbsent(value)) {
      throw new MocaArgumentError(`Unknown argument "${key}" for "${command}"; pass it in extraArgs`, key);
    }
  }

  for (const [name, , required] of argSpecs) {
    const value = values[name];
    if (isAbsent(value)) {
      if (required) throw new MocaArgumentError(`Missing required argument "${name}" for "${command}"`, name);
      continue;
    }
    clauses.push(`${checkName(name)} = ${renderValue(name, value, codec)}`);
  }

  for (const [name, value] of Object.entries(extraArgs ?? {})) {
    if (declared.has(name)) {
      throw new MocaArgumentError(`Argument "${name}" is declared by "${command}"; pass it in args`, name);
    }
    if (isAbsent(value)) continue;
    clauses.push(`${checkName(name)} = ${renderValue(name, value, codec)}`);
  }

  return clauses.length === 0 ? command : `${command} where ${clauses.join(' and ')}`;
}
