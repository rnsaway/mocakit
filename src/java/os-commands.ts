import type { MocaRow } from '../types.js';

/**
 * Fixed, read-only shell command templates run through the MOCA command
 * `execute os command`. Nothing here writes on the server; the only
 * redirections are `2>/dev/null` (posix) and `2>nul` (windows).
 */

export type OsFamily = 'posix' | 'windows';

/**
 * Paths are only used when every character is in this set. `$` is allowed (inner-class files such
 * as `Widget$1.class`): posix paths sit in shell single quotes, windows paths in cmd double quotes
 * or PowerShell single-quoted strings, and `$` is literal in all three. `'`, `"` and `%` are never allowed.
 */
export const SAFE_PATH = /^[A-Za-z0-9._/\\:+@ $-]+$/;

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DETECT_POSIX = 'uname -s';
export const DETECT_WINDOWS = 'ver';

export function isSafePath(path: string): boolean {
  return SAFE_PATH.test(path);
}

/** True when the templates for `family` accept `path` (posix also needs an absolute path without a backslash). */
export function isUsablePath(family: OsFamily, path: string): boolean {
  if (!isSafePath(path)) return false;
  return family === 'windows' || (!path.includes('\\') && path.startsWith('/'));
}

/** Concatenate the `result` columns in order (the server cuts stdout into chunks, not lines). */
export function joinRows(rows: MocaRow[]): string {
  return rows.map((r) => (r.result == null ? '' : String(r.result))).join('');
}

export const FILE_SEPARATOR = (n: number): string => `==MOCAKIT-FILE ${n}==`;

export interface OsCommands {
  family: OsFamily;
  classpathSeparator: ':' | ';';
  readVar(name: string): string;
  /** stdout lines "<size> <path>" */
  listJars(dir: string): string;
  /** recursive *.class, "<size> <path>" */
  listClasses(dir: string): string;
  /** "<size> <path>" per existing file; a missing file produces no line */
  statFiles(paths: string[]): string;
  checksums(paths: string[]): string;
  /** separator line then one base64 line per file */
  readFilesBase64(paths: string[]): string;
  readRangeBase64(path: string, offset: number, length: number): string;
  hasUnzip(): string;
  /** posix only; windows throws */
  listZip(path: string): string;
}

function safe(path: string): string {
  if (!isSafePath(path)) throw new Error(`Unsafe path: ${JSON.stringify(path)}`);
  return path;
}

function safeList(paths: string[]): string[] {
  if (paths.length === 0) throw new Error('No paths given');
  return paths.map(safe);
}

/** Posix paths sit inside shell single quotes (`$` stays literal): no backslash, and absolute so a leading "-" is never read as an option. */
function safePosix(path: string): string {
  safe(path);
  if (path.includes('\\') || !path.startsWith('/')) {
    throw new Error(`Unsafe posix path (must be absolute, no backslash): ${JSON.stringify(path)}`);
  }
  return path;
}

function safePosixList(paths: string[]): string[] {
  if (paths.length === 0) throw new Error('No paths given');
  return paths.map(safePosix);
}

function safeName(name: string): string {
  if (!VAR_NAME.test(name)) throw new Error(`Invalid variable name: ${JSON.stringify(name)}`);
  return name;
}

function checkRange(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`Invalid offset: ${offset}`);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error(`Invalid length: ${length}`);
}

function stripTrailingSeparators(dir: string, seps: RegExp): string {
  const d = safe(dir);
  const t = d.replace(seps, '');
  return t === '' ? d : t;
}

/** cmd.exe double quotes (windows). */
const quoted = (p: string): string => `"${p}"`;
/** Shell single quotes (posix); SAFE_PATH excludes `'`, so nothing can close them early. */
const sq = (p: string): string => `'${p}'`;

export const POSIX: OsCommands = {
  family: 'posix',
  classpathSeparator: ':',
  readVar: (name) => `printenv ${safeName(name)}`,
  listJars: (dir) => `stat -L -c "%s %n" ${sq(stripTrailingSeparators(safePosix(dir), /\/+$/))}/*.jar 2>/dev/null; true`,
  listClasses: (dir) =>
    `find -L ${sq(safePosix(dir))} -type f -name "*.class" -printf "%s %p\\n" 2>/dev/null; true`,
  statFiles: (paths) => `stat -L -c "%s %n" ${safePosixList(paths).map(sq).join(' ')} 2>/dev/null; true`,
  checksums: (paths) => `sha256sum ${safePosixList(paths).map(sq).join(' ')}`,
  readFilesBase64: (paths) =>
    safePosixList(paths)
      .map((p, i) => `echo "${FILE_SEPARATOR(i)}"; base64 -w 0 ${sq(p)}; echo`)
      .join('; '),
  readRangeBase64: (path, offset, length) => {
    checkRange(offset, length);
    return `tail -c +${offset + 1} ${sq(safePosix(path))} | head -c ${length} | base64 -w 0`;
  },
  hasUnzip: () => 'command -v unzip; true',
  listZip: (path) => `unzip -Z1 ${sq(safePosix(path))}`,
};

const PS_PREFIX = 'powershell -NoProfile -Command';
const PS_OPEN = "[IO.File]::Open($p,'Open','Read','ReadWrite')";

export const WINDOWS: OsCommands = {
  family: 'windows',
  classpathSeparator: ';',
  readVar: (name) => `cmd /c echo %${safeName(name)}%`,
  listJars: (dir) =>
    `cmd /c for %f in ("${stripTrailingSeparators(dir, /[\\/]+$/)}\\*.jar") do @echo %~zf %f`,
  listClasses: (dir) => `cmd /c for /r "${safe(dir)}" %f in (*.class) do @echo %~zf %f`,
  statFiles: (paths) =>
    `cmd /c for %f in (${safeList(paths).map(quoted).join(' ')}) do @if exist %f @echo %~zf %f`,
  checksums: (paths) =>
    safeList(paths)
      .map((p) => `certutil -hashfile "${p}" SHA256`)
      .join(' & '),
  readFilesBase64: (paths) => {
    const list = safeList(paths)
      .map((p) => `'${p}'`)
      .join(',');
    const script =
      `$i=0; foreach($p in @(${list})){ ('==MOCAKIT-FILE '+$i+'=='); ` +
      `$f=${PS_OPEN}; try{ $m=New-Object IO.MemoryStream; $f.CopyTo($m); ` +
      `[Convert]::ToBase64String($m.ToArray()) } finally { $f.Close() }; $i++ }`;
    return `${PS_PREFIX} "${script}"`;
  },
  readRangeBase64: (path, offset, length) => {
    checkRange(offset, length);
    const script =
      `$p='${safe(path)}'; $f=${PS_OPEN}; try{ $null=$f.Seek(${offset},'Begin'); ` +
      `$b=New-Object byte[] ${length}; $n=$f.Read($b,0,${length}); ` +
      `[Convert]::ToBase64String($b,0,$n) } finally { $f.Close() }`;
    return `${PS_PREFIX} "${script}"`;
  },
  hasUnzip: () => 'cmd /c where unzip 2>nul',
  listZip: () => {
    throw new Error('Listing zip entries is only supported on posix servers');
  },
};

/**
 * Value of an environment variable from `readVar` output. On windows an unset
 * variable echoes the literal `%NAME%`; that and empty output mean "empty".
 */
export function parseVarOutput(family: OsFamily, name: string, text: string): string {
  const value = text.replace(/\r/g, '').split('\n')[0]?.trim() ?? '';
  if (family === 'windows' && value === `%${name}%`) return '';
  return value;
}

/** Parse "<size> <path>" lines; the path may contain spaces and may be wrapped in double quotes. */
export function parseSizeLines(text: string): Array<{ size: number; path: string }> {
  const out: Array<{ size: number; path: string }> = [];
  for (const raw of text.split('\n')) {
    const m = /^(\d+) (.+)$/.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    let path = m[2]!;
    if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    out.push({ size: Number(m[1]), path });
  }
  return out;
}

/** Parse sha256sum (posix) or certutil (windows) output into path -> lowercase hex. */
export function parseChecksums(family: OsFamily, text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (family === 'posix') {
    for (const line of lines) {
      const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
      if (m) out.set(m[2]!, m[1]!.toLowerCase());
    }
    return out;
  }
  let current: string | null = null;
  for (const line of lines) {
    const head = /^SHA256 hash of (?:file )?(.+):$/i.exec(line.trim());
    if (head) {
      current = head[1]!;
      continue;
    }
    if (current !== null && /^[0-9a-fA-F ]+$/.test(line.trim()) && line.trim() !== '') {
      const hex = line.replace(/ /g, '').toLowerCase();
      if (hex.length === 64) out.set(current, hex);
      current = null;
    }
  }
  return out;
}

/** Split `readFilesBase64` output into index -> base64 (empty string for an empty file). */
export function splitFileBatch(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const sep = /^==MOCAKIT-FILE (\d+)==$/;
  for (let i = 0; i < lines.length; i++) {
    const m = sep.exec(lines[i]!);
    if (!m) continue;
    const next = lines[i + 1];
    out.set(Number(m[1]), next === undefined || sep.test(next) ? '' : next);
  }
  return out;
}
