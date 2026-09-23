import type { MocaClient } from '../client/client.js';
import { MocaCommandError } from '../errors.js';
import type { CommandSpec, MocaColumn, MocaResult, MocaRow, MocaValue } from '../types.js';
import { redactUrl } from '../util/url.js';
import { byCodeUnit, commandKey, isValidCommandName } from './names.js';
import type { Snapshot, SnapshotArg, SnapshotCommand } from './snapshot.js';

// Candidate column names, first match wins (case-insensitive). Confirmed against a live server:
// - `list active commands` returns cmplvl, cmplvlseq, command, cmdtyp, type, syntax, class, functn,
//   security, trnstyp, filename, desc, api_level. We read command, cmplvl, type (e.g. "Local Syntax",
//   "Java Method") and desc.
// - `list active command arguments` returns cmplvl, command, argnam, altnam, argtyp, fixval, argidx,
//   argreq. argreq is an `O` (boolean) column. The unfiltered call works; the per-command fallback
//   below is for servers where it does not. argtyp is one of STRING, INTEGER, FLOAT, FLAG, UNKNOWN,
//   POINTER, RESULTS, OBJECT, BINARY (see moca-types.ts).
// The other candidates are kept for older or customised servers.
// argnam is stored raw: it may be `@*`, `*`, `x.*` (pass-through wildcards) or `@name` (the argument
// `name`, read from the stack). emit() interprets those; the snapshot keeps what the server said.
const COMMAND_COLUMNS = {
  name: ['command', 'cmd_nam', 'cmdnam', 'command_name', 'name'],
  level: ['cmplvl', 'cmp_lvl', 'level', 'component_level', 'lvl'],
  type: ['type', 'cmdtyp', 'cmd_typ', 'command_type'],
  description: ['description', 'desc', 'cmd_desc', 'cmddsc', 'dsc'],
};

const ARG_COLUMNS = {
  command: ['command', 'cmd_nam', 'cmdnam', 'command_name'],
  name: ['argnam', 'arg_nam', 'argument', 'argument_name', 'name'],
  dtype: ['dtype', 'datatype', 'data_type', 'argtyp', 'arg_typ', 'type'],
  required: ['argreq', 'reqflg', 'req_flg', 'required', 'argreqflg'],
  description: ['argdsc', 'arg_dsc', 'description', 'desc'],
};

const ARGS_BY_COMMAND: CommandSpec = ['list active command arguments', [['command', 'S', 1]]];
const TRUE_FLAGS = new Set(['1', 'y', 'yes', 't', 'true']);

export interface IntrospectOptions {
  version: string;
  server: string;
  /** Parallel per-command argument queries in fallback mode. Default 8. */
  concurrency?: number;
}

export interface IntrospectResult {
  snapshot: Snapshot;
  /** Commands that were skipped (e.g. names that are not valid MOCA command names). */
  warnings: string[];
}

type ColumnMap<K extends string> = Record<K, string | undefined>;

/**
 * Resolves each logical field to a received column name (case-insensitively, first candidate
 * wins), then rejects the whole set if two different fields resolved to the same column -- that
 * almost certainly means a candidate list is wrong, and silently picking one would misattribute
 * data.
 */
export function resolveColumns<K extends string>(
  columnNames: string[],
  candidates: Record<K, string[]>,
  required: K[],
  source: string,
): ColumnMap<K> {
  const resolved = {} as ColumnMap<K>;
  const resolvedBy = new Map<string, K>();
  for (const field of Object.keys(candidates) as K[]) {
    const match = candidates[field]
      .map((candidate) => columnNames.find((key) => key.toLowerCase() === candidate))
      .find((key) => key !== undefined);
    resolved[field] = match;
    if (match === undefined) {
      if (required.includes(field)) {
        throw new Error(
          `Could not find the ${field} column in "${source}" output; received columns: ${columnNames.join(', ')}. ` +
            `Add the right name to the candidates in src/codegen/introspect.ts.`,
        );
      }
      continue;
    }
    const matchKey = match.toLowerCase();
    const priorField = resolvedBy.get(matchKey);
    if (priorField !== undefined) {
      throw new Error(
        `Columns "${priorField}" and "${field}" both resolved to "${match}" in "${source}" output; received columns: ` +
          `${columnNames.join(', ')}. Add distinct candidates in src/codegen/introspect.ts.`,
      );
    }
    resolvedBy.set(matchKey, field);
  }
  return resolved;
}

const text = (value: MocaValue | undefined): string =>
  value === null || value === undefined || Array.isArray(value) ? '' : String(value).trim();

function get(row: MocaRow, column: string | undefined): string {
  return column === undefined ? '' : text(row[column]);
}

/** Collapses internal whitespace and trims, so "List  Orders" and "list orders" compare equal. */
function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function toArgs(rows: MocaRow[], columns: ColumnMap<keyof typeof ARG_COLUMNS>): Map<string, SnapshotArg[]> {
  const byCommand = new Map<string, SnapshotArg[]>();
  for (const row of rows) {
    const command = commandKey(get(row, columns.command));
    const name = get(row, columns.name);
    if (name === '') continue;
    const nameKey = name.toLowerCase();
    const args = byCommand.get(command) ?? [];
    if (args.some((arg) => arg.name.toLowerCase() === nameKey)) continue;
    const arg: SnapshotArg = {
      name,
      dtype: get(row, columns.dtype),
      required: TRUE_FLAGS.has(get(row, columns.required).toLowerCase()),
    };
    const description = get(row, columns.description);
    if (description !== '') arg.description = description;
    args.push(arg);
    byCommand.set(command, args);
  }
  return byCommand;
}

/** Resolves `ARG_COLUMNS` and converts `rows` in one step. When `includeCommand` is false, every
 * row is treated as belonging to a single (unnamed) command -- used for the per-command queries,
 * whose result carries no command column of its own. */
function parseArgs(rows: MocaRow[], columnNames: string[], source: string, includeCommand: boolean): Map<string, SnapshotArg[]> {
  const required: Array<keyof typeof ARG_COLUMNS> = includeCommand ? ['command', 'name'] : ['name'];
  const columns = resolveColumns<keyof typeof ARG_COLUMNS>(columnNames, ARG_COLUMNS, required, source);
  return toArgs(rows, includeCommand ? columns : { ...columns, command: undefined });
}

/** Runs `fn` over `items` with up to `limit` in flight at once. As soon as any call throws, no
 * further calls are started (already in-flight ones are not cancelled by this alone -- see the
 * shared AbortController in `loadArgs`), and that first error is rethrown once every in-flight
 * call has settled. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw firstError;
  return results;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadArgs(client: MocaClient, commandNames: string[], concurrency: number): Promise<Map<string, SnapshotArg[]>> {
  let originalError: unknown;
  let unfiltered: MocaResult<MocaRow> | undefined;
  try {
    unfiltered = await client.exec('list active command arguments', { format: 'full' });
  } catch (error) {
    if (!(error instanceof MocaCommandError)) throw error;
    originalError = error;
  }

  if (unfiltered !== undefined && unfiltered.rows.length > 0) {
    const columnNames = unfiltered.columns.map((c) => c.name);
    return parseArgs(unfiltered.rows, columnNames, 'list active command arguments', true);
  }

  // The unfiltered call either failed outright or (some servers do this) returned no rows at
  // all. Either way, probe with a single per-command query before fanning out to every command:
  // if even that fails, there is no point issuing the rest, and the combined error is far more
  // actionable than N identical per-command failures.
  if (commandNames.length === 0) return new Map();
  const [probeCommand, ...rest] = commandNames as [string, ...string[]];

  let probeResult: MocaResult<MocaRow>;
  try {
    probeResult = await client.call(ARGS_BY_COMMAND, { command: probeCommand }, { format: 'full' });
  } catch (probeError) {
    const unfilteredDescription = originalError !== undefined ? describeError(originalError) : 'returned no rows';
    throw new Error(
      `"list active command arguments" failed unfiltered (${unfilteredDescription}) and per command (${describeError(probeError)})`,
      { cause: originalError },
    );
  }

  const byCommand = new Map<string, SnapshotArg[]>();
  const applyPerCommand = (command: string, rows: MocaRow[], columns: MocaColumn[]): void => {
    if (rows.length === 0) return;
    const args = parseArgs(rows, columns.map((c) => c.name), ARGS_BY_COMMAND[0], false).get('') ?? [];
    if (args.length > 0) byCommand.set(commandKey(command), args);
  };
  applyPerCommand(probeCommand, probeResult.rows, probeResult.columns);

  const controller = new AbortController();
  await mapPool(rest, concurrency, async (command) => {
    try {
      const result = await client.call(ARGS_BY_COMMAND, { command }, { format: 'full', signal: controller.signal });
      applyPerCommand(command, result.rows, result.columns);
    } catch (error) {
      controller.abort();
      throw error;
    }
  });

  return byCommand;
}

export async function introspect(client: MocaClient, options: IntrospectOptions): Promise<IntrospectResult> {
  if (options.concurrency !== undefined && (!Number.isInteger(options.concurrency) || options.concurrency < 1)) {
    throw new RangeError('IntrospectOptions.concurrency must be an integer >= 1');
  }

  const commandResult = await client.exec('list active commands', { format: 'full' });
  const commandColumnNames = commandResult.columns.map((c) => c.name);
  // No column metadata at all (a bare no-rows response) means there is nothing to introspect --
  // report that directly instead of a confusing "could not find the name column" with an empty
  // column list.
  if (commandColumnNames.length === 0) throw new Error('"list active commands" returned no commands');
  const columns = resolveColumns<keyof typeof COMMAND_COLUMNS>(commandColumnNames, COMMAND_COLUMNS, ['name'], 'list active commands');

  const warnings: string[] = [];
  const commands = new Map<string, SnapshotCommand>();
  for (const row of commandResult.rows) {
    const name = normalizeName(get(row, columns.name));
    if (name === '') continue;
    // Names outside MOCA's usual character set (quotes, semicolons, comment markers, ...) are
    // never queried or emitted: they would end up inside MOCA text and generated source.
    if (!isValidCommandName(name)) {
      warnings.push(`Skipped command ${JSON.stringify(name)}: not a valid MOCA command name`);
      continue;
    }
    const key = commandKey(name);
    if (commands.has(key)) continue;
    const command: SnapshotCommand = { name, args: [] };
    for (const field of ['level', 'type', 'description'] as const) {
      const value = get(row, columns[field]);
      if (value !== '') command[field] = value;
    }
    commands.set(key, command);
  }
  if (commands.size === 0) throw new Error('"list active commands" returned no commands');

  const argsByCommand = await loadArgs(
    client,
    [...commands.values()].map((c) => c.name),
    options.concurrency ?? 8,
  );
  for (const [key, command] of commands) command.args = argsByCommand.get(key) ?? [];

  return {
    snapshot: {
      mocakitVersion: options.version,
      generatedAt: new Date().toISOString(),
      server: redactUrl(options.server),
      commands: [...commands.values()].sort((a, b) => byCodeUnit(a.name, b.name)),
    },
    warnings,
  };
}
