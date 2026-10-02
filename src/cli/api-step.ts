import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readApiSnapshot, type ApiSnapshot } from '../codegen/api-snapshot.js';
import type { ApiFilter } from '../codegen/emit-api.js';
import type { ApiConfig, MocakitConfig } from '../define-config.js';

export interface ResolvedApi {
  groups: string[];
  filter: ApiFilter;
  snapshot: string;
  out: string;
  docs: string | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const METHODS = ['get', 'post', 'put', 'delete', 'patch'];

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new Error(`api.${field} must be an array of strings`);
  return value;
}

export function resolveApiSettings(config: MocakitConfig, flag: boolean | undefined, configDir: string, out: string): ResolvedApi | null {
  const setting = config.api;
  if (setting !== undefined && typeof setting !== 'boolean' && !isPlainObject(setting)) throw new Error('config.api must be true, false or an object');
  if (flag === false || (flag === undefined && !setting)) return null;
  const options = (isPlainObject(setting) ? setting : {}) as ApiConfig;
  const methods = stringArray(options.methods, 'methods');
  if (methods !== undefined && methods.some((m) => !METHODS.includes(m))) throw new Error(`api.methods may only contain ${METHODS.join(', ')}`);
  const near = (file: string) => resolve(dirname(out), file);
  const fromConfig = (path: string) => resolve(configDir, path);
  return {
    groups: stringArray(options.groups, 'groups') ?? ['Public APIs'],
    filter: { include: stringArray(options.include, 'include'), exclude: stringArray(options.exclude, 'exclude'), methods: methods as ApiFilter['methods'] },
    snapshot: options.snapshot !== undefined ? fromConfig(options.snapshot) : near('moca.api.json'),
    out: options.out !== undefined ? fromConfig(options.out) : near('moca.api.ts'),
    docs: options.docs === false ? null : options.docs !== undefined ? fromConfig(options.docs) : near('moca-api'),
  };
}

export async function readApiSnapshotFile(path: string): Promise<ApiSnapshot> {
  try {
    return await readApiSnapshot(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new Error(`API is enabled but ${path} does not exist; run generate against a server first, or pass --no-api`);
    }
    throw error;
  }
}

/** `operations/<tag>` folders to clean: existing ones plus those in `files`. */
export async function apiDocsManagedDirs(dir: string, files: ReadonlyMap<string, string>): Promise<string[]> {
  const set = new Set<string>();
  for (const key of files.keys()) {
    const parts = key.split('/');
    if (parts[0] === 'operations' && parts.length === 3) set.add(`operations/${parts[1]}`);
  }
  try {
    for (const entry of await readdir(join(dir, 'operations'), { withFileTypes: true })) if (entry.isDirectory()) set.add(`operations/${entry.name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return [...set].sort();
}
