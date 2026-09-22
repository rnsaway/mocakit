import { access, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { MocakitConfig } from '../define-config.js';
import type { MocaConfig } from '../types.js';

const CANDIDATES = ['mocakit.config.ts', 'mocakit.config.mts', 'mocakit.config.mjs', 'mocakit.config.js', 'mocakit.config.json'];

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function importConfig(path: string): Promise<MocakitConfig> {
  if (extname(path) === '.json') return JSON.parse(await readFile(path, 'utf8')) as MocakitConfig;
  const { createJiti } = await import('jiti');
  const jiti = createJiti(import.meta.url);
  return (await jiti.import(path, { default: true })) as MocakitConfig;
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
  throw new Error(`No mocakit config found in ${cwd} (looked for ${CANDIDATES.join(', ')})`);
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
  const ignoreSsl = config.ignoreSslIssues ?? (env.MOCA_IGNORE_SSL === 'true' ? true : undefined);
  if (ignoreSsl !== undefined) connection.ignoreSslIssues = ignoreSsl;
  return connection;
}
