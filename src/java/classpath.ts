import { posix, win32 } from 'node:path';
import type { OsFamily } from './os-commands.js';

export type EntryType = 'jar' | 'dir-wildcard' | 'dir';

export interface ParsedEntry {
  index: number;
  raw: string;
  path: string;
  type: EntryType;
  /** False when the path is not absolute for its OS family; such entries are never selected. */
  usable: boolean;
}

export interface ClasspathEntry extends ParsedEntry {
  component: string;
  selected: boolean;
  slug: string;
}

function pathApi(family: OsFamily): typeof posix {
  return family === 'windows' ? win32 : posix;
}

/** Drop trailing separators, keeping a bare root such as `/` or `C:\`. */
function trimTrailingSeparators(p: string, family: OsFamily): string {
  const api = pathApi(family);
  let out = p;
  while (out.length > 1 && (out.endsWith('/') || (family === 'windows' && out.endsWith('\\')))) {
    if (api.parse(out).root === out) break;
    out = out.slice(0, -1);
  }
  return out;
}

function normalize(p: string, family: OsFamily): string {
  return trimTrailingSeparators(pathApi(family).normalize(p), family);
}

/**
 * Collapse repeated separators and `.` segments, and drop trailing separators (windows also turns
 * `/` into `\`). `..` is kept: it is the server's to resolve, not the local OS's.
 */
function tidyPath(p: string, family: OsFamily): string {
  const api = pathApi(family);
  const slashed = family === 'windows' ? p.replace(/\//g, '\\') : p;
  const root = api.parse(slashed).root;
  const parts = slashed
    .slice(root.length)
    .split(family === 'windows' ? /\\+/ : /\/+/)
    .filter((s) => s !== '' && s !== '.');
  const tidy = root + parts.join(family === 'windows' ? '\\' : '/');
  return tidy === '' ? p : tidy;
}

/** Split a CLASSPATH value into typed entries (empty items, and entries repeating an earlier one once tidied, dropped). */
export function parseClasspath(value: string, separator: ':' | ';'): ParsedEntry[] {
  const family: OsFamily = separator === ';' ? 'windows' : 'posix';
  const seen = new Set<string>();
  const out: ParsedEntry[] = [];
  for (const piece of value.split(separator)) {
    const raw = piece.trim();
    if (raw === '') continue;
    let path: string;
    let type: EntryType;
    if (/[\\/]\*$/.test(raw)) {
      type = 'dir-wildcard';
      path = tidyPath(raw.slice(0, -1), family);
    } else {
      type = raw.toLowerCase().endsWith('.jar') ? 'jar' : 'dir';
      path = tidyPath(raw, family);
    }
    const key = `${type}\n${family === 'windows' ? path.toLowerCase() : path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ index: out.length, raw, path, type, usable: pathApi(family).isAbsolute(path) });
  }
  return out;
}

/** True when `path` is `root` or lies under it. Windows compares case-insensitively (win32.relative does). */
function isUnder(path: string, root: string, family: OsFamily): boolean {
  const api = pathApi(family);
  const rel = api.relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

/** A root naming a server environment variable (`$LESDIR` is one). */
export const VARIABLE_ROOT = /^\$[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Throws unless `root` is `$LESDIR`, a `$NAME` server variable, an absolute path, or a single folder
 * name (not empty or blank, not `.` or `..`, no `/` or `\`). Without a family, a path absolute on
 * either family is accepted (the server's family is not known at config time).
 */
export function checkRoot(root: string, family?: OsFamily): void {
  if (VARIABLE_ROOT.test(root)) return;
  const absolute = family !== undefined ? pathApi(family).isAbsolute(root) : posix.isAbsolute(root) || win32.isAbsolute(root);
  if (absolute) return;
  const name = root.trim();
  if (name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(root)) return;
  throw new Error(
    `java.roots: "${root}" is not $LESDIR, a $NAME server variable, the name of a folder next to $LESDIR, or an absolute path`,
  );
}

/** Server environment variables by name (without `$`); `LESDIR` is always present. */
export type RootVariables = ReadonlyMap<string, string>;

/** True when `value` can stand for a `$NAME` root: one absolute path, not a list. */
export function isFolderValue(value: string, family: OsFamily): boolean {
  return value !== '' && !value.includes(family === 'windows' ? ';' : ':') && pathApi(family).isAbsolute(value);
}

function lesDirOf(variables: RootVariables): string {
  const lesDir = variables.get('LESDIR');
  if (lesDir === undefined) throw new Error('Java introspection: LESDIR is empty on the server');
  return lesDir;
}

/** Turn configured roots into absolute folders: `$LESDIR`, a `$NAME` variable, a sibling name, or an absolute path. */
export function resolveRoots(roots: string[], variables: RootVariables, family: OsFamily): string[] {
  const api = pathApi(family);
  const les = normalize(lesDirOf(variables), family);
  return roots.map((root) => {
    if (root === '$LESDIR') return les;
    if (VARIABLE_ROOT.test(root)) {
      const value = variables.get(root.slice(1));
      if (value === undefined || !isFolderValue(value, family)) {
        throw new Error(`java.roots: "${root}" is not set to an absolute folder on the server`);
      }
      return normalize(value, family);
    }
    if (api.isAbsolute(root)) return normalize(root, family);
    return normalize(api.join(api.dirname(les), root), family);
  });
}

/** Component for absolute entries outside dirname(lesDir); a safe single folder name. */
const EXTERNAL = 'external';

/** Component name and its folder: the first path segment under dirname(lesDir), or `external` when outside it. */
function locate(path: string, lesDir: string, family: OsFamily): { name: string; dir: string } {
  const api = pathApi(family);
  const base = api.dirname(normalize(lesDir, family));
  const p = normalize(path, family);
  if (p !== base && isUnder(p, base, family)) {
    const name = api.relative(base, p).split(/[\\/]/)[0];
    return { name, dir: api.join(base, name) };
  }
  return { name: EXTERNAL, dir: '' };
}

/** Slug of the entry's path below its component (separators become `-`). */
function baseSlug(entry: ParsedEntry, componentPath: string, family: OsFamily): string {
  const api = pathApi(family);
  const p = normalize(entry.path, family);
  let rel = componentPath !== '' && isUnder(p, componentPath, family) ? api.relative(componentPath, p) : p;
  if (rel === '') rel = api.basename(componentPath);
  let slug = rel
    .split(/[\\/:]+/)
    .filter((s) => s !== '')
    .join('-');
  if (slug.toLowerCase().endsWith('.jar')) slug = slug.slice(0, -4);
  if (slug.endsWith('-*')) slug = slug.slice(0, -2);
  return slug;
}

/**
 * Classify every entry: component, whether it lies under a root, and a slug
 * unique within its component (`-2`, `-3` appended in index order on collision).
 */
export function selectEntries(
  entries: ParsedEntry[],
  roots: string[],
  variables: RootVariables,
  family: OsFamily,
): { entries: ClasspathEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  for (const root of roots) checkRoot(root, family);
  const lesDir = lesDirOf(variables);
  const resolved = resolveRoots(roots, variables, family);
  const used = new Map<string, Set<string>>();
  const out: ClasspathEntry[] = entries.map((e) => {
    if (!e.usable) {
      warnings.push(`classpath entry "${e.raw}" is not an absolute path; skipped`);
      return { ...e, component: '', slug: '', selected: false };
    }
    const { name: component, dir: componentPath } = locate(e.path, lesDir, family);
    const key = family === 'windows' ? component.toLowerCase() : component;
    const taken = used.get(key) ?? new Set<string>();
    used.set(key, taken);
    const first = baseSlug(e, componentPath, family);
    let slug = first;
    for (let n = 2; taken.has(slug); n++) slug = `${first}-${n}`;
    taken.add(slug);
    const p = normalize(e.path, family);
    return { ...e, component, slug, selected: resolved.some((r) => isUnder(p, r, family)) };
  });
  roots.forEach((root, i) => {
    const r = resolved[i];
    if (!out.some((e) => e.usable && isUnder(normalize(e.path, family), r, family))) {
      throw new Error(
        `java.roots: "${root}" matches no classpath entry; use $LESDIR, a $NAME server variable, the name of a folder next to $LESDIR, or an absolute path`,
      );
    }
  });
  return { entries: out, warnings };
}

/**
 * Name for a per-file output: `<entry.slug>-<jar name>` for a JAR found in a
 * wildcard folder, otherwise the entry slug (classes folders, and explicit
 * JAR entries whose slug already ends in the JAR name).
 */
export function fileSlug(entry: ClasspathEntry, serverPath: string, family: OsFamily): string {
  if (entry.type === 'jar' || !serverPath.toLowerCase().endsWith('.jar')) return entry.slug;
  const name = pathApi(family).basename(serverPath.replace(/\\/g, family === 'windows' ? '\\' : '/'));
  return `${entry.slug}-${name.slice(0, -4)}`;
}
