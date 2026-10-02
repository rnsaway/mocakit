import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MocaClient, type MocaClientDeps } from '../client/client.js';
import type { MocakitConfig, SchemaConfig } from '../define-config.js';
import type { CommandModel } from '../codegen/agent-model.js';
import { introspectApi } from '../codegen/introspect-api.js';
import { sameApi, writeApiSnapshot, type ApiSnapshot } from '../codegen/api-snapshot.js';
import { emitApi, filterOperations } from '../codegen/emit-api.js';
import { emitApiDocs } from '../codegen/emit-api-docs.js';
import { httpRestTransport } from '../transport/rest.js';
import { checkDocsTargets, writeDocs } from '../codegen/docs-writer.js';
import { readCodes, readTriggers, type TriggerInfo } from '../codegen/introspect-agent.js';
import { emit } from '../codegen/emit.js';
import { emitSchema, filterTables, type SchemaFilter } from '../codegen/emit-schema.js';
import { checkSchemaDocsTargets, emitSchemaDocs, writeSchemaDocs } from '../codegen/emit-schema-docs.js';
import { introspectSchema } from '../codegen/introspect-schema.js';
import { readSchemaSnapshot, sameSchema, writeSchemaSnapshot, type SchemaSnapshot } from '../codegen/schema-snapshot.js';
import { filterCommands } from '../codegen/filter.js';
import { introspect, type IntrospectResult } from '../codegen/introspect.js';
import { readSnapshot, writeSnapshot, type Snapshot } from '../codegen/snapshot.js';
import { redactUrl } from '../util/url.js';
import { VERSION } from '../version.js';
import {
  buildCommandModels,
  commandDocsDir,
  commandHrefFor,
  documentedCommands,
  emitDocumentedCommands,
  readDocumentedCommands,
  resolveCodesSettings,
  resolveCommandDocsSettings,
} from './command-docs.js';
import { apiDocsManagedDirs, readApiSnapshotFile, resolveApiSettings } from './api-step.js';
import { loadConfig, resolveConnection } from './load-config.js';

export interface CliIo {
  log(message: string): void;
  error(message: string): void;
}

export interface GenerateOptions {
  configPath?: string;
  out?: string;
  fromSnapshot?: string;
  /** `true` = --schema, `false` = --no-schema, `undefined` = the config decides. */
  schema?: boolean;
  /** `true` = --command-docs, `false` = --no-command-docs, `undefined` = the config decides. */
  commandDocs?: boolean;
  /** `true` = --api, `false` = --no-api, `undefined` = the config decides. */
  api?: boolean;
  dryRun: boolean;
  /** Print every warning instead of the first `MAX_PRINTED_WARNINGS` and a count. */
  verbose?: boolean;
  cwd: string;
  env: Record<string, string | undefined>;
  io: CliIo;
  deps?: MocaClientDeps;
}

const DEFAULT_OUT = 'src/moca.generated.ts';

/** How many individual warnings the CLI prints; the rest are summarized in one line. */
const MAX_PRINTED_WARNINGS = 50;

/** Prints warnings up to `limit` across all calls to `print`; `finish` reports the rest. */
function warningPrinter(io: CliIo, limit: number): { print(warnings: readonly string[]): void; finish(): void } {
  let printed = 0;
  let suppressed = 0;
  return {
    print(warnings) {
      for (const warning of warnings) {
        if (printed < limit) {
          io.error(`warning: ${warning}`);
          printed++;
        } else {
          suppressed++;
        }
      }
    },
    finish() {
      if (suppressed > 0) io.error(`... and ${suppressed} more warnings (use --verbose to see all)`);
    },
  };
}

const isSet = (value: string | undefined): boolean => typeof value === 'string' && value.trim() !== '';

/** Prefers a NodeJS error `code` (e.g. `ENOENT`) over the full message, which may embed the
 * file's path or contents. */
function errorDetail(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.message : String(error);
}

export interface ResolvedSchema {
  snapshot: string;
  out: string;
  /** `null` when docs are disabled. */
  docs: string | null;
  filter: SchemaFilter;
}

/** Schema settings from config + CLI flag, or `null` when schema introspection is off. */
export function resolveSchemaSettings(
  config: MocakitConfig,
  flag: boolean | undefined,
  configDir: string,
  out: string,
): ResolvedSchema | null {
  const setting = config.schema;
  if (setting !== undefined && typeof setting !== 'boolean' && (typeof setting !== 'object' || setting === null || Array.isArray(setting))) {
    throw new Error('config.schema must be true, false or an object');
  }
  if (flag === false || (flag === undefined && !setting)) return null;
  const options: SchemaConfig = typeof setting === 'object' ? setting : {};
  const near = (file: string) => resolve(dirname(out), file);
  const fromConfig = (path: string) => resolve(configDir, path);
  return {
    snapshot: options.snapshot !== undefined ? fromConfig(options.snapshot) : near('moca.schema.json'),
    out: options.out !== undefined ? fromConfig(options.out) : near('moca.schema.ts'),
    docs: options.docs === false ? null : options.docs !== undefined ? fromConfig(options.docs) : near('moca-schema'),
    filter: { include: options.include, exclude: options.exclude, views: options.views },
  };
}

/** NodeNext import specifier from one generated file to another (`.ts` → `.js`). */
export function moduleSpecifier(fromFile: string, toFile: string): string {
  const path = relative(dirname(fromFile), toFile).split(sep).join('/').replace(/\.(m?)ts$/, '.$1js');
  return path.startsWith('.') ? path : `./${path}`;
}

async function readSchemaFile(path: string): Promise<SchemaSnapshot> {
  try {
    return await readSchemaSnapshot(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new Error(`Schema is enabled but ${path} does not exist; run generate against a server first, or pass --no-schema`);
    }
    throw error;
  }
}

export async function runGenerate(options: GenerateOptions): Promise<void> {
  const { cwd, io, env } = options;
  const warn = warningPrinter(io, options.verbose ? Number.POSITIVE_INFINITY : MAX_PRINTED_WARNINGS);
  const hasFullEnvCredentials = isSet(env.MOCA_URL) && isSet(env.MOCA_USER) && isSet(env.MOCA_PASSWORD);
  const configOptional = options.fromSnapshot !== undefined || hasFullEnvCredentials;
  const loaded = await loadConfig(options.configPath, cwd, { optional: configOptional });
  const config = loaded?.config ?? {};
  // A relative `out`/`snapshot` given *in the config file* is relative to that file's own
  // directory (so a shared config works regardless of where it's invoked from); one given on
  // the CLI, or the built-in default, is relative to the cwd.
  const configDir = loaded !== null ? dirname(loaded.path) : cwd;

  const out = options.out !== undefined ? resolve(cwd, options.out) : resolve(configDir, config.out ?? DEFAULT_OUT);
  const snapshotPath =
    config.snapshot !== undefined ? resolve(configDir, config.snapshot) : resolve(dirname(out), 'moca.commands.json');
  const schema = resolveSchemaSettings(config, options.schema, configDir, out);
  const commandDocs = resolveCommandDocsSettings(config, options.commandDocs, configDir, out);
  const codesSettings = resolveCodesSettings(config, schema !== null);
  const api = resolveApiSettings(config, options.api, configDir, out);

  if (!options.dryRun) {
    // Fail fast, before contacting the server, if an output directory can't be created.
    try {
      await mkdir(dirname(out), { recursive: true });
    } catch (error) {
      throw new Error(`Cannot write ${out}: ${errorDetail(error)}`);
    }
    const dirs = [
      ...(schema === null ? [] : [dirname(schema.snapshot), dirname(schema.out), ...(schema.docs === null ? [] : [schema.docs])]),
      ...(commandDocs !== null && options.fromSnapshot === undefined ? [commandDocs.out] : []),
      ...(api === null ? [] : [dirname(api.snapshot), dirname(api.out), ...(api.docs === null ? [] : [api.docs])]),
    ];
    for (const dir of dirs) {
      try {
        await mkdir(dir, { recursive: true });
      } catch (error) {
        throw new Error(`Cannot write ${dir}: ${errorDetail(error)}`);
      }
    }
  }

  let snapshot: Snapshot;
  let schemaSnapshot: SchemaSnapshot | null = null;
  let commandRows: IntrospectResult['commandRows'];
  let triggers: TriggerInfo[] = [];
  if (options.fromSnapshot !== undefined) {
    const snapshotFile = resolve(cwd, options.fromSnapshot);
    try {
      snapshot = await readSnapshot(snapshotFile);
    } catch (error) {
      // readSnapshot's own errors (invalid JSON, not a mocakit snapshot) already mention the
      // path, so prefixing "Cannot read snapshot <path>:" would print it twice. A raw Node fs
      // error (e.g. ENOENT) has a `code` and doesn't, so it still gets the prefix.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      const message = error instanceof Error ? error.message : String(error);
      if (typeof code !== 'string' && message.includes(snapshotFile)) throw new Error(message);
      throw new Error(`Cannot read snapshot ${snapshotFile}: ${errorDetail(error)}`);
    }
    if (schema !== null) schemaSnapshot = await readSchemaFile(schema.snapshot);
    if (commandDocs !== null) io.log('Skipped command docs: they need a live server (--from-snapshot)');
  } else {
    const connection = resolveConnection(config, env);
    io.log(`Introspecting ${redactUrl(connection.url)} …`);
    const client = new MocaClient({ ...connection, session: { reuse: false } }, options.deps);
    let introspected: Awaited<ReturnType<typeof introspect>>;
    let schemaResult: Awaited<ReturnType<typeof introspectSchema>> | null = null;
    let codesResult: Awaited<ReturnType<typeof readCodes>> | null = null;
    try {
      introspected = await introspect(client, { version: VERSION, server: connection.url, keepCommandRows: commandDocs !== null });
      if (schema !== null) schemaResult = await introspectSchema(client, { version: VERSION, server: connection.url });
      if (codesSettings !== null) {
        codesResult = await readCodes(client, codesSettings.locale ?? client.session.locale ?? 'US_ENGLISH');
      }
      if (commandDocs !== null && commandDocs.triggers) triggers = await readTriggers(client);
    } finally {
      await client.logout().catch(() => undefined);
    }
    snapshot = introspected.snapshot;
    commandRows = introspected.commandRows;
    warn.print(introspected.warnings);
    if (schemaResult !== null) {
      schemaSnapshot = schemaResult.snapshot;
      warn.print(schemaResult.warnings);
    }
    if (codesResult !== null) {
      warn.print(codesResult.warnings);
      const { codes } = codesResult;
      if (schemaSnapshot !== null) schemaSnapshot = { ...schemaSnapshot, codes };
      const values = codes.columns.reduce((n, c) => n + c.values.length, 0);
      io.log(`Read ${values} code values for ${codes.columns.length} columns (locale ${codes.locale})`);
    }
    if (commandDocs !== null && commandDocs.triggers) {
      io.log(`Read ${triggers.length} triggers on ${new Set(triggers.map((t) => t.command)).size} commands`);
    }
  }

  let apiSnapshot: ApiSnapshot | null = null;
  if (api !== null) {
    if (options.fromSnapshot !== undefined) {
      apiSnapshot = await readApiSnapshotFile(api.snapshot);
    } else {
      const connection = resolveConnection(config, env);
      const result = await introspectApi({
        url: connection.url,
        ignoreSslIssues: connection.ignoreSslIssues ?? false,
        timeoutMs: connection.timeoutMs,
        groups: api.groups,
        version: VERSION,
        transport: options.deps?.restTransport ?? httpRestTransport,
      });
      apiSnapshot = result.snapshot;
      warn.print(result.warnings);
      io.log(`Read ${api.groups.length} API groups (${apiSnapshot.operations.length} operations)`);
    }
  }

  let commandModels: CommandModel[] | null = null;
  if (commandDocs !== null && commandRows !== undefined) {
    const tables = schemaSnapshot !== null ? new Set(schemaSnapshot.tables.map((t) => t.name)) : null;
    const model = buildCommandModels({ commandRows, triggers, snapshot, tables });
    warn.print(model.warnings);
    commandModels = documentedCommands(model.commands, commandDocs);
    if (schemaSnapshot !== null && model.usage !== undefined) schemaSnapshot = { ...schemaSnapshot, usage: model.usage };
    if (tables === null) io.log('Command docs written without table cross-references (schema is off)');
    if (commandDocs.source === 'all') {
      io.log("Command docs include Blue Yonder product source (commandDocs.source = 'all'); keep them in a private repository.");
    }
  }

  // Keep the previous usage when this run did not compute it (command docs off), so the table
  // docs' "Used by" sections survive. Code values are never carried over.
  const existingSchema = schema !== null && schemaSnapshot !== null ? await readSchemaSnapshot(schema.snapshot).catch(() => null) : null;
  if (schemaSnapshot !== null && schemaSnapshot.usage === undefined && existingSchema?.usage !== undefined) {
    schemaSnapshot = { ...schemaSnapshot, usage: existingSchema.usage };
  }

  const commands = filterCommands(snapshot.commands, config);
  const schemaImport = schema !== null && schemaSnapshot !== null ? moduleSpecifier(out, schema.out) : undefined;
  const { code, warnings, count } = emit({ ...snapshot, commands }, {
    version: VERSION,
    schemaImport,
    apiImport: api !== null && apiSnapshot !== null ? moduleSpecifier(out, api.out) : undefined,
  });
  warn.print(warnings);

  let schemaOutput: { code: string; count: number; docs: Map<string, string> | null } | null = null;
  // Tables that get a doc this run (the schema filter's result); command docs link only to these.
  let documentedTables: ReadonlySet<string> = new Set();
  if (schema !== null && schemaSnapshot !== null) {
    const filtered = { ...schemaSnapshot, tables: filterTables(schemaSnapshot.tables, schema.filter) };
    documentedTables = new Set(filtered.tables.map((t) => t.name));
    const emitted = emitSchema(filtered, { version: VERSION });
    warn.print(emitted.warnings);
    let docs: Map<string, string> | null = null;
    if (schema.docs !== null) {
      // Link "Used by" names to this run's command docs, or, when none are emitted this run, to those listed
      // in a previously generated command INDEX.md (so offline / docs-off runs keep the links).
      const commandsOut = commandDocs?.out ?? commandDocsDir(config, configDir, out);
      const documented =
        commandModels !== null ? new Set(commandModels.map((m) => m.info.name)) : await readDocumentedCommands(commandsOut);
      const commandHref = documented !== null ? commandHrefFor(commandsOut, schema.docs, documented) : undefined;
      const docResult = emitSchemaDocs(filtered, { version: VERSION, commandHref });
      warn.print(docResult.warnings);
      docs = docResult.files;
    }
    schemaOutput = { code: emitted.code, count: emitted.count, docs };
  }
  let commandDocsFiles: Map<string, string> | null = null;
  if (commandDocs !== null && commandModels !== null) {
    const emitted = emitDocumentedCommands(commandModels, commandDocs, {
      version: VERSION,
      server: snapshot.server,
      schemaDocs: schema?.docs ?? null,
      documentedTables,
    });
    warn.print(emitted.warnings);
    commandDocsFiles = emitted.files;
  }
  let apiOutput: { code: string; count: number; docs: Map<string, string> | null } | null = null;
  if (api !== null && apiSnapshot !== null) {
    const filtered = { ...apiSnapshot, operations: filterOperations(apiSnapshot.operations, api.filter) };
    const emitted = emitApi(filtered, { version: VERSION });
    warn.print(emitted.warnings);
    let docs: Map<string, string> | null = null;
    if (api.docs !== null) {
      const docResult = emitApiDocs(filtered, { version: VERSION });
      warn.print(docResult.warnings);
      docs = docResult.files;
    }
    apiOutput = { code: emitted.code, count: emitted.count, docs };
  }
  warn.finish();

  // Every docs target must pass the hand-written-file check before anything is written.
  if (!options.dryRun && schema !== null && schema.docs !== null && schemaOutput?.docs) {
    await checkSchemaDocsTargets(schema.docs, schemaOutput.docs);
  }
  if (!options.dryRun && commandDocs !== null && commandDocsFiles !== null) {
    await checkDocsTargets(commandDocs.out, commandDocsFiles, 'commandDocs.out');
  }
  if (!options.dryRun && api !== null && api.docs !== null && apiOutput?.docs) {
    await checkDocsTargets(api.docs, apiOutput.docs, 'api.docs');
  }

  if (options.fromSnapshot === undefined) {
    // Everything was read; only now write. Leave an existing snapshot byte-for-byte alone when
    // nothing changed, so regenerating doesn't churn `generatedAt` (and the diff) for nothing.
    const existing = await readSnapshot(snapshotPath).catch(() => null);
    if (existing !== null && isDeepStrictEqual(existing.commands, snapshot.commands)) {
      if (!options.dryRun) io.log(`Snapshot unchanged: ${snapshotPath}`);
    } else if (!options.dryRun) {
      try {
        await writeSnapshot(snapshotPath, snapshot);
      } catch (error) {
        throw new Error(`Cannot write ${snapshotPath}: ${errorDetail(error)}`);
      }
      io.log(`Wrote snapshot of ${snapshot.commands.length} commands to ${snapshotPath}`);
    }
    if (schema !== null && schemaSnapshot !== null) {
      const columns = schemaSnapshot.tables.reduce((n, t) => n + t.columns.length, 0);
      if (existingSchema !== null && sameSchema(existingSchema, schemaSnapshot)) {
        if (!options.dryRun) io.log(`Schema snapshot unchanged: ${schema.snapshot}`);
      } else if (!options.dryRun) {
        try {
          await writeSchemaSnapshot(schema.snapshot, schemaSnapshot);
        } catch (error) {
          throw new Error(`Cannot write ${schema.snapshot}: ${errorDetail(error)}`);
        }
        io.log(`Wrote schema snapshot of ${schemaSnapshot.tables.length} tables (${columns} columns) to ${schema.snapshot}`);
      }
    }
    if (api !== null && apiSnapshot !== null) {
      const existingApi = await readApiSnapshotFile(api.snapshot).catch(() => null);
      if (existingApi !== null && sameApi(existingApi, apiSnapshot)) {
        if (!options.dryRun) io.log(`API snapshot unchanged: ${api.snapshot}`);
      } else if (!options.dryRun) {
        try {
          await writeApiSnapshot(api.snapshot, apiSnapshot);
        } catch (error) {
          throw new Error(`Cannot write ${api.snapshot}: ${errorDetail(error)}`);
        }
        io.log(`Wrote API snapshot of ${apiSnapshot.operations.length} operations to ${api.snapshot}`);
      }
    }
  }

  const verb = options.dryRun ? 'Would write' : 'Wrote';
  if (!options.dryRun) {
    try {
      await writeFile(out, code, 'utf8');
    } catch (error) {
      throw new Error(`Cannot write ${out}: ${errorDetail(error)}`);
    }
  }
  io.log(`${verb} ${count} commands to ${out}`);

  if (schema !== null && schemaOutput !== null) {
    if (!options.dryRun) {
      try {
        await writeFile(schema.out, schemaOutput.code, 'utf8');
      } catch (error) {
        throw new Error(`Cannot write ${schema.out}: ${errorDetail(error)}`);
      }
    }
    io.log(`${verb} ${schemaOutput.count} tables to ${schema.out}`);
    if (schema.docs !== null && schemaOutput.docs !== null) {
      if (!options.dryRun) {
        const result = await writeSchemaDocs(schema.docs, schemaOutput.docs);
        if (result.removed.length > 0) io.log(`Removed ${result.removed.length} stale table docs from ${schema.docs}`);
      }
      io.log(`${verb} ${schemaOutput.count} table docs to ${schema.docs}`);
    }
  }

  if (commandDocs !== null && commandDocsFiles !== null) {
    const count = [...commandDocsFiles.keys()].filter((k) => k.startsWith('commands/')).length;
    if (!options.dryRun) {
      const result = await writeDocs(commandDocs.out, commandDocsFiles, { setting: 'commandDocs.out', managedDirs: ['commands'] });
      if (result.removed.length > 0) io.log(`Removed ${result.removed.length} stale command docs from ${commandDocs.out}`);
    }
    io.log(`${verb} ${count} command docs to ${commandDocs.out}`);
  }

  if (api !== null && apiOutput !== null) {
    if (!options.dryRun) {
      try {
        await writeFile(api.out, apiOutput.code, 'utf8');
      } catch (error) {
        throw new Error(`Cannot write ${api.out}: ${errorDetail(error)}`);
      }
    }
    io.log(`${verb} ${apiOutput.count} API operations to ${api.out}`);
    if (api.docs !== null && apiOutput.docs !== null) {
      if (!options.dryRun) {
        const result = await writeDocs(api.docs, apiOutput.docs, {
          setting: 'api.docs',
          managedDirs: await apiDocsManagedDirs(api.docs, apiOutput.docs),
        });
        if (result.removed.length > 0) io.log(`Removed ${result.removed.length} stale API docs from ${api.docs}`);
      }
      io.log(`${verb} ${apiOutput.count} API docs to ${api.docs}`);
    }
  }
}
