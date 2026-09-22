import { parseArgs } from 'node:util';
import { runGenerate, type CliIo } from './generate.js';

const USAGE = [
  'Usage: mocakit generate [--config <path>] [--out <path>] [--from-snapshot <path>] [--dry-run]',
  '',
  '  --config         Config file (default: mocakit.config.{ts,mts,mjs,js,json} in the current directory)',
  '  --out            Output file (default: config.out or src/moca.generated.ts)',
  '  --from-snapshot  Generate from a saved moca.commands.json without contacting the server',
  '  --dry-run        Introspect and report without writing files',
  '',
  'Credentials come from the config or MOCA_URL, MOCA_USER, MOCA_PASSWORD (and MOCA_IGNORE_SSL=true).',
].join('\n');

const defaultIo: CliIo = { log: (m) => console.log(m), error: (m) => console.error(m) };

export async function runCli(argv: string[], io: CliIo = defaultIo, cwd: string = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || command === 'help') {
    io.log(USAGE);
    return 0;
  }
  if (command !== 'generate') {
    io.error(USAGE);
    return 1;
  }

  let values: { config?: string; out?: string; 'from-snapshot'?: string; 'dry-run'?: boolean };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        config: { type: 'string' },
        out: { type: 'string' },
        'from-snapshot': { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.error(`mocakit: ${(error as Error).message}`);
    io.error(USAGE);
    return 1;
  }

  try {
    await runGenerate({
      configPath: values.config,
      out: values.out,
      fromSnapshot: values['from-snapshot'],
      dryRun: values['dry-run'] ?? false,
      cwd,
      env: process.env,
      io,
    });
    return 0;
  } catch (error) {
    io.error(`mocakit: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
