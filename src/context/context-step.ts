// src/context/context-step.ts
// The agent-context step shared by `mocakit context` and `mocakit generate --context`: scan sources/,
// convert each document (agent file, user converter, built-in converter, or pending), track changes in
// manifest.json and write the section files, indexes and PENDING.md. Never writes under agent/.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { CliIo } from '../cli/generate.js';
import { checkDocsTargets, startsWithMarker, writeDocs } from '../codegen/docs-writer.js';
import { emitContextIndex, emitDocReadme, emitPending, emitSectionFile, type ContextDocRecord } from '../codegen/emit-context-docs.js';
import { globToRegExp } from '../codegen/filter.js';
import type { ContextConfig, MocakitConfig } from '../define-config.js';
import { BUILTIN_EXTENSIONS, convertBuiltin } from './convert-builtin.js';
import { checkConverters, convertExternal, converterHash, type ConverterConfig } from './convert-external.js';
import { assignDocSlugs, splitSections, type Section } from './sections.js';

export interface ResolvedContext {
  dir: string;
  sources: string;
  converters: Record<string, ConverterConfig>;
  agent: string[];
  maxSectionBytes: number;
}

export type ContextMethod = 'agent' | 'converter' | 'built-in' | 'pending';
export type ContextStatus = 'ok' | 'stale' | 'pending';

/** What the index and README need of a section, so unchanged documents are not converted again. */
export interface ContextSectionOutline {
  heading: string;
  level: number;
  firstSentence: string;
  subheadings: string[];
}

export interface ContextManifestDocument {
  /** Path relative to `sources/`, `/`-separated. */
  source: string;
  slug: string;
  sha256: string;
  method: ContextMethod;
  converterHash?: string;
  /** sha256 of the agent file used. */
  agentSha?: string;
  /** Section file names in `docs/<slug>/`. */
  sections: string[];
  status: ContextStatus;
  title: string;
  size: number;
  /** One entry per section, aligned with `sections`. */
  outline: ContextSectionOutline[];
}

export interface ContextManifest {
  mocakitVersion: string;
  generatedAt: string;
  maxSectionBytes: number;
  documents: ContextManifestDocument[];
}

export interface ContextOutput {
  /** Path relative to the context folder to Markdown. */
  files: Map<string, string>;
  manifest: ContextManifest;
  /** `docs/<slug>` folders whose stale generated files are removed. */
  managedDirs: string[];
  pending: number;
  stats: { documents: number; sections: number; unchanged: number; removed: number };
  warnings: string[];
}

export const MANIFEST_FILE = 'manifest.json';
const PENDING_FILE = 'PENDING.md';
const DEFAULT_MAX_SECTION_BYTES = 61_440;
const MIB = 1024 * 1024;
const MAX_SOURCE_BYTES = 100 * MIB;
const MAX_AGENT_BYTES = 32 * MIB;
const MAX_REASON = 300;
const MAX_PRINTED_WARNINGS = 50;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECTION_FILE = /^\d{2,3}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const HEX64 = /^[0-9a-f]{64}$/;
const AGENT_SHA_LINE = /^<!-- source-sha256: ([0-9a-fA-F]{64}) -->$/;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** Untrusted text (converter stderr, file names) as one short line; emitters escape it. */
function reasonText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= MAX_REASON ? line : `${line.slice(0, MAX_REASON - 1)}…`;
}

function convertersOf(value: unknown): Record<string, ConverterConfig> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error('context.converters must be an object');
  const result: Record<string, ConverterConfig> = {};
  for (const [ext, config] of Object.entries(value)) {
    if (!/^\.[a-z0-9]+$/.test(ext)) throw new Error('context.converters keys must be lowercase extensions with the dot, e.g. ".pdf"');
    const name = `context.converters[${JSON.stringify(ext)}]`;
    if (!isPlainObject(config) || typeof config.command !== 'string' || config.command === '' || !isStringArray(config.args)) {
      throw new Error(`${name} must be an object with a command string and an args array of strings`);
    }
    if (config.output !== undefined && config.output !== 'markdown' && config.output !== 'text') {
      throw new Error(`${name}.output must be "markdown" or "text"`);
    }
    if (config.timeoutMs !== undefined && !isPositive(config.timeoutMs)) throw new Error(`${name}.timeoutMs must be a positive number`);
    result[ext] = {
      command: config.command,
      args: config.args,
      ...(config.output !== undefined ? { output: config.output } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    };
  }
  return result;
}

/** Context settings from config + CLI flag, or `null` when the context step is off. */
export function resolveContextSettings(config: MocakitConfig, flag: boolean | undefined, configDir: string, out: string): ResolvedContext | null {
  const setting: unknown = config.context;
  if (setting !== undefined && typeof setting !== 'boolean' && !isPlainObject(setting)) throw new Error('config.context must be true, false or an object');
  if (flag === false || (flag === undefined && !setting)) return null;
  const options: Record<string, unknown> = isPlainObject(setting) ? (setting as ContextConfig as Record<string, unknown>) : {};
  if (options.dir !== undefined && typeof options.dir !== 'string') throw new Error('context.dir must be a string');
  if (options.sources !== undefined && typeof options.sources !== 'string') throw new Error('context.sources must be a string');
  if (options.agent !== undefined && !isStringArray(options.agent)) throw new Error('context.agent must be an array of strings');
  if (options.maxSectionBytes !== undefined && !isPositive(options.maxSectionBytes)) {
    throw new Error('context.maxSectionBytes must be a positive number of bytes');
  }
  const dir = typeof options.dir === 'string' ? resolve(configDir, options.dir) : resolve(dirname(out), 'moca-context');
  return {
    dir,
    sources: typeof options.sources === 'string' ? resolve(configDir, options.sources) : join(dir, 'sources'),
    converters: convertersOf(options.converters),
    agent: (options.agent as string[] | undefined) ?? [],
    maxSectionBytes: (options.maxSectionBytes as number | undefined) ?? DEFAULT_MAX_SECTION_BYTES,
  };
}

/** An agent-written file: its first line must be `<!-- source-sha256: <hex> -->`. */
export function readAgentFile(text: string): { sha256: string; markdown: string } | null {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const end = body.indexOf('\n');
  const first = (end < 0 ? body : body.slice(0, end)).replace(/\r$/, '');
  const match = AGENT_SHA_LINE.exec(first);
  if (!match) return null;
  return { sha256: match[1]!.toLowerCase(), markdown: end < 0 ? '' : body.slice(end + 1) };
}

function isOutline(v: unknown): v is ContextSectionOutline {
  return (
    isPlainObject(v) &&
    typeof v.heading === 'string' &&
    typeof v.level === 'number' &&
    typeof v.firstSentence === 'string' &&
    isStringArray(v.subheadings)
  );
}

/** A manifest whose every field has the expected shape; anything else counts as no manifest. */
function isContextManifest(value: unknown): value is ContextManifest {
  if (!isPlainObject(value) || typeof value.mocakitVersion !== 'string' || typeof value.generatedAt !== 'string') return false;
  if (!isPositive(value.maxSectionBytes) || !Array.isArray(value.documents)) return false;
  const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';
  return value.documents.every(
    (d: unknown) =>
      isPlainObject(d) &&
      typeof d.source === 'string' &&
      typeof d.slug === 'string' &&
      SLUG.test(d.slug) &&
      typeof d.sha256 === 'string' &&
      HEX64.test(d.sha256) &&
      (d.method === 'agent' || d.method === 'converter' || d.method === 'built-in' || d.method === 'pending') &&
      optionalString(d.converterHash) &&
      optionalString(d.agentSha) &&
      isStringArray(d.sections) &&
      d.sections.every((f) => SECTION_FILE.test(f)) &&
      (d.status === 'ok' || d.status === 'stale' || d.status === 'pending') &&
      typeof d.title === 'string' &&
      typeof d.size === 'number' &&
      Array.isArray(d.outline) &&
      d.outline.length === d.sections.length &&
      d.outline.every(isOutline),
  );
}

/** The previous manifest in `dir`, or null when it is missing, unreadable or damaged. */
export async function readContextManifest(dir: string): Promise<ContextManifest | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'));
    return isContextManifest(value) ? value : null;
  } catch {
    return null;
  }
}

const withoutTime = (m: ContextManifest): string => JSON.stringify({ ...m, generatedAt: '' });

interface SourceFile {
  /** Relative to the sources folder, `/`-separated. */
  path: string;
  full: string;
}

/** Regular files under `root`, recursively. Symbolic links are never followed; oversize files are skipped. */
async function listSources(root: string, warnings: string[]): Promise<SourceFile[]> {
  const found: SourceFile[] = [];
  const walk = async (folder: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (prefix === '' && errorCode(error) === 'ENOENT') return;
      throw new Error(`Cannot read context sources ${folder}: ${errorCode(error) ?? message(error)}`);
    }
    for (const entry of entries) {
      const path = `${prefix}${entry.name}`;
      const full = join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(`skipping sources/${path}: symbolic links are not followed`);
      } else if (entry.isDirectory()) {
        await walk(full, `${path}/`);
      } else if (entry.isFile()) {
        const info = await lstat(full);
        if (!info.isFile()) continue;
        if (info.size > MAX_SOURCE_BYTES) warnings.push(`skipping sources/${path}: larger than 100 MiB`);
        else found.push({ path, full });
      }
    }
  };
  await walk(root, '');
  return found.sort((a, b) => compare(a.path, b.path));
}

/** `agent/<slug>.md` when it is a regular file of at most 32 MiB; never follows links. */
async function readAgent(
  agentDir: string | null,
  slug: string,
  warnings: string[],
): Promise<{ sha256: string; markdown: string; fileSha: string } | null> {
  if (agentDir === null) return null;
  const name = `agent/${slug}.md`;
  const path = join(agentDir, `${slug}.md`);
  const info = await lstat(path).catch(() => null);
  if (info === null) return null;
  if (!info.isFile()) {
    warnings.push(`${name} is not a regular file; ignored`);
    return null;
  }
  if (info.size > MAX_AGENT_BYTES) {
    warnings.push(`${name} is larger than 32 MiB; ignored`);
    return null;
  }
  const bytes = await readFile(path);
  const parsed = readAgentFile(bytes.toString('utf8'));
  if (parsed === null) {
    warnings.push(`${name} does not start with a source-sha256 line; ignored`);
    return null;
  }
  return { ...parsed, fileSha: sha256(bytes) };
}

/** Section files of a previous run, read back so they are kept as they are. Null if any is missing or not generated. */
async function readKeptSections(dir: string, doc: ContextManifestDocument): Promise<Array<string | null>> {
  return Promise.all(
    doc.sections.map(async (file) => {
      const path = join(dir, 'docs', doc.slug, file);
      try {
        const info = await lstat(path);
        if (!info.isFile()) return null;
        const text = await readFile(path, 'utf8');
        return startsWithMarker(text) ? text.split('\r\n').join('\n') : null;
      } catch {
        return null;
      }
    }),
  );
}

type Plan =
  | { kind: 'agent'; markdown: string; agentSha: string }
  | { kind: 'converter'; config: ConverterConfig; hash: string }
  | { kind: 'built-in' }
  | { kind: 'pending'; reason: string };

interface Done {
  record: ContextManifestDocument;
  /** Section files to emit (new conversions) or to keep as read from disk. */
  emitted: Section[] | null;
  kept: Map<string, string> | null;
  reason?: string;
}

function methodLabel(method: ContextMethod, ext: string, converter: ConverterConfig | undefined): string {
  if (method === 'agent') return 'agent';
  if (method === 'converter') return converter !== undefined ? `converter ${converter.command}` : 'converter';
  return `built-in ${ext}`;
}

const outlineOf = (s: Section): ContextSectionOutline => ({ heading: s.heading, level: s.level, firstSentence: s.firstSentence, subheadings: s.subheadings });

/** Builds every file of the context folder. Reads and converts only; writes nothing. */
export async function buildContextOutput(settings: ResolvedContext, previous: ContextManifest | null, version: string): Promise<ContextOutput> {
  const warnings: string[] = [];
  const sources = await listSources(settings.sources, warnings);
  const slugs = assignDocSlugs(sources.map((s) => s.path));
  const agentGlobs = settings.agent.map(globToRegExp);
  const previousBySource = new Map((previous?.documents ?? []).map((d) => [d.source, d]));
  const sameSplit = previous?.maxSectionBytes === settings.maxSectionBytes;

  const agentRoot = join(settings.dir, 'agent');
  const agentInfo = await lstat(agentRoot).catch(() => null);
  if (agentInfo !== null && !agentInfo.isDirectory()) warnings.push('agent/ is not a folder; agent files are ignored');
  const agentDir = agentInfo?.isDirectory() ? agentRoot : null;

  let checked = false;
  const done: Done[] = [];
  let unchanged = 0;

  for (const source of sources) {
    const slug = slugs.get(source.path)!;
    const ext = extname(source.path).toLowerCase();
    const fileName = source.path.slice(source.path.lastIndexOf('/') + 1);
    let bytes: Buffer;
    try {
      bytes = await readFile(source.full);
    } catch (error) {
      warnings.push(`skipping sources/${source.path}: ${errorCode(error) ?? message(error)}`);
      continue;
    }
    const sha = sha256(bytes);
    const prev = previousBySource.get(source.path);
    const prevSameSlug = prev !== undefined && prev.slug === slug ? prev : undefined;

    // A read error on one agent file makes only that document pending.
    let agent: Awaited<ReturnType<typeof readAgent>> = null;
    let agentError: string | undefined;
    try {
      agent = await readAgent(agentDir, slug, warnings);
    } catch (error) {
      agentError = `cannot read agent/${slug}.md: ${errorCode(error) ?? message(error)}`;
      warnings.push(agentError);
    }
    const converter = settings.converters[ext];
    let plan: Plan;
    if (agentError !== undefined) {
      plan = { kind: 'pending', reason: agentError };
    } else if (agent !== null && agent.sha256 === sha) {
      plan = { kind: 'agent', markdown: agent.markdown, agentSha: agent.fileSha };
    } else if (agent !== null) {
      warnings.push(`agent/${slug}.md was written for a different version of sources/${source.path}; reconvert it`);
      plan = { kind: 'pending', reason: 'source changed; reconvert' };
    } else if (agentGlobs.some((re) => re.test(source.path))) {
      plan = { kind: 'pending', reason: 'agent conversion requested' };
    } else if (converter !== undefined) {
      plan = { kind: 'converter', config: converter, hash: converterHash(converter) };
    } else if (BUILTIN_EXTENSIONS.includes(ext)) {
      plan = { kind: 'built-in' };
    } else {
      plan = { kind: 'pending', reason: `no converter for ${ext === '' ? 'files without an extension' : ext}` };
    }

    const base = { source: source.path, slug, sha256: sha, size: bytes.length };
    if (plan.kind !== 'pending') {
      const inputs = {
        method: plan.kind,
        ...(plan.kind === 'converter' ? { converterHash: plan.hash } : {}),
        ...(plan.kind === 'agent' ? { agentSha: plan.agentSha } : {}),
      };
      // Unchanged inputs: keep the previous sections as they are on disk.
      if (
        prevSameSlug !== undefined &&
        prevSameSlug.status === 'ok' &&
        sameSplit &&
        prevSameSlug.sha256 === sha &&
        prevSameSlug.method === inputs.method &&
        prevSameSlug.converterHash === inputs.converterHash &&
        prevSameSlug.agentSha === inputs.agentSha
      ) {
        const texts = await readKeptSections(settings.dir, prevSameSlug);
        if (texts.every((t) => t !== null)) {
          const kept = new Map(prevSameSlug.sections.map((file, i) => [file, texts[i]!]));
          done.push({ record: { ...prevSameSlug, size: bytes.length }, emitted: null, kept });
          unchanged++;
          continue;
        }
      }

      if (plan.kind === 'converter' && !checked) {
        // A converter that cannot be started fails the whole run.
        await checkConverters(settings.converters);
        checked = true;
      }
      let failure: string | undefined;
      try {
        let markdown: string | undefined;
        if (plan.kind === 'agent') {
          markdown = plan.markdown;
        } else if (plan.kind === 'converter') {
          const result = await convertExternal(plan.config, { name: fileName, bytes });
          if ('warning' in result) {
            warnings.push(result.warning);
            failure = result.warning.startsWith('converter failed') ? result.warning : `converter failed: ${result.warning}`;
          } else {
            if (result.cleanupWarning !== undefined) warnings.push(result.cleanupWarning);
            markdown = result.markdown;
          }
        } else {
          const result = convertBuiltin(ext, bytes);
          if ('error' in result) {
            warnings.push(`sources/${source.path}: ${result.error}`);
            failure = `converter failed: ${result.error}`;
          } else {
            markdown = result.markdown;
          }
        }
        if (markdown !== undefined) {
          const { title, sections } = splitSections(markdown, { docSlug: slug, fileTitle: fileName, maxSectionBytes: settings.maxSectionBytes });
          done.push({
            record: { ...base, ...inputs, sections: sections.map((s) => s.file), status: 'ok', title, outline: sections.map(outlineOf) },
            emitted: sections,
            kept: null,
          });
          continue;
        }
      } catch (error) {
        warnings.push(`sources/${source.path}: conversion failed: ${message(error)}`);
        failure = `conversion failed: ${message(error)}`;
      }
      plan = { kind: 'pending', reason: failure ?? 'conversion failed' };
    }

    // Pending: keep the previous output (if any) and mark it stale.
    if (prevSameSlug !== undefined && prevSameSlug.method !== 'pending' && prevSameSlug.sections.length > 0) {
      const texts = await readKeptSections(settings.dir, prevSameSlug);
      const keep = prevSameSlug.sections.map((_, i) => i).filter((i) => texts[i] !== null);
      if (keep.length > 0) {
        const kept = new Map(keep.map((i) => [prevSameSlug.sections[i]!, texts[i]!]));
        const { converterHash: hash, agentSha } = prevSameSlug;
        done.push({
          record: {
            ...base,
            method: prevSameSlug.method,
            ...(hash !== undefined ? { converterHash: hash } : {}),
            ...(agentSha !== undefined ? { agentSha } : {}),
            sections: keep.map((i) => prevSameSlug.sections[i]!),
            status: 'stale',
            title: prevSameSlug.title,
            outline: keep.map((i) => prevSameSlug.outline[i]!),
          },
          emitted: null,
          kept,
          reason: plan.reason,
        });
        continue;
      }
    }
    done.push({
      record: { ...base, method: 'pending', sections: [], status: 'pending', title: fileName, outline: [] },
      emitted: null,
      kept: null,
      reason: plan.reason,
    });
  }

  // Files.
  const files = new Map<string, string>();
  const docs: ContextDocRecord[] = [];
  const pending: Array<{ slug: string; source: string; sha256: string; reason: string }> = [];
  for (const item of done) {
    const { record } = item;
    if (item.reason !== undefined) pending.push({ slug: record.slug, source: record.source, sha256: record.sha256, reason: reasonText(item.reason) });
    if (record.sections.length === 0) continue;
    const ext = extname(record.source).toLowerCase();
    const converter = settings.converters[ext];
    const doc: ContextDocRecord = {
      slug: record.slug,
      source: record.source,
      sha256: record.sha256,
      method: methodLabel(record.method, ext, converter),
      size: record.size,
      status: record.status === 'stale' ? 'stale' : 'ok',
      title: record.title,
      sections:
        item.emitted ??
        record.sections.map((file, i) => ({ file, markdown: '', ...record.outline[i]! })),
      imagesNote: record.method === 'converter' && ext === '.pdf' && converter?.output === 'text',
    };
    docs.push(doc);
    if (item.emitted !== null) {
      doc.sections.forEach((section, i) => files.set(`docs/${record.slug}/${section.file}`, emitSectionFile(doc, i, version)));
    } else {
      for (const [file, text] of item.kept!) files.set(`docs/${record.slug}/${file}`, text);
    }
    files.set(`docs/${record.slug}/README.md`, emitDocReadme(doc, version));
  }
  files.set('INDEX.md', emitContextIndex(docs, pending.length, version));
  if (pending.length > 0) files.set(PENDING_FILE, emitPending(pending, version));

  const outputSlugs = new Set(docs.map((d) => d.slug));
  const previousSlugs = new Set((previous?.documents ?? []).filter((d) => d.sections.length > 0).map((d) => d.slug));
  const managedDirs = [...new Set([...previousSlugs, ...outputSlugs])].sort(compare).map((slug) => `docs/${slug}`);
  const ok = done.filter((d) => d.record.status === 'ok');
  return {
    files,
    manifest: {
      mocakitVersion: version,
      generatedAt: new Date().toISOString(),
      maxSectionBytes: settings.maxSectionBytes,
      documents: done.map((d) => d.record),
    },
    managedDirs,
    pending: pending.length,
    stats: {
      documents: ok.length,
      sections: ok.reduce((sum, d) => sum + d.record.sections.length, 0),
      unchanged,
      removed: [...previousSlugs].filter((slug) => !outputSlugs.has(slug)).length,
    },
    warnings,
  };
}

/** Everything `writeContext` needs: built before any write so a failure leaves the project untouched. */
export interface PreparedContext {
  settings: ResolvedContext;
  output: ContextOutput;
  previous: ContextManifest | null;
  sourcesMissing: boolean;
}

export async function prepareContext(settings: ResolvedContext, version: string): Promise<PreparedContext> {
  const sourcesMissing = (await lstat(settings.sources).catch(() => null)) === null;
  const previous = await readContextManifest(settings.dir);
  const output = await buildContextOutput(settings, previous, version);
  return { settings, output, previous, sourcesMissing };
}

/** The summary log lines (after the conversion, before any write). */
export function logContextSummary(prepared: PreparedContext, io: CliIo): void {
  const { settings, output, sourcesMissing } = prepared;
  if (sourcesMissing) io.log(`Put documents to convert in ${settings.sources}`);
  const { stats } = output;
  io.log(`Converted ${stats.documents} documents (${stats.sections} sections, ${stats.unchanged} unchanged)`);
  if (output.pending > 0) io.log(`${output.pending} documents waiting for agent conversion (see ${join(settings.dir, PENDING_FILE)})`);
}

/** Absolute `docs/<slug>` folders that lie inside `<dir>/docs` and are real folders (not links). */
async function confinedDocDirs(dir: string, relatives: string[]): Promise<Array<{ relative: string; full: string; exists: boolean }>> {
  const docsRoot = resolve(dir, 'docs');
  const result: Array<{ relative: string; full: string; exists: boolean }> = [];
  const rootInfo = await lstat(docsRoot).catch(() => null);
  if (rootInfo !== null && !rootInfo.isDirectory()) throw new Error(`refusing to write into ${docsRoot}: it is not a folder`);
  for (const relative of relatives) {
    const parts = relative.split('/');
    if (parts.length !== 2 || parts[0] !== 'docs' || !SLUG.test(parts[1]!)) continue;
    const full = resolve(docsRoot, parts[1]!);
    if (!full.startsWith(docsRoot + sep)) continue;
    const info = await lstat(full).catch(() => null);
    if (info !== null && !info.isDirectory()) throw new Error(`refusing to write into ${full}: it is not a folder`);
    result.push({ relative, full, exists: info !== null });
  }
  return result;
}

/** Throws, writing nothing, if a target is hand-written or a document folder is not a real folder. */
export async function checkContextTargets(prepared: PreparedContext): Promise<void> {
  const { settings, output } = prepared;
  await confinedDocDirs(settings.dir, output.managedDirs);
  // Every file this run may write or delete must be absent or a regular file: writeFile follows links,
  // and a link to a generated file would pass the marker check below.
  for (const relative of [...output.files.keys(), PENDING_FILE, MANIFEST_FILE]) {
    const path = join(settings.dir, ...relative.split('/'));
    const info = await lstat(path).catch(() => null);
    if (info !== null && !info.isFile()) throw new Error(`refusing to write into ${path}: it is not a regular file`);
  }
  await checkDocsTargets(settings.dir, output.files, 'context.dir');
}

/** Writes the context folder (or, on a dry run, only reports). Never touches `agent/` or `sources/` contents. */
export async function writeContext(prepared: PreparedContext, io: CliIo, dryRun: boolean): Promise<void> {
  const { settings, output, previous } = prepared;
  if (!dryRun) {
    await checkContextTargets(prepared);
    if (prepared.sourcesMissing) await mkdir(settings.sources, { recursive: true });
    const dirs = await confinedDocDirs(settings.dir, output.managedDirs);
    await writeDocs(settings.dir, output.files, { setting: 'context.dir', managedDirs: dirs.filter((d) => d.exists).map((d) => d.relative) });
    if (!output.files.has(PENDING_FILE)) await removeGenerated(join(settings.dir, PENDING_FILE));
    if (previous === null || withoutTime(previous) !== withoutTime(output.manifest)) {
      await mkdir(settings.dir, { recursive: true });
      await writeFile(join(settings.dir, MANIFEST_FILE), `${JSON.stringify(output.manifest, null, 2)}\n`, 'utf8');
    }
    // Remove the folders of removed documents once they are empty (hand-written files keep them).
    const live = new Set([...output.files.keys()].map((k) => k.split('/').slice(0, 2).join('/')));
    for (const dir of dirs) {
      if (live.has(dir.relative)) continue;
      await rmdir(dir.full).catch(() => undefined);
    }
  }
  io.log(`${dryRun ? 'Would write' : 'Wrote'} agent context to ${settings.dir}`);
  if (!dryRun && output.stats.removed > 0) io.log(`Removed ${output.stats.removed} stale documents`);
}

async function removeGenerated(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (info === null || !info.isFile()) return;
  if (startsWithMarker(await readFile(path, 'utf8'))) await unlink(path);
}

/** `mocakit context`: convert, report and write. */
export async function runContext(
  settings: ResolvedContext,
  io: CliIo,
  opts: { dryRun: boolean; version: string; verbose?: boolean },
): Promise<void> {
  const prepared = await prepareContext(settings, opts.version);
  const limit = opts.verbose ? Number.POSITIVE_INFINITY : MAX_PRINTED_WARNINGS;
  const { warnings } = prepared.output;
  for (const warning of warnings.slice(0, limit)) io.error(`warning: ${warning}`);
  if (warnings.length > limit) io.error(`... and ${warnings.length - limit} more warnings (use --verbose to see all)`);
  logContextSummary(prepared, io);
  await writeContext(prepared, io, opts.dryRun);
}
