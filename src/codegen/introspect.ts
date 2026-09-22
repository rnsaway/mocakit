import type { MocaClient } from '../client/client.js';
import { MocaCommandError } from '../errors.js';
import type { CommandSpec, MocaRow, MocaValue } from '../types.js';
import { redactUrl } from '../util/url.js';
import type { Snapshot, SnapshotArg, SnapshotCommand } from './snapshot.js';

// Candidate column names, first match wins (case-insensitive). Confirmed against a live server in Task 21.
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

type ColumnMap<K extends string> = Record<K, string | undefined>;

function resolveColumns<K extends string>(
  rows: MocaRow[],
  candidates: Record<K, string[]>,
  required: K[],
  source: string,
): ColumnMap<K> {
  const keys = Object.keys(rows[0] ?? {});
  const resolved = {} as ColumnMap<K>;
  for (const field of Object.keys(candidates) as K[]) {
    resolved[field] = candidates[field]
      .map((candidate) => keys.find((key) => key.toLowerCase() === candidate))
      .find((key) => key !== undefined);
    if (resolved[field] === undefined && required.includes(field)) {
      throw new Error(
        `Could not find the ${field} column in "${source}" output; received columns: ${keys.join(', ')}. ` +
          `Add the right name to the candidates in src/codegen/introspect.ts.`,
      );
    }
  }
  return resolved;
}

const text = (value: MocaValue | undefined): string =>
  value === null || value === undefined || Array.isArray(value) ? '' : String(value).trim();

function get(row: MocaRow, column: string | undefined): string {
  return column === undefined ? '' : text(row[column]);
}

function toArgs(rows: MocaRow[], columns: ColumnMap<keyof typeof ARG_COLUMNS>): Map<string, SnapshotArg[]> {
  const byCommand = new Map<string, SnapshotArg[]>();
  for (const row of rows) {
    const command = get(row, columns.command);
    const name = get(row, columns.name);
    if (name === '') continue;
    const args = byCommand.get(command) ?? [];
    if (args.some((arg) => arg.name === name)) continue;
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

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function loadArgs(client: MocaClient, commandNames: string[], concurrency: number): Promise<Map<string, SnapshotArg[]>> {
  let rows: MocaRow[];
  try {
    rows = await client.exec('list active command arguments');
  } catch (error) {
    if (!(error instanceof MocaCommandError)) throw error;
    const byCommand = new Map<string, SnapshotArg[]>();
    await mapPool(commandNames, concurrency, async (command) => {
      const commandRows = await client.call(ARGS_BY_COMMAND, { command });
      if (commandRows.length === 0) return;
      const columns = resolveColumns<keyof typeof ARG_COLUMNS>(commandRows, ARG_COLUMNS, ['name'], ARGS_BY_COMMAND[0]);
      const args = toArgs(commandRows, { ...columns, command: undefined }).get('') ?? [];
      byCommand.set(command, args);
    });
    return byCommand;
  }
  if (rows.length === 0) return new Map();
  return toArgs(rows, resolveColumns<keyof typeof ARG_COLUMNS>(rows, ARG_COLUMNS, ['command', 'name'], 'list active command arguments'));
}

export async function introspect(client: MocaClient, options: IntrospectOptions): Promise<Snapshot> {
  const commandRows = await client.exec('list active commands');
  if (commandRows.length === 0) throw new Error('"list active commands" returned no commands');
  const columns = resolveColumns<keyof typeof COMMAND_COLUMNS>(commandRows, COMMAND_COLUMNS, ['name'], 'list active commands');

  const commands = new Map<string, SnapshotCommand>();
  for (const row of commandRows) {
    const name = get(row, columns.name);
    if (name === '' || commands.has(name)) continue;
    const command: SnapshotCommand = { name, args: [] };
    for (const field of ['level', 'type', 'description'] as const) {
      const value = get(row, columns[field]);
      if (value !== '') command[field] = value;
    }
    commands.set(name, command);
  }

  const argsByCommand = await loadArgs(client, [...commands.keys()], options.concurrency ?? 8);
  for (const [name, command] of commands) command.args = argsByCommand.get(name) ?? [];

  return {
    mocakitVersion: options.version,
    generatedAt: new Date().toISOString(),
    server: redactUrl(options.server),
    commands: [...commands.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}
