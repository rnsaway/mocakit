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

/** Split a CLASSPATH value into typed entries (empty items and repeated raw values dropped). */
export function parseClasspath(value: string, separator: ':' | ';'): ParsedEntry[] {
  const family: OsFamily = separator === ';' ? 'windows' : 'posix';
  const seen = new Set<string>();
  const out: ParsedEntry[] = [];
  for (const piece of value.split(separator)) {
    const raw = piece.trim();
    if (raw === '' || seen.has(raw)) continue;
    seen.add(raw);
    let path = raw;
    let type: EntryType;
    if (/[\\/]\*$/.test(raw)) {
      type = 'dir-wildcard';
      path = trimTrailingSeparators(raw.slice(0, -1), family);
    } else if (raw.toLowerCase().endsWith('.jar')) {
      type = 'jar';
    } else {
      type = 'dir';
    }
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

/** Turn configured roots into absolute folders: `$LESDIR`, a sibling name, or an absolute path. */
export function resolveRoots(roots: string[], lesDir: string, family: OsFamily): string[] {
  const api = pathApi(family);
  const les = normalize(lesDir, family);
  return roots.map((root) => {
    if (root === '$LESDIR') return les;
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

function componentOf(path: string, lesDir: string, family: OsFamily): string {
  return locate(path, lesDir, family).name;
}

/** Distinct components in first-seen order. */
export function componentsOf(entries: Array<{ path: string }>, lesDir: string, family: OsFamily): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (!pathApi(family).isAbsolute(e.path)) continue;
    const c = componentOf(e.path, lesDir, family);
    if (!out.includes(c)) out.push(c);
  }
  return out;
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
  lesDir: string,
  family: OsFamily,
): { entries: ClasspathEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const resolved = resolveRoots(roots, lesDir, family);
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
        `java.roots: "${root}" matches no classpath entry (components: ${componentsOf(entries, lesDir, family).join(', ')})`,
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
