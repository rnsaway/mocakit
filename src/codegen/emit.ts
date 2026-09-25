import { classifyMocaType } from '../protocol/moca-types.js';
import { redactUrl } from '../util/url.js';
import { isMocaArgName } from '../util/text.js';
import { assignMethodNames, byCodeUnit, commandKey, isIdentifier, toPascal } from './names.js';
import type { Snapshot, SnapshotArg, SnapshotCommand } from './snapshot.js';

export interface EmitOptions {
  version: string;
  /** Module specifier for the runtime. Default `mocakit`; tests point it at `src/index.js`. */
  importFrom?: string;
}

export interface EmitResult {
  code: string;
  warnings: string[];
  /** Number of commands emitted, after de-duplication and skipped commands. */
  count: number;
}

const str = (value: string): string => JSON.stringify(value);

/** Makes server text safe inside a JSDoc comment: no terminator, no tags, one line. */
function doc(text: string): string {
  return text
    .replace(/\*\//g, '*\\/')
    .replace(/(^|[^\w\\])@/g, '$1\\@')
    .replace(/\s+/g, ' ')
    .trim();
}

function tsType(dtype: string): string {
  switch (classifyMocaType(dtype)) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'string | Date';
    case 'any':
      return 'string | number | boolean | Date';
    default:
      return 'string';
  }
}

function propertyName(name: string): string {
  return isIdentifier(name) && name !== '__proto__' ? name : str(name);
}

/**
 * An argument as emitted. `required` is *effective* requiredness: flagged by the server and enforced
 * by MOCA for this command's type. `notEnforced` marks a flagged argument MOCA does not enforce.
 */
interface EmitArg extends SnapshotArg {
  notEnforced?: boolean;
}

/** A command as emitted: arguments renamed, filtered and de-duplicated, plus what was set aside. */
interface EmitCommand extends SnapshotCommand {
  args: EmitArg[];
  /** The first wildcard argument (`@*`, `*`, `x.*`) the server listed, raw: extra arguments pass through. */
  wildcard: string | undefined;
  /** Optional arguments that can only be passed on the MOCA stack, as `name (DTYPE)`. */
  stackOnly: string[];
}

/** Strips one leading `@+` or `@`: the server writes `@name` for "argument `name`, read from the stack". */
function bareArgName(name: string): string {
  return name.replace(/^@\+?/, '');
}

/** `@*`, `*`, `@+*`, `foo.*`, `@+widget.*`: "pass through whatever stack/where arguments are present". */
function isWildcardArg(name: string): boolean {
  const bare = bareArgName(name);
  return bare === '*' || bare.endsWith('.*');
}

const isStackArg = (arg: SnapshotArg): boolean => classifyMocaType(arg.dtype) === 'stack';

/**
 * MOCA enforces `argreq` (status 507 when a flagged argument is missing) only for compiled
 * commands: C Function, Simple C Function, Java Method. Local Syntax scripts get no check, so a
 * flagged argument there is really optional. A command without a type (older snapshots) keeps the
 * conservative reading: flagged means required.
 */
function enforcesRequired(command: SnapshotCommand): boolean {
  return command.type?.trim().toLowerCase() !== 'local syntax';
}

type ArgsOutcome =
  | { skip: string }
  | { args: EmitArg[]; wildcard: string | undefined; stackOnly: string[]; warnings: string[] };

/** Applies the argument rules of spec §11 to one command's raw server arguments. */
function normalizeArgs(command: SnapshotCommand): ArgsOutcome {
  const enforced = enforcesRequired(command);
  const badRequired = command.args.find(
    (arg) => arg.required && enforced && !isWildcardArg(arg.name) && !isMocaArgName(bareArgName(arg.name)),
  );
  if (badRequired !== undefined) {
    return {
      skip: `Command ${str(command.name)} requires argument ${str(badRequired.name)}, which is not a valid MOCA argument name; skipped the command`,
    };
  }

  // Pass 1: rename, drop wildcards and invalid names, and merge entries that share a bare name.
  const warnings: string[] = [];
  const merged: SnapshotArg[] = [];
  const byKey = new Map<string, { index: number; raw: string }>();
  let wildcard: string | undefined;
  for (const arg of command.args) {
    if (isWildcardArg(arg.name)) {
      wildcard ??= arg.name;
      continue;
    }
    const name = bareArgName(arg.name);
    if (!isMocaArgName(name)) {
      warnings.push(`Command ${str(command.name)} argument ${str(arg.name)} is not a valid MOCA argument name; dropped the argument`);
      continue;
    }
    const renamed = name === arg.name ? arg : { ...arg, name };
    const key = name.toLowerCase();
    const first = byKey.get(key);
    if (first === undefined) {
      byKey.set(key, { index: merged.length, raw: arg.name });
      merged.push(renamed);
      continue;
    }
    // `wh_id` next to `@wh_id` is the same argument listed both ways; only a repeat of the same
    // spelling (ignoring case) is worth a warning.
    if (first.raw.toLowerCase() === arg.name.toLowerCase()) {
      warnings.push(`Command ${str(command.name)} lists argument ${str(arg.name)} more than once; kept the first`);
    }
    // Keep the first entry's name and dtype, unless it is stack-typed and this one isn't; the
    // argument is required if either entry says so.
    const kept = merged[first.index] as SnapshotArg;
    const base = isStackArg(kept) && !isStackArg(renamed) ? renamed : kept;
    merged[first.index] = { ...base, required: kept.required || renamed.required };
  }

  // Pass 2: apply effective requiredness, and set aside stack-typed arguments.
  const args: EmitArg[] = [];
  const stackOnly: string[] = [];
  for (const flagged of merged) {
    const arg: EmitArg = flagged.required && !enforced ? { ...flagged, required: false, notEnforced: true } : flagged;
    if (!isStackArg(arg)) {
      args.push(arg);
      continue;
    }
    if (arg.required) {
      return {
        skip: `Command ${str(command.name)} requires stack argument ${str(arg.name)} (${arg.dtype}); skipped (run it with exec())`,
      };
    }
    stackOnly.push(`${arg.name} (${doc(arg.dtype)})`);
  }
  return { args, wildcard, stackOnly, warnings };
}

/**
 * Drops repeated commands (same name ignoring case and whitespace runs), keeping the one whose name
 * sorts lowest, and applies the argument rules of `normalizeArgs`: a leading `@`/`@+` is stripped;
 * wildcard arguments are removed and mark the command as pass-through; optional stack-typed
 * arguments are set aside; repeated names (ignoring case) merge into the first entry (see
 * `normalizeArgs`); names `renderCommand` would reject (not `[A-Za-z_][A-Za-z0-9_]*`) are dropped when optional. "Required" means
 * effectively required: flagged by the server on a command whose type MOCA enforces it for (not
 * Local Syntax). A command with an invalid or stack-typed *required* argument could never be called
 * this way, so it is skipped entirely.
 * Returns the commands sorted by name, so the output does not depend on input order.
 */
function normalizeCommands(commands: readonly SnapshotCommand[]): { commands: EmitCommand[]; warnings: string[] } {
  const warnings: string[] = [];
  const sorted = [...commands].sort(
    (a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(JSON.stringify(a), JSON.stringify(b)),
  );
  const kept = new Map<string, SnapshotCommand>();
  const result: EmitCommand[] = [];
  for (const command of sorted) {
    const outcome = normalizeArgs(command);
    if ('skip' in outcome) {
      warnings.push(outcome.skip);
      continue;
    }

    const key = commandKey(command.name);
    const existing = kept.get(key);
    if (existing !== undefined) {
      warnings.push(`Command ${str(command.name)} duplicates ${str(existing.name)}; kept ${str(existing.name)}`);
      continue;
    }
    kept.set(key, command);
    warnings.push(...outcome.warnings);
    result.push({ ...command, args: outcome.args, wildcard: outcome.wildcard, stackOnly: outcome.stackOnly });
  }
  return { commands: result, warnings };
}

const NOT_ENFORCED_NOTE = 'marked required by MOCA; not enforced for Local Syntax commands';

function emitArgsInterface(name: string, args: EmitArg[]): string[] {
  const lines = [`export interface ${name} {`];
  for (const arg of args) {
    const described = doc([arg.description, arg.dtype ? `(${arg.dtype})` : ''].filter(Boolean).join(' '));
    const summary = arg.notEnforced ? [described, NOT_ENFORCED_NOTE].filter(Boolean).join(' · ') : described;
    if (summary !== '') lines.push(`  /** ${summary} */`);
    const type = tsType(arg.dtype);
    lines.push(arg.required ? `  ${propertyName(arg.name)}: ${type};` : `  ${propertyName(arg.name)}?: ${type} | null;`);
  }
  lines.push('}', '');
  return lines;
}

function emitSpec(method: string, command: SnapshotCommand): string {
  const args = command.args.map((arg) => `[${str(arg.name)}, ${str(arg.dtype)}, ${arg.required ? 1 : 0}]`).join(', ');
  return `  ${method}: [${str(command.name)}, [${args}]],`;
}

function emitMember(method: string, argsType: string, command: EmitCommand): string[] {
  const hasRequired = command.args.some((arg) => arg.required);
  const summary = doc(
    [`\`${command.name.replace(/`/g, "'")}\``, command.level ? `level: ${command.level}` : '', command.description ?? '']
      .filter(Boolean)
      .join(' · '),
  );
  const notes: string[] = [];
  if (command.wildcard !== undefined) {
    notes.push(`Accepts additional arguments (wildcard: ${doc(command.wildcard)}): pass them via opts.extraArgs.`);
  }
  if (command.stackOnly.length > 0) notes.push(`Stack-only arguments not settable here: ${command.stackOnly.join(', ')}`);
  const callable = hasRequired ? 'mk.Command' : 'mk.OptionalArgsCommand';
  const jsdoc = notes.length === 0 ? [`  /** ${summary} */`] : ['  /**', ...[summary, ...notes].map((line) => `   * ${line}`), '   */'];
  return [...jsdoc, `  ${method}: ${callable}<${argsType}, ${str(command.name)}>;`];
}

export function emit(snapshot: Snapshot, options: EmitOptions): EmitResult {
  const normalized = normalizeCommands(snapshot.commands);
  const commands = normalized.commands;
  const { names, collisions } = assignMethodNames(commands.map((command) => command.name));
  const warnings = [
    ...normalized.warnings,
    ...collisions.map(
      (group) =>
        `Commands ${group.map(str).join(', ')} map to the same method name; generated ${group.map((c) => names.get(c)).join(', ')}`,
    ),
  ];

  const lines: string[] = [
    `// AUTO-GENERATED by mocakit ${options.version} from ${redactUrl(snapshot.server)} — ${commands.length} commands.`,
    '// Do not edit by hand; regenerate with `mocakit generate`.',
    '/* eslint-disable */',
    `import * as mk from ${str(options.importFrom ?? 'mocakit')};`,
    '',
  ];

  lines.push(
    commands.length === 0
      ? 'export type MocaCommandName = never;'
      : `export type MocaCommandName =\n${commands.map((c) => `  | ${str(c.name)}`).join('\n')};`,
    '',
  );

  const argTypes = new Map<string, string>();
  for (const command of commands) {
    const method = names.get(command.name) as string;
    if (command.args.length === 0) {
      argTypes.set(command.name, 'mk.NoArgs');
      continue;
    }
    const interfaceName = `${toPascal(method)}Args`;
    argTypes.set(command.name, interfaceName);
    lines.push(...emitArgsInterface(interfaceName, command.args));
  }

  lines.push('const S = {');
  for (const command of commands) lines.push(emitSpec(names.get(command.name) as string, command));
  lines.push('} as const satisfies Record<string, mk.CommandSpec>;', '');

  lines.push('export interface Moca extends mk.MocaClient {');
  for (const command of commands) {
    lines.push(...emitMember(names.get(command.name) as string, argTypes.get(command.name) as string, command));
  }
  lines.push('}', '', 'export class Moca extends mk.MocaClient {}', 'mk.defineCommands(Moca.prototype, S);', '');

  lines.push(
    'export function createMoca(config: mk.MocaConfig, deps?: mk.MocaClientDeps): Moca {',
    '  return new Moca(config, deps);',
    '}',
    '',
  );

  return { code: lines.join('\n'), warnings, count: commands.length };
}
