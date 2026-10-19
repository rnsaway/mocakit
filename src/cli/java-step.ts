import { lstat, mkdir, readdir, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep, win32 } from 'node:path';
import { writeDocs } from '../codegen/docs-writer.js';
import { emitJavaDocs } from '../codegen/emit-java-docs.js';
import type { CommandInfo } from '../codegen/introspect-agent.js';
import type { JavaConfig, MocakitConfig } from '../define-config.js';
import { checkRoot, fileSlug, type ClasspathEntry } from '../java/classpath.js';
import { checkDecompiler, decompile, decompilerHash, inputHash, needsDecompile, type DecompilerConfig } from '../java/decompile.js';
import { classifyEntry, classNameOf, jarFacts, linkCommands, overriddenClasses, type JarFacts, type JavaLink } from '../java/inventory.js';
import {
  cachedBytes,
  localPathFor,
  MANIFEST_FILE,
  readJavaManifest,
  sameJavaManifest,
  staleFiles,
  writeJavaManifest,
  type JavaEntryRecord,
  type JavaFileRecord,
  type JavaManifest,
} from '../java/manifest.js';
import type { OsFamily } from '../java/os-commands.js';
import type { JavaServerRead } from '../java/server-reader.js';
import { redactUrl } from '../util/url.js';

export interface ResolvedJava {
  dir: string;
  docs: boolean;
  roots: string[];
  custom: string[];
  libraries: string[];
  maxFileSize: number;
  decompiler: DecompilerConfig | null;
  decompileLibraries: boolean;
}

const MIB = 1024 * 1024;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function strings(options: Record<string, unknown>, field: 'custom' | 'libraries'): string[] {
  const value = options[field];
  if (value === undefined) return [];
  if (!isStringArray(value)) throw new Error(`java.${field} must be an array of strings`);
  return value;
}

function flag(options: Record<string, unknown>, field: 'docs' | 'decompileLibraries', fallback: boolean): boolean {
  const value = options[field];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`java.${field} must be true or false`);
  return value;
}

function decompilerOf(value: unknown): DecompilerConfig | null {
  if (value === undefined) return null;
  if (!isPlainObject(value) || typeof value.command !== 'string' || value.command === '' || !isStringArray(value.args)) {
    throw new Error('java.decompiler must be an object with a command string and an args array of strings');
  }
  if (value.timeoutMs !== undefined && !isPositive(value.timeoutMs)) throw new Error('java.decompiler.timeoutMs must be a positive number');
  return { command: value.command, args: value.args, ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}) };
}

/** Java settings from config + CLI flag, or `null` when Java introspection is off. */
export function resolveJavaSettings(config: MocakitConfig, flag_: boolean | undefined, configDir: string, out: string): ResolvedJava | null {
  const setting: unknown = config.java;
  if (setting !== undefined && typeof setting !== 'boolean' && !isPlainObject(setting)) throw new Error('config.java must be true, false or an object');
  if (flag_ === false || (flag_ === undefined && !setting)) return null;
  const options: Record<string, unknown> = isPlainObject(setting) ? (setting as JavaConfig as Record<string, unknown>) : {};
  const roots = options.roots;
  if (roots !== undefined && !(isStringArray(roots) && roots.length > 0)) throw new Error('java.roots must be a non-empty array of strings');
  if (roots !== undefined) for (const root of roots) checkRoot(root);
  if (options.dir !== undefined && typeof options.dir !== 'string') throw new Error('java.dir must be a string');
  if (options.maxFileSize !== undefined && !isPositive(options.maxFileSize)) throw new Error('java.maxFileSize must be a positive number of bytes');
  return {
    dir: typeof options.dir === 'string' ? resolve(configDir, options.dir) : resolve(dirname(out), 'moca-java'),
    docs: flag(options, 'docs', true),
    roots: (roots as string[] | undefined) ?? ['$LESDIR'],
    custom: strings(options, 'custom'),
    libraries: strings(options, 'libraries'),
    maxFileSize: (options.maxFileSize as number | undefined) ?? 25 * MIB,
    decompiler: decompilerOf(options.decompiler),
    decompileLibraries: flag(options, 'decompileLibraries', false),
  };
}

/** A manifest whose shape the cache and stale-file helpers can rely on; anything else counts as no manifest. */
function isUsableManifest(m: JavaManifest): boolean {
  const record = m as unknown as Record<string, unknown>;
  if (!Array.isArray(record.entries) || !isStringArray(record.src) || !Array.isArray(record.overridden)) return false;
  const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';
  const decompiler = record.decompiler;
  if (
    decompiler !== undefined &&
    !(
      isPlainObject(decompiler) &&
      typeof decompiler.command === 'string' &&
      isStringArray(decompiler.args) &&
      isPlainObject(decompiler.inputs) &&
      Object.values(decompiler.inputs).every((v) => typeof v === 'string')
    )
  ) {
    return false;
  }
  const commands = record.commands;
  if (
    commands !== undefined &&
    !(
      Array.isArray(commands) &&
      commands.every(
        (c: unknown) =>
          isPlainObject(c) &&
          typeof c.key === 'string' &&
          typeof c.name === 'string' &&
          typeof c.javaClass === 'string' &&
          typeof c.entry === 'string' &&
          optionalString(c.method),
      )
    )
  ) {
    return false;
  }
  const overridden: unknown[] = record.overridden;
  if (!overridden.every((o) => isPlainObject(o) && typeof o.className === 'string' && typeof o.winner === 'string' && isStringArray(o.losers))) {
    return false;
  }
  return m.entries.every(
    (e) =>
      isPlainObject(e) &&
      typeof e.path === 'string' &&
      Array.isArray(e.files) &&
      e.files.every((f) => isPlainObject(f) && typeof f.local === 'string' && typeof f.sha256 === 'string' && typeof f.path === 'string'),
  );
}

/**
 * The previous manifest in `dir` (null when missing, unreadable or damaged) and the bytes of every
 * file it lists whose local copy still matches its sha256, keyed by sha256.
 */
export async function loadPreviousJava(dir: string): Promise<{ previous: JavaManifest | null; cache: Map<string, Uint8Array> }> {
  const cache = new Map<string, Uint8Array>();
  const manifest = await readJavaManifest(dir);
  if (manifest === null || !isUsableManifest(manifest)) return { previous: null, cache };
  const lookup = cachedBytes(dir, manifest);
  for (const sha of new Set(manifest.entries.flatMap((e) => e.files.map((f) => f.sha256)))) {
    try {
      const bytes = await lookup(sha);
      if (bytes !== null) cache.set(sha, bytes);
    } catch {
      // An unreadable local copy is downloaded again.
    }
  }
  return { previous: manifest, cache };
}

/** `--from-snapshot`: the previous manifest, or the error telling the user to read the server first. */
export async function requirePreviousJava(dir: string): Promise<{ previous: JavaManifest; cache: Map<string, Uint8Array> }> {
  const loaded = await loadPreviousJava(dir);
  if (loaded.previous !== null) return { previous: loaded.previous, cache: loaded.cache };
  const there = await stat(dir).then(
    () => true,
    () => false,
  );
  if (!there) throw new Error(`Java introspection is enabled but ${dir} does not exist; run generate against a server first, or pass --no-java`);
  throw new Error(
    `Java introspection is enabled but ${join(dir, MANIFEST_FILE)} is missing or damaged; run generate against a server first, or pass --no-java`,
  );
}

export interface JavaOutput {
  manifest: JavaManifest;
  /** Local path (relative to the moca-java folder) to bytes. */
  binaries: Map<string, Uint8Array>;
  /** `src/...` path to decompiled source written this run. Unchanged earlier source is kept on disk and not listed. */
  sources: Map<string, string>;
  docs: Map<string, string> | null;
  links: Map<string, JavaLink>;
  stats: {
    entries: number;
    selected: number;
    files: number;
    bytes: number;
    downloaded: number;
    downloadedBytes: number;
    unchanged: number;
    decompiled: number;
    skippedLibraries: number;
  };
  warnings: string[];
}

export interface JavaContext {
  version: string;
  server: string;
  /** The moca-java folder (for checking kept source). */
  dir: string;
  /** Bytes of locally stored files by sha256 (see `loadPreviousJava`). */
  cache: ReadonlyMap<string, Uint8Array>;
  /** Command definitions from a live run; null under `--from-snapshot` (the manifest's commands are used). */
  commands: CommandInfo[] | null;
  /** Relative href from `entries/<component>/` to a command doc. */
  commandHref?: (key: string) => string | undefined;
}

/** One manifest entry with what this run knows about it. */
interface Item {
  record: JavaEntryRecord;
  /** Class names per file (null when unknown), aligned with `record.files`. */
  fileClasses: Array<string[] | null>;
  /** Bytes per file (null when unavailable), aligned with `record.files`. */
  fileBytes: Array<Uint8Array | null>;
  /** All classes the entry provides, or null when unknown. */
  classes: string[] | null;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pathApi = (family: OsFamily): typeof posix => (family === 'windows' ? win32 : posix);

/** The fields of a classpath entry that the path helpers read. */
function asClasspathEntry(r: JavaEntryRecord): ClasspathEntry {
  return { index: r.index, raw: r.path, path: r.path, type: r.type, usable: r.component !== '', component: r.component, slug: r.slug, selected: r.selected };
}

function zipClassNames(names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.class') || name.startsWith('META-INF/') || name.startsWith('/')) continue;
    const base = name.slice(0, -'.class'.length);
    if (base === 'module-info' || base.endsWith('/module-info')) continue;
    out.push(base.replace(/\//g, '.'));
  }
  return out;
}

function fileRecord(path: string, local: string, size: number, sha256: string, facts: JarFacts | null): JavaFileRecord {
  if (facts === null) return { path, local, size, sha256, classes: 1, readable: true };
  return {
    path,
    local,
    size,
    sha256,
    ...(facts.maven !== undefined ? { maven: facts.maven } : {}),
    ...(facts.version !== undefined ? { version: facts.version } : {}),
    classes: facts.classes.length,
    readable: facts.readable,
  };
}

const isJar = (path: string): boolean => path.toLowerCase().endsWith('.jar');

function unionOf(lists: Array<string[] | null>): string[] | null {
  if (lists.length === 0) return [];
  const known = lists.filter((l): l is string[] => l !== null);
  return known.length === 0 ? null : [...new Set(known.flat())];
}

function itemsFromServer(
  read: JavaServerRead,
  settings: ResolvedJava,
  ctx: JavaContext,
  warnings: string[],
  binaries: Map<string, Uint8Array>,
): Item[] {
  const api = pathApi(read.family);
  const canon = (p: string): string => (read.family === 'windows' ? p.toLowerCase().replace(/\\/g, '/') : p).replace(/\/+$/, '');
  const commandClasses = new Set((ctx.commands ?? []).map((c) => c.active.javaClass).filter((c): c is string => !!c));
  const missing = new Set(read.missing);
  return read.entries.map((e): Item => {
    const base = { index: e.index, path: e.path, type: e.type, component: e.component, slug: e.slug, selected: e.selected };
    if (!e.usable) {
      return { record: { ...base, component: '', slug: '', selected: false, missing: false, files: [] }, fileClasses: [], fileBytes: [], classes: null };
    }
    const files: JavaFileRecord[] = [];
    const fileClasses: Array<string[] | null> = [];
    const fileBytes: Array<Uint8Array | null> = [];
    const facts: JarFacts[] = [];
    for (const f of read.files.filter((x) => x.entryIndex === e.index)) {
      let local: string;
      try {
        local = localPathFor(e, f.path, read.family, read.lesDir);
      } catch (error) {
        warnings.push(`skipping ${f.path}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const bytes = f.bytes ?? ctx.cache.get(f.sha256);
      if (bytes === undefined) throw new Error(`Java introspection: no bytes for ${f.path}`);
      binaries.set(local, bytes);
      if (isJar(f.path)) {
        const jar = jarFacts(bytes);
        if (jar.warning !== undefined) warnings.push(`${f.path}: ${jar.warning}`);
        files.push(fileRecord(f.path, local, f.size, f.sha256, jar));
        fileClasses.push(jar.readable ? jar.classes : null);
        facts.push(jar);
      } else {
        const name = classNameOf(f.path, e.path);
        files.push(fileRecord(f.path, local, f.size, f.sha256, null));
        fileClasses.push([name]);
        facts.push({ classes: [name], readable: true });
      }
      fileBytes.push(bytes);
    }

    let names = files.map((f) => f.path);
    let classes: string[] | null;
    if (e.selected) {
      classes = unionOf(fileClasses);
    } else if (e.type === 'jar') {
      const listing = read.zipListings.get(e.path);
      classes = listing === undefined ? null : zipClassNames(listing);
      names = [e.path];
      facts.push({ classes: classes ?? [], readable: true });
    } else if (e.type === 'dir-wildcard') {
      const jars = [...read.zipListings.keys()].filter((k) => canon(api.dirname(k.replace(/\\/g, api.sep))) === canon(e.path)).sort(compare);
      const lists = jars.map((k) => zipClassNames(read.zipListings.get(k)!));
      classes = jars.length === 0 ? null : [...new Set(lists.flat())];
      names = jars;
      for (const list of lists) facts.push({ classes: list, readable: true });
    } else {
      classes = null;
    }
    if (e.selected && names.length === 0 && e.type === 'jar') {
      names = [e.path];
      facts.push({ classes: [], readable: true });
    }
    const kind = classifyEntry(names, facts, commandClasses, { custom: settings.custom, libraries: settings.libraries });
    return {
      record: { ...base, missing: missing.has(e.index), kind, files },
      fileClasses,
      fileBytes,
      classes,
    };
  });
}

function itemsFromManifest(previous: JavaManifest, ctx: JavaContext, warnings: string[]): Item[] {
  return previous.entries.map((record): Item => {
    const fileClasses: Array<string[] | null> = [];
    const fileBytes: Array<Uint8Array | null> = [];
    for (const f of record.files) {
      const bytes = ctx.cache.get(f.sha256) ?? null;
      fileBytes.push(bytes);
      if (!isJar(f.path)) {
        fileClasses.push([classNameOf(f.path, record.path)]);
      } else if (bytes === null) {
        warnings.push(`${f.local} is missing or changed locally; its classes are unknown`);
        fileClasses.push(null);
      } else {
        const jar = jarFacts(bytes);
        fileClasses.push(jar.readable ? jar.classes : null);
      }
    }
    return { record, fileClasses, fileBytes, classes: record.selected ? unionOf(fileClasses) : null };
  });
}

/** Local folder of a classes-folder entry (`classes/<component>/<path under component>`). */
function folderLocal(record: JavaEntryRecord, family: OsFamily, lesDir: string): string {
  const probe = '__mocakit__.class';
  try {
    const local = localPathFor(asClasspathEntry(record), pathApi(family).join(record.path, probe), family, lesDir);
    return local.slice(0, -(probe.length + 1));
  } catch {
    return `classes/${record.component}/${record.slug}`;
  }
}

interface DecompileInput {
  /** Key in `decompiler.inputs`: the JAR's local path or the classes folder's local path. */
  key: string;
  hash: string;
  /** `src/<component>/<slug>` */
  prefix: string;
  name: string;
  files: Map<string, Uint8Array> | null;
  library: boolean;
  /** Indexes into the item's files. */
  fileIndexes: number[];
}

function decompileInputs(item: Item, family: OsFamily, lesDir: string): DecompileInput[] {
  const r = item.record;
  if (!r.selected || r.missing || r.files.length === 0 || r.kind === undefined) return [];
  const library = r.kind === 'library';
  if (r.type === 'dir') {
    const folder = folderLocal(r, family, lesDir);
    const complete = item.fileBytes.every((b) => b !== null);
    const files = complete ? new Map(r.files.map((f, i) => [f.local.slice(folder.length + 1), item.fileBytes[i]!])) : null;
    return [
      {
        key: folder,
        hash: inputHash(r.files.map((f) => ({ path: f.local, sha256: f.sha256 }))),
        prefix: `src/${r.component}/${r.slug}`,
        name: r.path,
        files,
        library,
        fileIndexes: r.files.map((_, i) => i),
      },
    ];
  }
  return r.files.map((f, i) => {
    const bytes = item.fileBytes[i];
    const base = f.local.split('/').pop()!;
    return {
      key: f.local,
      hash: f.sha256,
      prefix: `src/${r.component}/${fileSlug(asClasspathEntry(r), f.path, family)}`,
      name: f.path,
      files: bytes === null ? null : new Map([[base, bytes]]),
      library,
      fileIndexes: [i],
    };
  });
}

const fileExists = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  );

/** The manifest as the docs show it: a classes folder is one file record (one page) instead of one per class file. */
function docsView(manifest: JavaManifest, items: Item[]): { manifest: JavaManifest; classes: Map<string, string[]> } {
  const classes = new Map<string, string[]>();
  const entries = items.map(({ record, fileClasses }) => {
    if (record.type !== 'dir' || record.files.length === 0) {
      record.files.forEach((f, i) => {
        const list = fileClasses[i];
        if (list !== null && list !== undefined) classes.set(f.local, list);
      });
      return record;
    }
    const local = folderLocal(record, manifest.os, manifest.lesDir);
    const known = fileClasses.filter((l): l is string[] => l !== null).flat();
    classes.set(local, known);
    const folder: JavaFileRecord = {
      path: record.path,
      local,
      size: record.files.reduce((sum, f) => sum + f.size, 0),
      sha256: inputHash(record.files.map((f) => ({ path: f.local, sha256: f.sha256 }))),
      classes: record.files.reduce((sum, f) => sum + f.classes, 0),
      readable: true,
    };
    return { ...record, files: [folder] };
  });
  return { manifest: { ...manifest, entries }, classes };
}

function commandsFromManifest(list: NonNullable<JavaManifest['commands']>): CommandInfo[] {
  return list.map((c) => ({
    name: c.name,
    key: c.key,
    active: { level: '', levelSeq: 0, javaClass: c.javaClass, ...(c.method !== undefined ? { cFunction: c.method } : {}) },
    overrides: [],
  }));
}

/**
 * Builds the manifest, files, source and docs of the moca-java folder. `read` null means
 * `--from-snapshot`: the previous manifest and the local files stand in for the server.
 */
export async function buildJavaOutput(
  read: JavaServerRead | null,
  previous: JavaManifest | null,
  settings: ResolvedJava,
  ctx: JavaContext,
): Promise<JavaOutput> {
  if (read === null && previous === null) throw new Error('Java introspection: no server read and no previous manifest');
  const warnings: string[] = [];
  const binaries = new Map<string, Uint8Array>();
  const family = read?.family ?? previous!.os;
  const lesDir = read?.lesDir ?? previous!.lesDir;
  const items = read !== null ? itemsFromServer(read, settings, ctx, warnings, binaries) : itemsFromManifest(previous!, ctx, warnings);
  const entries = items.map((i) => i.record);

  const overridden =
    read !== null ? overriddenClasses(items.map((i) => ({ path: i.record.path, classes: i.classes }))) : previous!.overridden;

  // Which entry provides each class: the first in classpath order. Under --from-snapshot the classes of
  // unselected entries are unknown, so the providers recorded on the last live run come first.
  const classIndex = new Map<string, string>();
  if (read === null) for (const c of previous!.commands ?? []) if (c.entry !== '' && !classIndex.has(c.javaClass)) classIndex.set(c.javaClass, c.entry);
  for (const item of items) for (const c of item.classes ?? []) if (!classIndex.has(c)) classIndex.set(c, item.record.path);
  const commands =
    ctx.commands !== null
      ? ctx.commands
          .filter((c) => !!c.active.javaClass)
          .map((c) => ({
            key: c.key,
            name: c.name,
            javaClass: c.active.javaClass!,
            ...(c.active.cFunction ? { method: c.active.cFunction } : {}),
            entry: classIndex.get(c.active.javaClass!) ?? '',
          }))
          .sort((a, b) => compare(a.key, b.key))
      : previous?.commands;

  // Decompile.
  const sources = new Map<string, string>();
  const src: string[] = [];
  const inputsDone: Record<string, string> = {};
  let decompiled = 0;
  let skippedLibraries = 0;
  const classPrefix = new Map<string, string>();
  const decompiler = settings.decompiler;
  const previousInputs =
    decompiler !== null && previous?.decompiler !== undefined && decompilerHash(previous.decompiler) === decompilerHash(decompiler)
      ? previous.decompiler.inputs
      : undefined;
  let checked = false;
  for (const item of items) {
    for (const input of decompileInputs(item, family, lesDir)) {
      for (const i of input.fileIndexes) {
        for (const c of item.fileClasses[i] ?? []) if (!classPrefix.has(c)) classPrefix.set(c, input.prefix);
      }
      if (input.library && !settings.decompileLibraries) {
        skippedLibraries++;
        continue;
      }
      if (decompiler === null) continue;
      const kept = (previous?.src ?? []).filter((p) => p.startsWith(`${input.prefix}/`));
      if (!needsDecompile(previousInputs, input.key, input.hash) && kept.length > 0) {
        const present = await Promise.all(kept.map((p) => fileExists(join(ctx.dir, ...p.split('/')))));
        if (present.every(Boolean)) {
          src.push(...kept);
          inputsDone[input.key] = input.hash;
          continue;
        }
      }
      if (input.files === null) {
        warnings.push(`cannot decompile ${input.name}: its local copy is missing or changed`);
        continue;
      }
      if (!checked) {
        await checkDecompiler(decompiler);
        checked = true;
      }
      const result = await decompile(decompiler, { name: input.name, files: input.files });
      if (!result.ok) {
        warnings.push(result.warning);
        continue;
      }
      if (result.cleanupWarning !== undefined) warnings.push(result.cleanupWarning);
      for (const [rel, text] of result.sources) {
        const path = `${input.prefix}/${rel}`;
        sources.set(path, text);
        src.push(path);
      }
      inputsDone[input.key] = input.hash;
      decompiled++;
    }
  }
  src.sort(compare);

  const manifest: JavaManifest = {
    mocakitVersion: ctx.version,
    generatedAt: new Date().toISOString(),
    server: read !== null ? redactUrl(ctx.server) : previous!.server,
    os: family,
    lesDir,
    roots: read !== null ? settings.roots : previous!.roots,
    entries,
    overridden,
    ...(decompiler !== null ? { decompiler: { command: decompiler.command, args: decompiler.args, inputs: inputsDone } } : {}),
    src,
    ...(commands !== undefined ? { commands } : {}),
  };

  // Command links.
  const srcSet = new Set(src);
  const sourceFor = (className: string): string | undefined => {
    const prefix = classPrefix.get(className);
    if (prefix === undefined) return undefined;
    const path = `${prefix}/${className.split('$')[0]!.split('.').join('/')}.java`;
    return srcSet.has(path) ? path : undefined;
  };
  const commandInfos = ctx.commands ?? commandsFromManifest(commands ?? []);
  const links = linkCommands(commandInfos, manifest, classIndex, sourceFor);

  let docs: Map<string, string> | null = null;
  if (settings.docs) {
    const view = docsView(manifest, items);
    docs = emitJavaDocs(view.manifest, {
      version: ctx.version,
      classes: view.classes,
      links,
      commandNames: new Map(commandInfos.map((c) => [c.key, c.name])),
      commandHref: ctx.commandHref,
    });
  }

  const allFiles = entries.flatMap((e) => e.files);
  const downloadedFiles = read !== null ? read.files.filter((f) => f.bytes !== undefined) : [];
  return {
    manifest,
    binaries,
    sources,
    docs,
    links,
    stats: {
      entries: entries.length,
      selected: entries.filter((e) => e.selected).length,
      files: read !== null ? read.files.length : allFiles.length,
      bytes: (read !== null ? read.files : allFiles).reduce((sum, f) => sum + f.size, 0),
      downloaded: downloadedFiles.length,
      downloadedBytes: downloadedFiles.reduce((sum, f) => sum + f.size, 0),
      unchanged: (read !== null ? read.files.length : allFiles.length) - downloadedFiles.length,
      decompiled,
      skippedLibraries,
    },
    warnings,
  };
}

/** `entries/<component>` folders to clean: existing ones plus those in `files`. */
async function entryDirs(dir: string, files: ReadonlyMap<string, string>): Promise<string[]> {
  const set = new Set<string>(['entries']);
  for (const key of files.keys()) {
    const parts = key.split('/');
    if (parts[0] === 'entries' && parts.length === 3) set.add(`entries/${parts[1]}`);
  }
  try {
    for (const entry of await readdir(join(dir, 'entries'), { withFileTypes: true })) if (entry.isDirectory()) set.add(`entries/${entry.name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return [...set].sort(compare);
}

async function sameContent(path: string, content: Uint8Array): Promise<boolean> {
  try {
    return Buffer.from(await readFile(path)).equals(Buffer.from(content.buffer, content.byteOffset, content.byteLength));
  } catch {
    return false;
  }
}

/**
 * Writes the moca-java folder (unchanged files are left alone) and removes the files the previous
 * manifest listed that this run no longer produces. A dry run writes and deletes nothing and
 * returns how many files would be removed.
 */
export async function writeJavaOutput(
  settings: ResolvedJava,
  output: JavaOutput,
  previous: JavaManifest | null,
  dryRun: boolean,
): Promise<{ removed: number }> {
  const root = resolve(settings.dir);
  /** The absolute path of `relative` when it lies inside the folder, else null. */
  const inside = (relative: string): string | null => {
    const full = resolve(root, ...relative.split('/'));
    return full.startsWith(root + sep) ? full : null;
  };
  const stale: string[] = [];
  for (const relative of staleFiles(previous, output.manifest)) {
    const full = inside(relative);
    if (full === null) continue;
    const info = await lstat(full).catch(() => null);
    if (info?.isFile()) stale.push(full);
  }
  if (dryRun) return { removed: stale.length };

  const put = async (relative: string, content: Uint8Array): Promise<void> => {
    const full = inside(relative);
    if (full === null) throw new Error(`Java introspection: refusing to write ${relative} outside ${settings.dir}`);
    if (await sameContent(full, content)) return;
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  };
  for (const [relative, bytes] of output.binaries) await put(relative, bytes);
  for (const [relative, text] of output.sources) await put(relative, Buffer.from(text, 'utf8'));
  if (output.docs !== null) {
    await writeDocs(settings.dir, output.docs, { setting: 'java.dir', managedDirs: await entryDirs(settings.dir, output.docs) });
  }
  if (previous === null || !sameJavaManifest(previous, output.manifest)) await writeJavaManifest(settings.dir, output.manifest);

  let removed = 0;
  for (const full of stale) {
    await unlink(full);
    removed++;
    // Remove the folders this left empty, up to (not including) jars/, classes/ or src/.
    const top = resolve(root, full.slice(root.length + 1).split(sep)[0]!);
    for (let folder = dirname(full); folder.startsWith(top + sep); folder = dirname(folder)) {
      try {
        await rmdir(folder);
      } catch {
        break;
      }
    }
  }
  return { removed };
}
