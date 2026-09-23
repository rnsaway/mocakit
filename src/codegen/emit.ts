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
    default:
      return 'string';
  }
}

function propertyName(name: string): string {
  return isIdentifier(name) && name !== '__proto__' ? name : str(name);
}

/**
 * Drops repeated commands (same name ignoring case and whitespace runs), keeping the one whose name
 * sorts lowest, and repeated argument names (ignoring case), keeping the first. Argument names that
 * `renderCommand` would reject (not `[A-Za-z_][A-Za-z0-9_]*`) are dropped when optional; a command
 * with such a *required* argument could never be called, so it is skipped entirely. Returns the
 * commands sorted by name, so the output does not depend on input order.
 */
function normalizeCommands(commands: readonly SnapshotCommand[]): { commands: SnapshotCommand[]; warnings: string[] } {
  const warnings: string[] = [];
  const sorted = [...commands].sort(
    (a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(JSON.stringify(a), JSON.stringify(b)),
  );
  const kept = new Map<string, SnapshotCommand>();
  const result: SnapshotCommand[] = [];
  for (const command of sorted) {
    const badRequired = command.args.find((arg) => arg.required && !isMocaArgName(arg.name));
    if (badRequired !== undefined) {
      warnings.push(
        `Command ${str(command.name)} requires argument ${str(badRequired.name)}, which is not a valid MOCA argument name; skipped the command`,
      );
      continue;
    }

    const key = commandKey(command.name);
    const existing = kept.get(key);
    if (existing !== undefined) {
      warnings.push(`Command ${str(command.name)} duplicates ${str(existing.name)}; kept ${str(existing.name)}`);
      continue;
    }
    kept.set(key, command);

    const seenArgs = new Set<string>();
    const args: SnapshotArg[] = [];
    for (const arg of command.args) {
      if (!isMocaArgName(arg.name)) {
        warnings.push(`Command ${str(command.name)} argument ${str(arg.name)} is not a valid MOCA argument name; dropped the argument`);
        continue;
      }
      const argKey = arg.name.toLowerCase();
      if (seenArgs.has(argKey)) {
        warnings.push(`Command ${str(command.name)} lists argument ${str(arg.name)} more than once; kept the first`);
        continue;
      }
      seenArgs.add(argKey);
      args.push(arg);
    }
    result.push(args.length === command.args.length ? command : { ...command, args });
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

function emitMember(method: string, argsType: string, command: SnapshotCommand): string[] {
  const hasRequired = command.args.some((arg) => arg.required);
  const summary = doc(
    [`\`${command.name.replace(/`/g, "'")}\``, command.level ? `level: ${command.level}` : '', command.description ?? '']
      .filter(Boolean)
      .join(' · '),
  );
  const callable = hasRequired ? 'mk.Command' : 'mk.OptionalArgsCommand';
  return [`  /** ${summary} */`, `  ${method}: ${callable}<${argsType}, ${str(command.name)}>;`];
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
