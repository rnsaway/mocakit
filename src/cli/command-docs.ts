import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { buildAgentModel, type CommandModel } from '../codegen/agent-model.js';
import { startsWithMarker } from '../codegen/docs-writer.js';
import { commandDocFile, emitCommandDocs } from '../codegen/emit-command-docs.js';
import { docFileName } from '../codegen/emit-schema-docs.js';
import { filterCommands } from '../codegen/filter.js';
import { readCommandDefinitions, type TriggerInfo } from '../codegen/introspect-agent.js';
import { commandKey } from '../codegen/names.js';
import type { Snapshot } from '../codegen/snapshot.js';
import type { CommandDocsConfig, MocakitConfig } from '../define-config.js';
import type { MocaRow } from '../types.js';

export interface ResolvedCommandDocs {
  out: string;
  filter: { include?: string[]; exclude?: string[]; levels?: string[] };
  source: 'custom' | 'all' | false;
  customLevels: string[];
  customTriggers: string[];
  triggers: boolean;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The command docs folder: the configured `commandDocs.out`, else `moca-commands` next to `out` (whether or not docs are on). */
export function commandDocsDir(config: MocakitConfig, configDir: string, out: string): string {
  const setting = config.commandDocs;
  const configured = isPlainObject(setting) ? (setting as CommandDocsConfig).out : undefined;
  return configured !== undefined ? resolve(configDir, configured) : resolve(dirname(out), 'moca-commands');
}

/** Command docs settings from config + CLI flag, or `null` when command docs are off. */
export function resolveCommandDocsSettings(
  config: MocakitConfig,
  flag: boolean | undefined,
  configDir: string,
  out: string,
): ResolvedCommandDocs | null {
  const setting = config.commandDocs;
  if (setting !== undefined && typeof setting !== 'boolean' && !isPlainObject(setting)) {
    throw new Error('config.commandDocs must be true, false or an object');
  }
  if (flag === false || (flag === undefined && !setting)) return null;
  const options: CommandDocsConfig = isPlainObject(setting) ? (setting as CommandDocsConfig) : {};
  if (options.source !== undefined && options.source !== 'custom' && options.source !== 'all' && options.source !== false) {
    throw new Error("commandDocs.source must be 'custom', 'all' or false");
  }
  return {
    out: commandDocsDir(config, configDir, out),
    filter: {
      include: options.include ?? config.include,
      exclude: options.exclude ?? config.exclude,
      levels: options.levels ?? config.levels,
    },
    source: options.source ?? 'custom',
    customLevels: options.customLevels ?? ['USR*'],
    customTriggers: options.customTriggers ?? [],
    triggers: options.triggers ?? true,
  };
}

/** `{ locale? }` when code values should be read, else null (ignored when schema is off). */
export function resolveCodesSettings(config: MocakitConfig, schemaEnabled: boolean): { locale?: string } | null {
  if (!schemaEnabled || !isPlainObject(config.schema)) return null;
  const codes = (config.schema as { codes?: unknown }).codes;
  if (codes === true) return {};
  if (isPlainObject(codes)) return typeof codes.locale === 'string' ? { locale: codes.locale } : {};
  return null;
}

/** Posix relative link from a folder to a file. */
export function relativeHref(fromDir: string, toFile: string): string {
  return relative(fromDir, toFile).split(sep).join('/');
}

/** Command models for a live run: definitions from the raw command rows, args from the snapshot. */
export function buildCommandModels(input: {
  commandRows: { columns: string[]; rows: MocaRow[] };
  triggers: TriggerInfo[];
  snapshot: Snapshot;
  tables: ReadonlySet<string> | null;
}): ReturnType<typeof buildAgentModel> {
  const args = new Map(input.snapshot.commands.map((c) => [commandKey(c.name), c.args]));
  return buildAgentModel({ commands: readCommandDefinitions(input.commandRows), triggers: input.triggers, args, tables: input.tables });
}

/** The models whose docs are written: those that pass `settings.filter`. */
export function documentedCommands(models: CommandModel[], settings: ResolvedCommandDocs): CommandModel[] {
  const kept = new Set(
    filterCommands(models.map((m) => ({ name: m.info.name, level: m.info.active.level, args: [] })), settings.filter).map((c) => c.name),
  );
  return models.filter((m) => kept.has(m.info.name));
}

/** Link from a table doc (`<schemaDocs>/tables/x.md`) to a command doc in `commandDocsOut`; undefined for commands without a doc. */
export function commandHrefFor(
  commandDocsOut: string,
  schemaDocs: string,
  documented: ReadonlySet<string>,
): (name: string) => string | undefined {
  return (name) =>
    documented.has(name)
      ? relativeHref(join(schemaDocs, 'tables'), join(commandDocsOut, 'commands', commandDocFile(commandKey(name)).file))
      : undefined;
}

const INDEX_LINE = /^- \[`(.+)`\]\(commands\//;

/**
 * Command names listed in a previously generated `<dir>/INDEX.md` (lines ``- [`<name>`](commands/<file>) · …``),
 * or null when the index is missing or was not generated by mocakit.
 */
export async function readDocumentedCommands(dir: string): Promise<Set<string> | null> {
  let text: string;
  try {
    text = await readFile(join(dir, 'INDEX.md'), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  if (!startsWithMarker(text)) return null;
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = INDEX_LINE.exec(line);
    if (match !== null) names.add(match[1]!);
  }
  return names;
}

/**
 * The moca-commands/ folder for `documented` (see `documentedCommands`). Tables link to their docs only when
 * schema docs are on and the table is in `documentedTables` (the schema filter's result); others are plain names.
 */
export function emitDocumentedCommands(
  documented: CommandModel[],
  settings: ResolvedCommandDocs,
  options: { version: string; server: string; schemaDocs: string | null; documentedTables: ReadonlySet<string> },
): { files: Map<string, string>; warnings: string[] } {
  const { schemaDocs, documentedTables } = options;
  const tableHref =
    schemaDocs !== null
      ? (table: string) =>
          documentedTables.has(table)
            ? relativeHref(join(settings.out, 'commands'), join(schemaDocs, 'tables', docFileName(table).file))
            : undefined
      : undefined;
  return emitCommandDocs(
    documented,
    {
      version: options.version,
      server: options.server,
      source: settings.source,
      customLevels: settings.customLevels,
      customTriggers: settings.customTriggers,
      triggers: settings.triggers,
      tableHref,
    },
  );
}
