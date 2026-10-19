import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { probeStart, runExternal, substitute } from '../util/run-external.js';
import { cleanupText } from './text-cleanup.js';

export interface ConverterConfig {
  command: string;
  args: string[];
  /** `'text'` output goes through `cleanupText`. Default `'markdown'`. */
  output?: 'markdown' | 'text';
  timeoutMs?: number;
}

export type ConvertExternalResult = { markdown: string; cleanupWarning?: string } | { warning: string };

export interface ConvertExternalDeps {
  rm?: typeof rm;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const notStarted = (command: string, code?: string): string =>
  `converter command "${command}" could not be started` +
  (code === 'EINVAL' ? " (on Windows, .cmd/.bat wrappers can't be run directly; point at the .exe or use java -jar)" : '');

/** Identifies the converter setup; a change forces a re-convert. */
export function converterHash(config: ConverterConfig): string {
  return createHash('sha256')
    .update(JSON.stringify({ command: config.command, args: config.args, output: config.output ?? 'markdown' }))
    .digest('hex');
}

/** Throws when a configured command cannot be started. The exit code is ignored. */
export async function checkConverters(converters: Record<string, ConverterConfig>): Promise<void> {
  const seen = new Set<string>();
  for (const ext of Object.keys(converters).sort()) {
    const { command } = converters[ext]!;
    if (seen.has(command)) continue;
    seen.add(command);
    const probe = await probeStart(command);
    if (!probe.started) throw new Error(notStarted(command, probe.code));
  }
}

/** The source's extension if it is plain (`.pdf`), else none. The user's own file name is never used. */
function safeExtension(name: string): string {
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : '';
}

function decode(bytes: Uint8Array): string {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n');
}

/** Run a user converter on one document in a temp folder under `os.tmpdir()`. Never rejects. */
export async function convertExternal(
  config: ConverterConfig,
  source: { name: string; bytes: Uint8Array },
  deps: ConvertExternalDeps = {},
): Promise<ConvertExternalResult> {
  const remove = deps.rm ?? rm;
  let tmp: string | undefined;
  let result: ConvertExternalResult;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'mocakit-convert-'));
    result = await run(config, source, tmp);
  } catch (e) {
    result = { warning: `conversion failed for ${source.name}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (tmp !== undefined) {
    try {
      await remove(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      const note = `temp folder not removed: ${tmp}`;
      result = 'markdown' in result ? { ...result, cleanupWarning: note } : { warning: `${result.warning} (${note})` };
    }
  }
  return result;
}

async function run(
  config: ConverterConfig,
  source: { name: string; bytes: Uint8Array },
  tmp: string,
): Promise<ConvertExternalResult> {
  const inputPath = join(tmp, `input${safeExtension(source.name)}`);
  const outputPath = join(tmp, 'output.txt');
  await writeFile(inputPath, source.bytes);
  const usesOutputFile = config.args.some((arg) => arg.includes('{output}'));
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = await runExternal(config.command, substitute(config.args, { input: inputPath, output: outputPath }), {
    timeoutMs,
  });
  if (result.startFailed) return { warning: notStarted(config.command, result.startErrorCode) };
  if (result.timedOut) return { warning: `converter timed out for ${source.name} after ${timeoutMs} ms` };
  if (!result.ok) {
    const detail = result.stderr.trim().split('\n')[0] ?? '';
    const exit = result.code === null ? 'no exit code' : `exit code ${result.code}`;
    return { warning: `converter failed for ${source.name} (${exit})${detail ? `: ${detail}` : ''}` };
  }

  let raw: Uint8Array = result.stdout;
  if (usesOutputFile) {
    try {
      raw = await readFile(outputPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      raw = new Uint8Array();
    }
  }
  const text = decode(raw);
  const markdown = config.output === 'text' ? cleanupText(text) : text;
  if (markdown.trim() === '') return { warning: `converter produced no text for ${source.name}` };
  return { markdown };
}
