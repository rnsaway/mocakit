import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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
  cwd: string;
  env: Record<string, string | undefined>;
  io: CliIo;
  deps?: MocaClientDeps;
}

const DEFAULT_OUT = 'src/moca.generated.ts';

export async function runGenerate(options: GenerateOptions): Promise<void> {
  const { cwd, io } = options;
  const loaded = await loadConfig(options.configPath, cwd, { optional: options.fromSnapshot !== undefined });
  const config = loaded?.config ?? {};
  const out = resolve(cwd, options.out ?? config.out ?? DEFAULT_OUT);
  const snapshotPath = resolve(cwd, config.snapshot ?? join(dirname(out), 'moca.commands.json'));

  let snapshot: Snapshot;
  if (options.fromSnapshot !== undefined) {
    snapshot = await readSnapshot(resolve(cwd, options.fromSnapshot));
  } else {
    const connection = resolveConnection(config, options.env);
    io.log(`Introspecting ${redactUrl(connection.url)} …`);
    const client = new MocaClient({ ...connection, session: { reuse: false } }, options.deps);
    try {
      snapshot = await introspect(client, { version: VERSION, server: connection.url });
    } finally {
      await client.logout().catch(() => undefined);
    }
    if (!options.dryRun) {
      await writeSnapshot(snapshotPath, snapshot);
      io.log(`Wrote snapshot of ${snapshot.commands.length} commands to ${snapshotPath}`);
    }
  }

  const commands = filterCommands(snapshot.commands, config);
  const { code, warnings } = emit({ ...snapshot, commands }, { version: VERSION });
  for (const warning of warnings) io.error(`warning: ${warning}`);

  if (!options.dryRun) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, code, 'utf8');
  }
  io.log(`${options.dryRun ? 'Would write' : 'Wrote'} ${commands.length} commands to ${out}`);
}
