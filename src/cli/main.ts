import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { MocaClientDeps } from '../client/client.js';
import { resolveContextSettings, runContext } from '../context/context-step.js';
import { VERSION } from '../version.js';
import { exposeOnProcessEnv, loadEnvFile } from './env-file.js';
import { DEFAULT_OUT, runGenerate, type CliIo } from './generate.js';
import { loadConfig } from './load-config.js';

const USAGE = [
  'Usage: mocakit generate [--config <path>] [--out <path>] [--from-snapshot <path>] [--env-file <path> | --no-env-file] [--schema | --no-schema] [--command-docs | --no-command-docs] [--api | --no-api] [--java | --no-java] [--context | --no-context] [--dry-run] [--verbose]',
  'Usage: mocakit context [--config <path>] [--dry-run] [--verbose]',
  '',
  '  --config         Config file (default: mocakit.config.{ts,mts,mjs,js,json} in the current directory)',
  '  --out            Output file (default: config.out or src/moca.generated.ts)',
  '  --from-snapshot  Generate from a saved moca.commands.json without contacting the server',
  '  --env-file       Load environment variables from this file (default: ./.env in the current directory, if present)',
  '  --no-env-file    Do not load ./.env automatically',
  '  --schema         Also introspect database tables/views (writes moca.schema.json, moca.schema.ts and moca-schema/)',
  '  --no-schema      Skip schema introspection even if the config enables it',
  '  --command-docs   Also write moca-commands/ (command docs with triggers and cross-references; source only for custom levels)',
  '  --no-command-docs',
  '                   Skip command docs even if the config enables them',
  '  --api            Also generate the typed REST API client (moca.api.json, moca.api.ts, moca-api/) from the server\'s Swagger specs',
  '  --no-api',
  '                   Skip the REST API client even if the config enables it',
  '  --java           Also read the server\'s Java classpath with "execute os command" into moca-java/ (JARs, classes, inventory',
  '                   docs; Java source when a decompiler is configured)',
  '  --no-java',
  '                   Skip Java introspection even if the config enables it',
  '  --context        Also convert the documents in moca-context/sources/ into sectioned Markdown for agents (no server needed)',
  '  --no-context',
  '                   Skip the agent context even if the config enables it',
  '  --dry-run        Introspect and report without writing files',
  '  --verbose        Print every warning (by default only the first 50 are printed) and the names of loaded env variables',
  '',
  '`mocakit context` runs only the agent-context step; it needs no server and no credentials, and works without a config file.',
  '',
  'Credentials come from the config or MOCA_URL, MOCA_USER, MOCA_PASSWORD (and MOCA_IGNORE_SSL=1|yes|true).',
  'Variables already set in the environment take precedence over those in the env file.',
].join('\n');

const defaultIo: CliIo = { log: (m) => console.log(m), error: (m) => console.error(m) };

export interface RunCliOptions {
  /** Injected into the MOCA client (tests use a fake transport). */
  deps?: MocaClientDeps;
}

export async function runCli(
  argv: string[],
  io: CliIo = defaultIo,
  cwd: string = process.cwd(),
  options: RunCliOptions = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || command === 'help') {
    io.log(USAGE);
    return 0;
  }
  if (command === 'context') return runContextCommand(rest, io, cwd);
  if (command !== 'generate') {
    io.error(USAGE);
    return 1;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.log(USAGE);
    return 0;
  }

  let values: {
    config?: string;
    out?: string;
    'from-snapshot'?: string;
    'env-file'?: string;
    'no-env-file'?: boolean;
    schema?: boolean;
    'no-schema'?: boolean;
    'command-docs'?: boolean;
    'no-command-docs'?: boolean;
    api?: boolean;
    'no-api'?: boolean;
    java?: boolean;
    'no-java'?: boolean;
    context?: boolean;
    'no-context'?: boolean;
    'dry-run'?: boolean;
    verbose?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        config: { type: 'string' },
        out: { type: 'string' },
        'from-snapshot': { type: 'string' },
        'env-file': { type: 'string' },
        'no-env-file': { type: 'boolean' },
        schema: { type: 'boolean' },
        'no-schema': { type: 'boolean' },
        'command-docs': { type: 'boolean' },
        'no-command-docs': { type: 'boolean' },
        api: { type: 'boolean' },
        'no-api': { type: 'boolean' },
        java: { type: 'boolean' },
        'no-java': { type: 'boolean' },
        context: { type: 'boolean' },
        'no-context': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        verbose: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.error(`mocakit: ${(error as Error).message}`);
    io.error(USAGE);
    return 1;
  }
  if (values['env-file'] !== undefined && values['no-env-file']) {
    io.error('mocakit: --env-file and --no-env-file cannot be used together');
    return 1;
  }
  if (values.schema && values['no-schema']) {
    io.error('mocakit: --schema and --no-schema cannot be used together');
    return 1;
  }
  if (values['command-docs'] && values['no-command-docs']) {
    io.error('mocakit: --command-docs and --no-command-docs cannot be used together');
    return 1;
  }
  if (values.api && values['no-api']) {
    io.error('mocakit: --api and --no-api cannot be used together');
    return 1;
  }
  if (values.java && values['no-java']) {
    io.error('mocakit: --java and --no-java cannot be used together');
    return 1;
  }
  if (values.context && values['no-context']) {
    io.error('mocakit: --context and --no-context cannot be used together');
    return 1;
  }
  const verbose = values.verbose ?? false;

  let restoreProcessEnv = () => {};
  try {
    let fileVars: Record<string, string> = {};
    if (!values['no-env-file']) {
      const explicit = values['env-file'];
      const loaded = await loadEnvFile(resolve(cwd, explicit ?? '.env'), { optional: explicit === undefined });
      if (loaded !== null) {
        fileVars = loaded.vars;
        const names = Object.keys(fileVars).sort();
        const noun = names.length === 1 ? 'variable' : 'variables';
        // Names only with --verbose; values are never printed.
        io.log(`Loaded ${names.length} ${noun} from ${loaded.path}${verbose && names.length > 0 ? `: ${names.join(', ')}` : ''}`);
      }
    }
    // The real environment wins over the file, as with `node --env-file`. The file's values are
    // also exposed on process.env for the duration of the run (and removed afterwards) so that a
    // mocakit.config.ts reading process.env sees them.
    const env = { ...fileVars, ...process.env };
    restoreProcessEnv = exposeOnProcessEnv(fileVars);

    await runGenerate({
      configPath: values.config,
      out: values.out,
      fromSnapshot: values['from-snapshot'],
      schema: values.schema ? true : values['no-schema'] ? false : undefined,
      commandDocs: values['command-docs'] ? true : values['no-command-docs'] ? false : undefined,
      api: values.api ? true : values['no-api'] ? false : undefined,
      java: values.java ? true : values['no-java'] ? false : undefined,
      context: values.context ? true : values['no-context'] ? false : undefined,
      dryRun: values['dry-run'] ?? false,
      verbose,
      cwd,
      env,
      io,
      deps: options.deps,
    });
    return 0;
  } catch (error) {
    io.error(`mocakit: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    restoreProcessEnv();
  }
}

/** `mocakit context`: the agent-context step alone. No server, no credentials; the config file is optional. */
async function runContextCommand(args: string[], io: CliIo, cwd: string): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.log(USAGE);
    return 0;
  }
  let values: { config?: string; 'dry-run'?: boolean; verbose?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      options: { config: { type: 'string' }, 'dry-run': { type: 'boolean' }, verbose: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.error(`mocakit: ${(error as Error).message}`);
    io.error(USAGE);
    return 1;
  }
  try {
    const loaded = await loadConfig(values.config, cwd, { optional: true });
    const config = loaded?.config ?? {};
    const configDir = loaded !== null ? dirname(loaded.path) : cwd;
    const out = resolve(configDir, config.out ?? DEFAULT_OUT);
    const settings = resolveContextSettings(config, true, configDir, out)!;
    await runContext(settings, io, { dryRun: values['dry-run'] ?? false, version: VERSION, verbose: values.verbose ?? false });
    return 0;
  } catch (error) {
    io.error(`mocakit: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
