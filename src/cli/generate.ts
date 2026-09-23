import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { MocaClient, type MocaClientDeps } from '../client/client.js';
import { emit } from '../codegen/emit.js';
import { filterCommands } from '../codegen/filter.js';
import { introspect } from '../codegen/introspect.js';
import { readSnapshot, writeSnapshot, type Snapshot } from '../codegen/snapshot.js';
import { redactUrl } from '../util/url.js';
import { VERSION } from '../version.js';
import { loadConfig, resolveConnection } from './load-config.js';

export interface CliIo {
  log(message: string): void;
  error(message: string): void;
}

export interface GenerateOptions {
  configPath?: string;
  out?: string;
  fromSnapshot?: string;
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

  if (!options.dryRun) {
    // Fail fast, before contacting the server, if the output directory can't be created.
    try {
      await mkdir(dirname(out), { recursive: true });
    } catch (error) {
      throw new Error(`Cannot write ${out}: ${errorDetail(error)}`);
    }
  }

  let snapshot: Snapshot;
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
  } else {
    const connection = resolveConnection(config, env);
    io.log(`Introspecting ${redactUrl(connection.url)} …`);
    const client = new MocaClient({ ...connection, session: { reuse: false } }, options.deps);
    let introspected: Awaited<ReturnType<typeof introspect>>;
    try {
      introspected = await introspect(client, { version: VERSION, server: connection.url });
    } finally {
      await client.logout().catch(() => undefined);
    }
    snapshot = introspected.snapshot;
    warn.print(introspected.warnings);

    // Leave an existing snapshot byte-for-byte alone when the server's commands haven't changed,
    // so regenerating doesn't churn `generatedAt` (and the diff) for nothing.
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
  }

  const commands = filterCommands(snapshot.commands, config);
  const { code, warnings, count } = emit({ ...snapshot, commands }, { version: VERSION });
  warn.print(warnings);
  warn.finish();

  if (!options.dryRun) {
    try {
      await writeFile(out, code, 'utf8');
    } catch (error) {
      throw new Error(`Cannot write ${out}: ${errorDetail(error)}`);
    }
  }
  io.log(`${options.dryRun ? 'Would write' : 'Wrote'} ${count} commands to ${out}`);
}
