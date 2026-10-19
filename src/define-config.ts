import type { ConverterConfig } from './context/convert-external.js';

/** Database schema introspection (tables, views, columns). On by default; `schema: false` turns it off. */
export interface SchemaConfig {
  /** Table/view name globs (`*`, `?`), case-insensitive. Default `['*']`. */
  include?: string[];
  exclude?: string[];
  /** Include views. Default `true`. */
  views?: boolean;
  /** Default `moca.schema.json` next to `out`. */
  snapshot?: string;
  /** Default `moca.schema.ts` next to `out`. */
  out?: string;
  /** Agent docs folder. Default `moca-schema` next to `out`; `false` skips it. */
  docs?: string | false;
  /** Code values (codmst/dscmst) in the table docs. `true` uses the login locale, else US_ENGLISH. Default off. */
  codes?: boolean | { locale?: string };
}

/** Opt-in command docs for AI agents (moca-commands/). */
export interface CommandDocsConfig {
  /** Output folder. Default `moca-commands` next to `out`. */
  out?: string;
  /** Command-name globs; default: the top-level `include` / `exclude`. */
  include?: string[];
  exclude?: string[];
  /** Component levels; default: the top-level `levels`. */
  levels?: string[];
  /**
   * Implementation source in command docs. 'custom' (default): only definitions at `customLevels`.
   * 'all': every definition, including Blue Yonder product source (your licence decides whether you may).
   * false: no source.
   */
  source?: 'custom' | 'all' | false;
  /** Component levels treated as custom code (case-insensitive globs). Default ['USR*']. */
  customLevels?: string[];
  /** Trigger names treated as custom code (triggers carry no level). Default []. */
  customTriggers?: string[];
  /** Include triggers. Default true. */
  triggers?: boolean;
}

/** Opt-in typed REST API client and docs from the server's Swagger specs. */
export interface ApiConfig {
  /** Groups from /ws/admin/publicApis. Default ['Public APIs']. Other groups are internal. */
  groups?: string[];
  /** Tag key globs (e.g. 'inventory', 'pick*'), case-insensitive. */
  include?: string[];
  exclude?: string[];
  /** HTTP methods to generate. Default all; ['get'] gives a read-only client. */
  methods?: Array<'get' | 'post' | 'put' | 'delete' | 'patch'>;
  /** Default moca.api.json next to `out`. */
  snapshot?: string;
  /** Default moca.api.ts next to `out`. */
  out?: string;
  /** Agent docs folder. Default moca-api next to `out`; false skips it. */
  docs?: string | false;
}

/** A Java decompiler installed locally (e.g. CFR or Vineflower); run without a shell. */
export interface DecompilerConfig {
  command: string;
  /** May contain `{input}` (a JAR file or a classes folder) and `{output}` (an empty folder). */
  args: string[];
  /** Per input. Default 120000. */
  timeoutMs?: number;
}

/**
 * Opt-in Java introspection (moca-java/): the server's classpath read with `execute os command`,
 * the selected JARs and classes downloaded and verified, and optionally decompiled.
 */
export interface JavaConfig {
  /** Classpath roots to download: `$LESDIR`, the name of a folder next to it, or an absolute path. Default `['$LESDIR']`. */
  roots?: string[];
  /** File-name globs always treated as custom code. */
  custom?: string[];
  /** File-name globs always treated as libraries (wins over `custom`). */
  libraries?: string[];
  /** Output folder. Default `moca-java` next to `out`. */
  dir?: string;
  /** Agent docs (README.md, INDEX.md, entries/). Default true. */
  docs?: boolean;
  /** Files larger than this many bytes are skipped. Default 25 MiB. */
  maxFileSize?: number;
  /** A locally installed decompiler; `args` may use `{input}` and `{output}`. Without it no source is produced. */
  decompiler?: DecompilerConfig;
  /** Also decompile libraries. Default false (custom code only). */
  decompileLibraries?: boolean;
}

/**
 * Opt-in agent context (moca-context/): documents in `sources/` converted to Markdown, split by
 * section and indexed. Converted locally; nothing is sent to the server.
 */
export interface ContextConfig {
  /** Output folder. Default `moca-context` next to `out`. */
  dir?: string;
  /** Folder of documents to convert. Default `<dir>/sources`. */
  sources?: string;
  /** Converter commands by lowercase extension with the dot (e.g. `.pdf`); `args` may use `{input}` and `{output}`. */
  converters?: Record<string, ConverterConfig>;
  /** Globs (paths relative to `sources`) of documents your coding agent converts; listed in PENDING.md. */
  agent?: string[];
  /** Sections larger than this many bytes are split again. Default 61440. */
  maxSectionBytes?: number;
}

export interface MocakitConfig {
  /** Falls back to the MOCA_URL environment variable. */
  url?: string;
  /** Falls back to MOCA_USER. */
  username?: string;
  /** Falls back to MOCA_PASSWORD. */
  password?: string;
  warehouse?: string;
  device?: string;
  locale?: string;
  ignoreSslIssues?: boolean;
  timeoutMs?: number;
  /** Generated file path. Default `src/moca.generated.ts`. */
  out?: string;
  /** Snapshot path. Default `moca.commands.json` next to `out`. */
  snapshot?: string;
  /** Command-name globs (`*`, `?`), case-insensitive. Default `['*']`. */
  include?: string[];
  exclude?: string[];
  /** Component-level allowlist, case-insensitive. */
  levels?: string[];
  /** Schema introspection; see `SchemaConfig`. Default on; `false` turns it off. */
  schema?: boolean | SchemaConfig;
  /** `true` or an object enables command docs (moca-commands/); see `CommandDocsConfig`. Default off. */
  commandDocs?: boolean | CommandDocsConfig;
  /** `true` or an object enables the REST API client; see `ApiConfig`. Default off. */
  api?: boolean | ApiConfig;
  /** `true` or an object enables Java introspection (moca-java/); see `JavaConfig`. Default off. */
  java?: boolean | JavaConfig;
  /** `true` or an object enables agent context from documents (moca-context/); see `ContextConfig`. Default off. */
  context?: boolean | ContextConfig;
}

export function defineConfig(config: MocakitConfig): MocakitConfig {
  return config;
}
