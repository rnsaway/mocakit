import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canStart, runExternal, substitute } from '../util/run-external.js';

export interface DecompilerConfig {
  command: string;
  args: string[];
  /** Default 120000. */
  timeoutMs?: number;
}

export type DecompileResult = { ok: true; sources: Map<string, string> } | { ok: false; warning: string };

const DEFAULT_TIMEOUT_MS = 120_000;

const notStarted = (command: string): string => `decompiler command "${command}" could not be started`;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Identifies the decompiler setup; a change forces a re-decompile. */
export function decompilerHash(config: DecompilerConfig): string {
  return sha256(JSON.stringify({ command: config.command, args: config.args }));
}

/** Hash of the files that make up one decompile input. */
export function inputHash(files: Array<{ path: string; sha256: string }>): string {
  const lines = files.map((f) => `${f.path}:${f.sha256}`).sort();
  return sha256(lines.join('\n'));
}

/** `previous` maps a local path to the hash that was decompiled last time. */
export function needsDecompile(previous: Record<string, string> | undefined, local: string, hash: string): boolean {
  return previous?.[local] !== hash;
}

/** Throws when the configured command cannot be started. The exit code is ignored. */
export async function checkDecompiler(config: DecompilerConfig): Promise<void> {
  if (!(await canStart(config.command))) throw new Error(notStarted(config.command));
}

function isUnsafeKey(key: string): boolean {
  if (key === '' || key.startsWith('/') || key.includes('\\') || key.includes('\0')) return true;
  if (/^[A-Za-z]:/.test(key)) return true;
  return key.split('/').some((seg) => seg === '..' || seg === '' || seg === '.');
}

async function collectJava(root: string): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (entry.isFile() && entry.name.endsWith('.java')) {
        sources.set(rel, await readFile(join(dir, entry.name), 'utf8'));
      }
    }
  };
  await walk(root, '');
  return sources;
}

/** Decompile a JAR (one file) or a classes tree in a temp folder under `os.tmpdir()`, which is always removed. */
export async function decompile(
  config: DecompilerConfig,
  input: { name: string; files: Map<string, Uint8Array> },
): Promise<DecompileResult> {
  for (const key of input.files.keys()) {
    if (isUnsafeKey(key)) {
      return { ok: false, warning: `refusing to decompile ${input.name}: unsafe file name "${key}"` };
    }
  }
  const tmp = await mkdtemp(join(tmpdir(), 'mocakit-decompile-'));
  try {
    const inDir = join(tmp, 'in');
    const outDir = join(tmp, 'out');
    await mkdir(inDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    for (const [key, bytes] of input.files) {
      const target = join(inDir, ...key.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const keys = [...input.files.keys()];
    const inputPath = keys.length === 1 && keys[0]!.toLowerCase().endsWith('.jar') ? join(inDir, keys[0]!) : inDir;

    const result = await runExternal(config.command, substitute(config.args, { input: inputPath, output: outDir }), {
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (result.startFailed) return { ok: false, warning: notStarted(config.command) };
    if (result.timedOut) {
      return { ok: false, warning: `decompiler timed out for ${input.name} after ${config.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` };
    }
    if (!result.ok) {
      const detail = result.stderr.trim().split('\n')[0] ?? '';
      const exit = result.code === null ? 'no exit code' : `exit code ${result.code}`;
      return { ok: false, warning: `decompiler failed for ${input.name} (${exit})${detail ? `: ${detail}` : ''}` };
    }
    const sources = await collectJava(outDir);
    if (sources.size === 0) return { ok: false, warning: `decompiler produced no source for ${input.name}` };
    return { ok: true, sources };
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
