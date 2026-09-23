import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { MocaClientDeps } from '../client/client.js';
import { exposeOnProcessEnv, loadEnvFile } from './env-file.js';
import { runGenerate, type CliIo } from './generate.js';

const USAGE = [
  'Usage: mocakit generate [--config <path>] [--out <path>] [--from-snapshot <path>] [--env-file <path> | --no-env-file] [--dry-run] [--verbose]',
  '',
  '  --config         Config file (default: mocakit.config.{ts,mts,mjs,js,json} in the current directory)',
  '  --out            Output file (default: config.out or src/moca.generated.ts)',
  '  --from-snapshot  Generate from a saved moca.commands.json without contacting the server',
  '  --env-file       Load environment variables from this file (default: ./.env in the current directory, if present)',
  '  --no-env-file    Do not load ./.env automatically',
  '  --dry-run        Introspect and report without writing files',
  '  --verbose        Print every warning (by default only the first 50 are printed) and the names of loaded env variables',
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
