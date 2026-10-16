import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, win32 } from 'node:path';
import type { ClasspathEntry, EntryType } from './classpath.js';
import type { OsFamily } from './os-commands.js';

export interface JavaFileRecord {
  path: string;
  local: string;
  size: number;
  sha256: string;
  maven?: string;
  version?: string;
  classes: number;
  readable: boolean;
}

export interface JavaEntryRecord {
  index: number;
  path: string;
  type: EntryType;
  component: string;
  slug: string;
  selected: boolean;
  missing: boolean;
  kind?: 'custom' | 'library';
  files: JavaFileRecord[];
}

export interface JavaManifest {
  mocakitVersion: string;
  generatedAt: string;
  server: string;
  os: OsFamily;
  lesDir: string;
  roots: string[];
  entries: JavaEntryRecord[];
  /** winner and losers are entry paths. */
  overridden: Array<{ className: string; winner: string; losers: string[] }>;
  /** `inputs` maps a local path to the hash that was decompiled. */
  decompiler?: { command: string; args: string[]; inputs: Record<string, string> };
  /** Relative paths of written .java files. */
  src: string[];
}

export const MANIFEST_FILE = 'manifest.json';

function segmentsOf(path: string, family: OsFamily): string[] {
  const parts = path.split(family === 'windows' ? /[\\/]+/ : /\/+/).filter((s) => s !== '' && s !== '.');
  if (family === 'windows' && /^[A-Za-z]:$/.test(parts[0] ?? '')) parts.shift();
  return parts;
}

function sameSegment(a: string, b: string, family: OsFamily): boolean {
  return family === 'windows' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Segments of `path` below `base`. */
function belowFolder(path: string, base: string, family: OsFamily): string[] {
  const parts = segmentsOf(path, family);
  const root = segmentsOf(base, family);
  if (root.length > parts.length || !root.every((s, i) => sameSegment(s, parts[i], family))) {
    throw new Error(`path "${path}" is not under "${base}"`);
  }
  return parts.slice(root.length);
}

/**
 * Local path (relative to the moca-java folder, `/` separators) for a server
 * file: `jars/<component>/<path under component>` for JARs, otherwise
 * `classes/<component>/<...>`. Entries outside every component use
 * `jars/external/<slug>/<file name>` and `classes/external/<slug>/<path under entry>`.
 * The component folder is `dirname(lesDir)/<component>`. Throws if the result would escape the folder.
 */
export function localPathFor(entry: ClasspathEntry, serverPath: string, family: OsFamily, lesDir: string): string {
  if (!entry.usable || entry.component === '') throw new Error(`classpath entry "${entry.raw}" has no local path`);
  const isJar = serverPath.toLowerCase().endsWith('.jar');
  const top = isJar ? 'jars' : 'classes';
  let parts: string[];
  if (entry.component === 'external') {
    const rest = isJar
      ? [segmentsOf(serverPath, family).pop() ?? '']
      : belowFolder(serverPath, entry.path, family);
    parts = ['external', entry.slug, ...rest];
  } else {
    const api = family === 'windows' ? win32 : posix;
    const folder = api.join(api.dirname(lesDir), entry.component);
    const rel = api.relative(folder, serverPath);
    if (rel === '' || rel.startsWith('..') || api.isAbsolute(rel)) {
      throw new Error(`path "${serverPath}" is not under component folder "${folder}"`);
    }
    parts = [entry.component, ...segmentsOf(rel, family)];
  }
  const local = [top, ...parts].join('/');
  if (local.split('/').some((s) => s === '' || s === '..') || /^[A-Za-z]:/.test(local)) {
    throw new Error(`unsafe local path "${local}" for server file "${serverPath}"`);
  }
  return local;
}

function isSafeRelative(p: string): boolean {
  return p !== '' && !isAbsolute(p) && !p.startsWith('/') && !p.split(/[\\/]/).includes('..');
}

/** The manifest in `dir`, or null when it is missing or unreadable. */
export async function readJavaManifest(dir: string): Promise<JavaManifest | null> {
  let text: string;
  try {
    text = await readFile(join(dir, MANIFEST_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as JavaManifest;
    return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeJavaManifest(dir: string, manifest: JavaManifest): Promise<void> {
  const file = join(dir, MANIFEST_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/** Equality ignoring `generatedAt` and `mocakitVersion`. */
export function sameJavaManifest(a: JavaManifest, b: JavaManifest): boolean {
  const strip = (m: JavaManifest): string => {
    const { generatedAt: _g, mocakitVersion: _v, ...rest } = m;
    return JSON.stringify(rest);
  };
  return strip(a) === strip(b);
}

/**
 * Bytes of a previously stored file with this sha256, or null. The local file
 * is re-hashed on every call; the manifest alone is never trusted.
 */
export function cachedBytes(
  dir: string,
  manifest: JavaManifest | null,
): (sha256: string) => Promise<Uint8Array | null> {
  return async (sha256) => {
    if (manifest === null) return null;
    const locals = new Set<string>();
    for (const e of manifest.entries) {
      for (const f of e.files) if (f.sha256 === sha256 && isSafeRelative(f.local)) locals.add(f.local);
    }
    for (const local of locals) {
      let bytes: Buffer;
      try {
        bytes = await readFile(join(dir, local));
      } catch {
        continue;
      }
      if (createHash('sha256').update(bytes).digest('hex') === sha256) return new Uint8Array(bytes);
    }
    return null;
  };
}

function producedPaths(m: JavaManifest): Set<string> {
  const out = new Set<string>(m.src);
  for (const e of m.entries) for (const f of e.files) out.add(f.local);
  return out;
}

const STORE_PREFIXES = ['jars/', 'classes/', 'src/'];

/**
 * Local and src paths recorded by `previous` that `next` no longer produces (sorted).
 * The previous manifest is user-editable and its result feeds a deleter, so only
 * safe relative paths under jars/, classes/ or src/ are returned.
 */
export function staleFiles(previous: JavaManifest | null, next: JavaManifest): string[] {
  if (previous === null) return [];
  const keep = producedPaths(next);
  return [...producedPaths(previous)]
    .filter((p) => !keep.has(p) && isSafeRelative(p) && STORE_PREFIXES.some((x) => p.startsWith(x)))
    .sort();
}
