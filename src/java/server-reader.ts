import { createHash } from 'node:crypto';
import type { MocaClient } from '../client/client.js';
import { quoteMocaString } from '../client/render.js';
import { MocaCommandError } from '../errors.js';
import { checkRoot, isFolderValue, parseClasspath, selectEntries, VARIABLE_ROOT, type ClasspathEntry } from './classpath.js';
import {
  DETECT_POSIX,
  DETECT_WINDOWS,
  POSIX,
  WINDOWS,
  isUsablePath,
  joinRows,
  parseChecksums,
  parseSizeLines,
  parseVarOutput,
  splitFileBatch,
  type OsCommands,
  type OsFamily,
} from './os-commands.js';

/** Runs one OS command on the server and returns its joined stdout; throws `MocaCommandError` on a non-zero exit. */
export type OsExec = (command: string) => Promise<string>;

export function osExecFor(client: MocaClient): OsExec {
  return async (command) =>
    joinRows(await client.exec(`execute os command where cmd = ${quoteMocaString(command)}`, { convert: false }));
}

export interface ServerFile {
  entryIndex: number;
  path: string;
  size: number;
  sha256: string;
  /** Absent when the file was cached. */
  bytes?: Uint8Array;
}

export interface JavaServerRead {
  family: OsFamily;
  lesDir: string;
  classpath: string;
  entries: ClasspathEntry[];
  /** Selected entries only, sorted by entryIndex then path. */
  files: ServerFile[];
  /** Entry indexes of `jar` and `dir` entries that do not exist on the server. */
  missing: number[];
  /** Unselected JAR path to its class entry names (posix with unzip only). */
  zipListings: Map<string, string[]>;
  warnings: string[];
}

export interface ReadJavaServerOptions {
  roots: string[];
  maxFileSize: number;
  /** True means the file with this sha256 is already stored and need not be downloaded. */
  cached: (sha256: string) => boolean;
  batchBytes?: number;
  rangeBytes?: number;
  checksumBatch?: number;
}

const MIB = 1024 * 1024;
/** Files per download batch (a fixed command-size guard, independent of the checksum batch size). */
const MAX_DOWNLOAD_FILES = 50;
/** cmd.exe stops at 8,191 characters; stay well below that for every command. */
const MAX_COMMAND_LENGTH = 7000;

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function unavailable(status: number): Error {
  return new Error(
    `Java introspection needs the MOCA command "execute os command", which is unavailable on this server (status ${status})`,
  );
}

async function detectFamily(exec: OsExec): Promise<OsFamily> {
  try {
    await exec(DETECT_POSIX);
    return 'posix';
  } catch (error) {
    if (!(error instanceof MocaCommandError)) throw error;
  }
  try {
    await exec(DETECT_WINDOWS);
    return 'windows';
  } catch (error) {
    if (error instanceof MocaCommandError) throw unavailable(error.status);
    throw error;
  }
}

/** Value of a server environment variable; '' when it is unset or empty. */
async function readVarValue(exec: OsExec, family: OsFamily, cmds: OsCommands, name: string): Promise<string> {
  let text = '';
  try {
    text = await exec(cmds.readVar(name));
  } catch (error) {
    // printenv exits 1 for an unset variable; any other failure is a real error.
    if (!(error instanceof MocaCommandError) || error.status !== 1) throw error;
  }
  return parseVarOutput(family, name, text);
}

async function readVar(exec: OsExec, family: OsFamily, cmds: OsCommands, name: string): Promise<string> {
  const value = await readVarValue(exec, family, cmds, name);
  if (value === '') throw new Error(`Java introspection: ${name} is empty on the server`);
  return value;
}

/** `LESDIR` plus every `$NAME` root, each read once; a `$NAME` must hold one absolute, usable folder. */
async function readRootVariables(
  exec: OsExec,
  family: OsFamily,
  cmds: OsCommands,
  lesDir: string,
  roots: string[],
): Promise<Map<string, string>> {
  const variables = new Map([['LESDIR', lesDir]]);
  for (const root of roots) {
    checkRoot(root, family);
    if (!VARIABLE_ROOT.test(root) || variables.has(root.slice(1))) continue;
    const value = await readVarValue(exec, family, cmds, root.slice(1));
    if (!isFolderValue(value, family) || !isUsablePath(family, value)) {
      throw new Error(`java.roots: "${root}" is not set to an absolute folder on the server`);
    }
    variables.set(root.slice(1), value);
  }
  return variables;
}

/** Split items into chunks of at most `maxCount` whose command stays short and that `accept` allows (a single item always fits). */
function chunked<T>(items: T[], maxCount: number, build: (chunk: T[]) => string, accept: (chunk: T[]) => boolean = () => true): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    const next = [...current, item];
    if (current.length > 0 && (next.length > maxCount || build(next).length > MAX_COMMAND_LENGTH || !accept(next))) {
      out.push(current);
      current = [item];
    } else {
      current = next;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

interface Listed {
  entryIndex: number;
  path: string;
  size: number;
}

export async function readJavaServer(exec: OsExec, options: ReadJavaServerOptions): Promise<JavaServerRead> {
  const batchBytes = options.batchBytes ?? MIB;
  const rangeBytes = options.rangeBytes ?? MIB;
  const checksumBatch = options.checksumBatch ?? 50;

  const family = await detectFamily(exec);
  const cmds = family === 'windows' ? WINDOWS : POSIX;
  const norm = (p: string): string => (family === 'windows' ? p.toLowerCase() : p);
  const warnings: string[] = [];

  const lesDir = await readVar(exec, family, cmds, 'LESDIR');
  const classpath = await readVar(exec, family, cmds, 'CLASSPATH');

  const variables = await readRootVariables(exec, family, cmds, lesDir, options.roots);
  const selection = selectEntries(parseClasspath(classpath, cmds.classpathSeparator), options.roots, variables, family);
  const entries = selection.entries;
  warnings.push(...selection.warnings);

  const skipUnsafe = (path: string): void => {
    warnings.push(`skipping ${path}: the path contains characters that are not allowed`);
  };
  const usable: ClasspathEntry[] = [];
  for (const e of entries) {
    if (!e.usable) continue; // already warned by selectEntries
    if (isUsablePath(family, e.path)) usable.push(e);
    else skipUnsafe(e.path);
  }

  const unselected = usable.filter((e) => !e.selected && (e.type === 'jar' || e.type === 'dir-wildcard'));
  let unzipAvailable = false;
  if (unselected.length > 0) {
    if (family === 'posix') {
      try {
        unzipAvailable = (await exec(cmds.hasUnzip())).trim() !== '';
      } catch (error) {
        if (!(error instanceof MocaCommandError)) throw error;
      }
    }
    if (!unzipAvailable) {
      warnings.push('unzip is not available on the server; classes of non-downloaded entries are unknown');
    }
  }

  const canon = (p: string): string => (family === 'windows' ? p.toLowerCase().replace(/\\/g, '/') : p);
  /** Listed paths must lie where the command looked: the wildcard folder itself, or anywhere below a classes folder. */
  const inEntry = (e: ClasspathEntry, path: string): boolean => {
    const entry = canon(e.path);
    const p = canon(path);
    if (e.type === 'dir-wildcard') return p.slice(0, p.lastIndexOf('/')) === entry.replace(/\/+$/, '');
    return p.startsWith(entry.endsWith('/') ? entry : `${entry}/`);
  };
  const accept = (e: ClasspathEntry, text: string, suffix: string): Listed[] => {
    const entryIndex = e.index;
    const out: Listed[] = [];
    for (const { size, path } of parseSizeLines(text)) {
      if (!inEntry(e, path)) {
        warnings.push(`ignored unexpected listing line for ${e.path}: ${path}`);
        continue;
      }
      if (!path.toLowerCase().endsWith(suffix)) continue;
      if (!isUsablePath(family, path)) {
        skipUnsafe(path);
        continue;
      }
      out.push({ entryIndex, path, size });
    }
    return out;
  };

  const missing: number[] = [];
  const listed: Listed[] = [];
  const selectedJars = usable.filter((e) => e.selected && e.type === 'jar');
  for (const e of usable.filter((x) => x.selected)) {
    if (e.type === 'dir-wildcard') {
      listed.push(...accept(e, await exec(cmds.listJars(e.path)), '.jar'));
    } else if (e.type === 'dir') {
      const found = accept(e, await exec(cmds.listClasses(e.path)), '.class');
      listed.push(...found);
      if (found.length === 0) {
        const there = parseSizeLines(await exec(cmds.statFiles([e.path]))).filter((l) => canon(l.path) === canon(e.path));
        if (there.length === 0) missing.push(e.index);
      }
    }
  }

  const sizes = new Map<string, number>();
  for (const chunk of chunked(selectedJars, checksumBatch, (c) => cmds.statFiles(c.map((e) => e.path)))) {
    for (const { size, path } of parseSizeLines(await exec(cmds.statFiles(chunk.map((e) => e.path))))) {
      sizes.set(norm(path), size);
    }
  }
  for (const e of selectedJars) {
    const size = sizes.get(norm(e.path));
    if (size === undefined) missing.push(e.index);
    else listed.push({ entryIndex: e.index, path: e.path, size });
  }
  for (const index of missing) {
    const entry = entries[index]!;
    warnings.push(`classpath entry ${entry.path} does not exist on the server`);
  }

  // Skip oversized files, and files listed twice in the same entry.
  const seen = new Set<string>();
  const candidates: Listed[] = [];
  for (const f of listed) {
    const key = `${f.entryIndex}\n${norm(f.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (f.size > options.maxFileSize) {
      warnings.push(`skipping ${f.path}: ${f.size} bytes is over maxFileSize (${options.maxFileSize})`);
      continue;
    }
    candidates.push(f);
  }
  candidates.sort((a, b) => a.entryIndex - b.entryIndex || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // One checksum and one download per distinct path, however many entries list it.
  const distinct = new Map<string, Listed>();
  for (const f of candidates) if (!distinct.has(norm(f.path))) distinct.set(norm(f.path), f);
  const unique = [...distinct.values()];

  const hashes = new Map<string, string>();
  for (const chunk of chunked(unique, checksumBatch, (c) => cmds.checksums(c.map((f) => f.path)))) {
    const parsed = parseChecksums(family, await exec(cmds.checksums(chunk.map((f) => f.path))));
    const byPath = new Map([...parsed].map(([p, h]) => [norm(p), h]));
    for (const f of chunk) {
      const hash = byPath.get(norm(f.path));
      if (hash === undefined) throw new Error(`no checksum returned for ${f.path}`);
      hashes.set(norm(f.path), hash);
    }
  }

  const verified = (f: Listed, data: Uint8Array): Uint8Array => {
    const expected = hashes.get(norm(f.path))!;
    const actual = sha256Of(data);
    if (data.length !== f.size || actual !== expected) {
      throw new Error(`checksum mismatch for ${f.path} (server ${expected}, downloaded ${actual})`);
    }
    return data;
  };

  const downloads = new Map<string, Uint8Array>();
  const pending = unique.filter((f) => !options.cached(hashes.get(norm(f.path))!));
  const small = pending.filter((f) => f.size <= rangeBytes);
  const large = pending.filter((f) => f.size > rangeBytes);

  const batches = chunked(
    small,
    MAX_DOWNLOAD_FILES,
    (c) => cmds.readFilesBase64(c.map((f) => f.path)),
    (c) => c.reduce((sum, f) => sum + f.size, 0) <= batchBytes,
  );
  for (const batch of batches) {
    const parts = splitFileBatch(await exec(cmds.readFilesBase64(batch.map((f) => f.path))));
    batch.forEach((f, i) => {
      downloads.set(norm(f.path), verified(f, Buffer.from(parts.get(i) ?? '', 'base64')));
    });
  }
  for (const f of large) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < f.size; offset += rangeBytes) {
      const text = await exec(cmds.readRangeBase64(f.path, offset, Math.min(rangeBytes, f.size - offset)));
      chunks.push(Buffer.from(text.replace(/\s+/g, ''), 'base64'));
    }
    downloads.set(norm(f.path), verified(f, Buffer.concat(chunks)));
  }

  const files: ServerFile[] = candidates.map((f) => {
    const file: ServerFile = { entryIndex: f.entryIndex, path: f.path, size: f.size, sha256: hashes.get(norm(f.path))! };
    const bytes = downloads.get(norm(f.path));
    if (bytes !== undefined) file.bytes = bytes;
    return file;
  });

  const zipListings = new Map<string, string[]>();
  if (unzipAvailable) {
    const toList = new Set<string>();
    for (const e of unselected) {
      if (e.type === 'jar') toList.add(e.path);
      else for (const f of accept(e, await exec(cmds.listJars(e.path)), '.jar')) toList.add(f.path);
    }
    for (const path of toList) {
      try {
        const names = (await exec(cmds.listZip(path)))
          .split('\n')
          .map((l) => l.replace(/\r$/, ''))
          .filter((l) => l.endsWith('.class'));
        zipListings.set(path, names);
      } catch (error) {
        if (!(error instanceof MocaCommandError)) throw error;
        warnings.push(`could not list the classes of ${path}`);
      }
    }
  }

  missing.sort((a, b) => a - b);
  return { family, lesDir, classpath, entries, files, missing, zipListings, warnings };
}
