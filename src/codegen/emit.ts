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

/** A command as emitted: arguments renamed, filtered and de-duplicated, plus what was set aside. */
interface EmitCommand extends SnapshotCommand {
  /** The server listed a wildcard argument (`@*`, `*`, `x.*`): extra arguments pass through. */
  passThrough: boolean;
  /** Optional arguments that can only be passed on the MOCA stack, as `name (DTYPE)`. */
  stackOnly: string[];
}

/** Strips one leading `@+` or `@`: the server writes `@name` for "argument `name`, read from the stack". */
function bareArgName(name: string): string {
  return name.replace(/^@\+?/, '');
}

/** `@*`, `*`, `@+*`, `foo.*`, `@+invdtl.*`: "pass through whatever stack/where arguments are present". */
function isWildcardArg(name: string): boolean {
  const bare = bareArgName(name);
  return bare === '*' || bare.endsWith('.*');
}

type ArgsOutcome = { skip: string } | { args: SnapshotArg[]; passThrough: boolean; stackOnly: string[]; warnings: string[] };

/** Applies the argument rules of spec §11 to one command's raw server arguments. */
function normalizeArgs(command: SnapshotCommand): ArgsOutcome {
  const badRequired = command.args.find(
    (arg) => arg.required && !isWildcardArg(arg.name) && !isMocaArgName(bareArgName(arg.name)),
  );
  if (badRequired !== undefined) {
    return {
      skip: `Command ${str(command.name)} requires argument ${str(badRequired.name)}, which is not a valid MOCA argument name; skipped the command`,
    };
  }

  const warnings: string[] = [];
  const seen = new Map<string, string>();
  const args: SnapshotArg[] = [];
  const stackOnly: string[] = [];
  let passThrough = false;
  for (const arg of command.args) {
    if (isWildcardArg(arg.name)) {
      passThrough = true;
      continue;
    }
    const name = bareArgName(arg.name);
    if (!isMocaArgName(name)) {
      warnings.push(`Command ${str(command.name)} argument ${str(arg.name)} is not a valid MOCA argument name; dropped the argument`);
      continue;
    }
    const key = name.toLowerCase();
    const firstRaw = seen.get(key);
    if (firstRaw !== undefined) {
      // `wh_id` next to `@wh_id` is the same argument listed both ways; only a repeat of the same
      // spelling (ignoring case) is worth a warning.
      if (firstRaw.toLowerCase() === arg.name.toLowerCase()) {
        warnings.push(`Command ${str(command.name)} lists argument ${str(arg.name)} more than once; kept the first`);
      }
      continue;
    }
    seen.set(key, arg.name);
    if (classifyMocaType(arg.dtype) === 'stack') {
      if (arg.required) {
        return {
          skip: `Command ${str(command.name)} requires stack argument ${str(name)} (${arg.dtype}); skipped (run it with exec())`,
        };
      }
      stackOnly.push(`${name} (${doc(arg.dtype)})`);
      continue;
    }
    args.push(name === arg.name ? arg : { ...arg, name });
  }
  return { args, passThrough, stackOnly, warnings };
}

/**
 * Drops repeated commands (same name ignoring case and whitespace runs), keeping the one whose name
 * sorts lowest, and applies the argument rules of `normalizeArgs`: a leading `@`/`@+` is stripped;
 * wildcard arguments are removed and mark the command as pass-through; optional stack-typed
 * arguments are set aside; repeated names (ignoring case) keep the first; names `renderCommand`
 * would reject (not `[A-Za-z_][A-Za-z0-9_]*`) are dropped when optional. A command with an invalid
 * or stack-typed *required* argument could never be called this way, so it is skipped entirely.
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
    result.push({ ...command, args: outcome.args, passThrough: outcome.passThrough, stackOnly: outcome.stackOnly });
  }
  return { commands: result, warnings };
}

function emitArgsInterface(name: string, args: SnapshotArg[]): string[] {
  const lines = [`export interface ${name} {`];
  for (const arg of args) {
    const summary = doc([arg.description, arg.dtype ? `(${arg.dtype})` : ''].filter(Boolean).join(' '));
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
  if (command.passThrough) notes.push('Accepts additional arguments (@*): pass them via opts.extraArgs.');
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
