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
}

export function defineConfig(config: MocakitConfig): MocakitConfig {
  return config;
}
