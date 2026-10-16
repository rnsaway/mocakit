import type { CommandInfo } from '../codegen/introspect-agent.js';
import { globToRegExp } from '../codegen/filter.js';
import { ZipError, listZip, readZipEntry } from '../util/zip.js';
import type { JavaManifest } from './manifest.js';

export interface JarFacts {
  /** Dotted class names, including `$` inner classes. */
  classes: string[];
  maven?: string;
  version?: string;
  readable: boolean;
  warning?: string;
}

export const LIBRARY_FILE_NAME = /^[A-Za-z][\w.-]*-\d+(\.\d+)+([.-][\w.]+)?\.jar$/;

const SMALL_ENTRY = 1024 * 1024;
const MANIFEST_NAME = 'META-INF/MANIFEST.MF';
const POM_PROPERTIES = /^META-INF\/maven\/.+\/pom\.properties$/;

/** Main-section headers of a MANIFEST.MF; a line starting with one space continues the previous line. */
function manifestHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  let current: string | undefined;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line === '') {
      if (current !== undefined) break;
      continue;
    }
    if (line.startsWith(' ')) {
      if (current !== undefined) headers.set(current, (headers.get(current) ?? '') + line.slice(1));
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      current = undefined;
      continue;
    }
    current = line.slice(0, colon).toLowerCase();
    headers.set(current, line.slice(colon + 1).trim());
  }
  return headers;
}

function parseProperties(text: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const line of text.split(/\r\n|\n|\r/)) {
    const eq = line.indexOf('=');
    if (eq <= 0 || line.startsWith('#')) continue;
    props.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return props;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Classes, version and Maven coordinates of a JAR. Corrupt archives are `readable: false`. */
export function jarFacts(bytes: Uint8Array): JarFacts {
  try {
    const entries = listZip(bytes);
    const classes: string[] = [];
    for (const e of entries) {
      if (!e.name.endsWith('.class') || e.name.startsWith('META-INF/') || e.name.startsWith('/')) continue;
      const base = e.name.slice(0, -'.class'.length);
      if (base === 'module-info' || base.endsWith('/module-info')) continue;
      classes.push(base.replace(/\//g, '.'));
    }
    const facts: JarFacts = { classes, readable: true };
    const warnings: string[] = [];
    const read = (name: string, entry: (typeof entries)[number]): string | undefined => {
      try {
        return Buffer.from(readZipEntry(bytes, entry, { maxEntrySize: SMALL_ENTRY })).toString('utf8');
      } catch (err) {
        if (err instanceof ZipError) {
          warnings.push(`could not read ${name}: ${err.message}`);
          return undefined;
        }
        throw err;
      }
    };

    const manifest = entries.find((e) => e.name === MANIFEST_NAME);
    if (manifest) {
      const text = read(MANIFEST_NAME, manifest);
      if (text !== undefined) {
        const headers = manifestHeaders(text);
        const version = headers.get('implementation-version') || headers.get('bundle-version');
        if (version) facts.version = version;
      }
    }

    const pom = entries.filter((e) => POM_PROPERTIES.test(e.name)).sort((a, b) => compareCodeUnits(a.name, b.name))[0];
    if (pom) {
      const text = read(pom.name, pom);
      if (text !== undefined) {
        const props = parseProperties(text);
        const [g, a, v] = [props.get('groupId'), props.get('artifactId'), props.get('version')];
        if (g && a && v) facts.maven = `${g}:${a}:${v}`;
      }
    }
    if (warnings.length > 0) facts.warning = warnings.join('; ');
    return facts;
  } catch (err) {
    if (err instanceof ZipError) return { classes: [], readable: false, warning: `unreadable archive: ${err.message}` };
    throw err;
  }
}

/** Dotted class name of a `.class` file below `classesRoot`; accepts `/` or `\` separators. */
export function classNameOf(classFilePath: string, classesRoot: string): string {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const root = norm(classesRoot).replace(/\/+$/, '');
  let rel = norm(classFilePath);
  if (rel === root || rel.startsWith(`${root}/`) || rel.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    rel = rel.slice(root.length);
  }
  rel = rel.replace(/^\/+/, '');
  if (rel.endsWith('.class')) rel = rel.slice(0, -'.class'.length);
  return rel.split('/').filter((s) => s !== '').join('.');
}

function baseName(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

function matchesAny(names: string[], globs: string[]): boolean {
  const res = globs.map(globToRegExp);
  return names.some((n) => res.some((re) => re.test(n) || re.test(baseName(n))));
}

/** Libraries globs win over custom globs; otherwise an entry is a library only if every file looks like one. */
export function classifyEntry(
  fileNames: string[],
  facts: JarFacts[],
  commandClasses: ReadonlySet<string>,
  globs: { custom: string[]; libraries: string[] },
): 'custom' | 'library' {
  if (matchesAny(fileNames, globs.libraries)) return 'library';
  if (matchesAny(fileNames, globs.custom)) return 'custom';
  if (fileNames.length === 0) return 'custom';
  const looksLibrary = fileNames.every((name, i) => facts[i]?.maven !== undefined || LIBRARY_FILE_NAME.test(baseName(name)));
  if (!looksLibrary) return 'custom';
  return facts.some((f) => f.classes.some((c) => commandClasses.has(c))) ? 'custom' : 'library';
}

/** Classes provided by several entries: the first entry in classpath order wins. `classes: null` is skipped. */
export function overriddenClasses(
  entries: Array<{ path: string; classes: string[] | null }>,
): JavaManifest['overridden'] {
  const providers = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.classes === null) continue;
    for (const className of new Set(entry.classes)) {
      const list = providers.get(className);
      if (list) list.push(entry.path);
      else providers.set(className, [entry.path]);
    }
  }
  const out: JavaManifest['overridden'] = [];
  for (const [className, paths] of providers) {
    if (paths.length < 2) continue;
    const [winner, ...losers] = paths as [string, ...string[]];
    out.push({ className, winner, losers });
  }
  return out.sort((a, b) => compareCodeUnits(a.className, b.className));
}

export interface JavaLink {
  className: string;
  method?: string;
  entry: string;
  kind: 'custom' | 'library' | 'unknown';
  downloaded: boolean;
  /** Relative to moca-java. */
  source?: string;
}

/** Link each command that has a `javaClass` to the classpath entry that provides its class. Keyed by command key. */
export function linkCommands(
  commands: CommandInfo[],
  manifest: JavaManifest,
  classIndex: ReadonlyMap<string, string>,
  sourceFor: (className: string) => string | undefined,
): Map<string, JavaLink> {
  const links = new Map<string, JavaLink>();
  for (const command of commands) {
    const def = command.active;
    const className = def.javaClass;
    if (!className) continue;
    const method = def.cFunction || undefined;
    const methodPart = method ? { method } : {};
    const entryPath = classIndex.get(className);
    const record = entryPath === undefined ? undefined : manifest.entries.find((e) => e.path === entryPath);
    if (!record || record.kind === undefined) {
      links.set(command.key, { className, ...methodPart, entry: '', kind: 'unknown', downloaded: false });
      continue;
    }
    const downloaded = record.selected && !record.missing && record.files.length > 0;
    const source = downloaded ? sourceFor(className) : undefined;
    links.set(command.key, {
      className,
      ...methodPart,
      entry: record.path,
      kind: record.kind,
      downloaded,
      ...(source !== undefined ? { source } : {}),
    });
  }
  return links;
}
