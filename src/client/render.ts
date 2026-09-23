import type { DateCodec } from '../dates/codec.js';
import { MocaArgumentError } from '../errors.js';
import type { CommandSpec, MocaArgValue } from '../types.js';
import { isMocaArgName } from '../util/text.js';

export function quoteMocaString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function checkName(name: string): string {
  if (!isMocaArgName(name)) throw new MocaArgumentError(`Invalid argument name "${name}"`, name);
  return name;
}

function renderValue(name: string, value: unknown, codec: DateCodec): string {
  if (typeof value === 'string') return quoteMocaString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MocaArgumentError(`Argument "${name}" must be a finite number`, name);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new MocaArgumentError(`Argument "${name}" exceeds safe integer range; pass it as a string`, name);
    }
    if (/e/i.test(String(value))) {
      throw new MocaArgumentError(
        `Argument "${name}" cannot be written without exponent notation; pass it as a string`,
        name,
      );
    }
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new MocaArgumentError(`Argument "${name}" is an invalid Date`, name);
    try {
      return quoteMocaString(codec.format(value));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MocaArgumentError(`Argument "${name}" cannot be sent as a MOCA date: ${message}`, name);
    }
  }
  throw new MocaArgumentError(`Argument "${name}" has unsupported type ${typeof value}`, name);
}

const isAbsent = (value: unknown): boolean => value === undefined || value === null;

const getOwn = (values: Record<string, unknown>, name: string): unknown =>
  Object.hasOwn(values, name) ? values[name] : undefined;

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
  const declaredLower = new Map(argSpecs.map(([name]) => [name.toLowerCase(), name]));
  const clauses: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (declared.has(key) || isAbsent(value)) continue;
    const canonical = declaredLower.get(key.toLowerCase());
    if (canonical !== undefined) {
      throw new MocaArgumentError(
        `Unknown argument "${key}" for "${command}"; use the declared spelling "${canonical}"`,
        key,
      );
    }
    throw new MocaArgumentError(`Unknown argument "${key}" for "${command}"; pass it in extraArgs`, key);
  }

  for (const [name, , required] of argSpecs) {
    const value = getOwn(values, name);
    if (isAbsent(value)) {
      if (required) throw new MocaArgumentError(`Missing required argument "${name}" for "${command}"`, name);
      continue;
    }
    clauses.push(`${checkName(name)} = ${renderValue(name, value, codec)}`);
  }

  const seenExtra = new Set<string>();
  for (const [name, value] of Object.entries(extraArgs ?? {})) {
    const lower = name.toLowerCase();
    if (declared.has(name) || declaredLower.has(lower)) {
      throw new MocaArgumentError(`Argument "${name}" is declared by "${command}"; pass it in args`, name);
    }
    if (seenExtra.has(lower)) {
      throw new MocaArgumentError(`Argument "${name}" in extraArgs duplicates another extraArgs key (case-insensitive)`, name);
    }
    seenExtra.add(lower);
    if (isAbsent(value)) continue;
    clauses.push(`${checkName(name)} = ${renderValue(name, value, codec)}`);
  }

  return clauses.length === 0 ? command : `${command} where ${clauses.join(' and ')}`;
}
