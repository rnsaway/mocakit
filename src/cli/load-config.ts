import { access, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { MocakitConfig } from '../define-config.js';
import type { MocaConfig } from '../types.js';
import { stripBom } from '../util/text.js';

/** Values of `MOCA_IGNORE_SSL` (case-insensitive) that mean `ignoreSslIssues: true`. */
export const IGNORE_SSL_TRUE = /^(1|yes|true)$/i;

const CANDIDATES = ['mocakit.config.ts', 'mocakit.config.mts', 'mocakit.config.mjs', 'mocakit.config.js', 'mocakit.config.json'];

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function importConfig(path: string): Promise<MocakitConfig> {
  let loaded: unknown;
  if (extname(path) === '.json') {
    const raw = stripBom(await readFile(path, 'utf8'));
    try {
      loaded = JSON.parse(raw);
    } catch {
      // Deliberately drop the parser's own message (and any `cause`): it can quote the
      // offending token, and a config file may contain a password or other secret.
      throw new Error(`${path} is not valid JSON`);
    }
  } else {
    const { createJiti } = await import('jiti');
    // A `.ts` config may embed credentials (e.g. `password: '...'`). jiti's disk cache would
    // otherwise write the compiled module -- inline secrets included -- to the OS temp
    // directory, so both caches are disabled here. That alone isn't enough, though: jiti's
    // async `.import()` still needs a real file to hand to Node's native ESM loader, so it
    // writes the transpiled module -- secrets and all -- to the OS temp dir and never removes
    // it, regardless of these options. The synchronous, `require()`-like call below runs the
    // same transpiled code in-process through Node's `Module` machinery instead, with no
    // tempfile; verified empirically (see load-config.test.ts).
    const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
    let mod: { default?: unknown } | undefined;
    try {
      mod = jiti(path) as { default?: unknown } | undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('await is only valid')) {
        throw new Error(`${path} cannot use top-level await (config files, and modules they import, are loaded synchronously)`);
      }
      throw error;
    }
    loaded = mod?.default ?? mod;
  }
  if (!isConfigObject(loaded)) throw new Error(`${path} must export a config object`);
  return loaded as MocakitConfig;
}

export async function loadConfig(
  explicitPath: string | undefined,
  cwd: string,
  options: { optional?: boolean } = {},
): Promise<{ config: MocakitConfig; path: string } | null> {
  if (explicitPath !== undefined) {
    const path = resolve(cwd, explicitPath);
    if (!(await exists(path))) throw new Error(`Config file not found: ${path}`);
    return { config: await importConfig(path), path };
  }
  for (const candidate of CANDIDATES) {
    const path = resolve(cwd, candidate);
    if (await exists(path)) return { config: await importConfig(path), path };
  }
  if (options.optional) return null;
  throw new Error(
    `No mocakit config found in ${cwd} (looked for ${CANDIDATES.join(', ')}); ` +
      `set MOCA_URL, MOCA_USER and MOCA_PASSWORD instead`,
  );
}

export function resolveConnection(config: MocakitConfig, env: Record<string, string | undefined>): MocaConfig {
  const url = config.url ?? env.MOCA_URL;
  const username = config.username ?? env.MOCA_USER;
  const password = config.password ?? env.MOCA_PASSWORD;
  const missing = [
    url ? '' : 'url (MOCA_URL)',
    username ? '' : 'username (MOCA_USER)',
    password ? '' : 'password (MOCA_PASSWORD)',
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`Missing connection settings: ${missing.join(', ')}`);

  const connection: MocaConfig = { url: url as string, username: username as string, password: password as string };
  if (config.warehouse !== undefined) connection.warehouse = config.warehouse;
  if (config.device !== undefined) connection.device = config.device;
  if (config.locale !== undefined) connection.locale = config.locale;
  if (config.timeoutMs !== undefined) connection.timeoutMs = config.timeoutMs;
  const ignoreSsl = config.ignoreSslIssues ?? (IGNORE_SSL_TRUE.test(env.MOCA_IGNORE_SSL ?? '') ? true : undefined);
  if (ignoreSsl !== undefined) connection.ignoreSslIssues = ignoreSsl;
  return connection;
}
