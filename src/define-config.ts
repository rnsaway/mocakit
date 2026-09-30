/** Opt-in database schema introspection (tables, views, columns). */
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
  /** `true` or an object enables schema introspection; see `SchemaConfig`. Default off. */
  schema?: boolean | SchemaConfig;
}

export function defineConfig(config: MocakitConfig): MocakitConfig {
  return config;
}
