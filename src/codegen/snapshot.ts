import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stripBom } from '../util/text.js';
import { isValidCommandName } from './names.js';

export interface SnapshotArg {
  name: string;
  dtype: string;
  required: boolean;
  description?: string;
}

export interface SnapshotCommand {
  name: string;
  level?: string;
  type?: string;
  description?: string;
  args: SnapshotArg[];
}

export interface Snapshot {
  mocakitVersion: string;
  generatedAt: string;
  /** Server URL with credentials and query removed. */
  server: string;
  commands: SnapshotCommand[];
}

export async function writeSnapshot(path: string, snapshot: Snapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function invalid(path: string, commandName?: string): never {
  throw new Error(commandName === undefined ? `${path} is not a mocakit snapshot` : `${path} is not a mocakit snapshot: ${commandName}`);
}

function isValidArg(arg: unknown): arg is SnapshotArg {
  if (typeof arg !== 'object' || arg === null) return false;
  const a = arg as Record<string, unknown>;
  return (
    typeof a.name === 'string' &&
    typeof a.dtype === 'string' &&
    typeof a.required === 'boolean' &&
    (a.description === undefined || typeof a.description === 'string')
  );
}

export async function readSnapshot(path: string): Promise<Snapshot> {
  const raw = stripBom(await readFile(path, 'utf8'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is not valid JSON: ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) invalid(path);
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.server !== 'string' || !Array.isArray(candidate.commands)) invalid(path);

  for (const command of candidate.commands as unknown[]) {
    if (typeof command !== 'object' || command === null) invalid(path);
    const c = command as Record<string, unknown>;
    const commandName = typeof c.name === 'string' ? c.name : undefined;
    const optionalStringsValid =
      (c.level === undefined || typeof c.level === 'string') &&
      (c.type === undefined || typeof c.type === 'string') &&
      (c.description === undefined || typeof c.description === 'string');
    if (
      typeof c.name !== 'string' ||
      !optionalStringsValid ||
      !Array.isArray(c.args) ||
      !(c.args as unknown[]).every(isValidArg)
    ) {
      invalid(path, commandName);
    }
    if (!isValidCommandName(c.name as string)) invalid(path, `invalid command name ${JSON.stringify(c.name)}`);
  }

  return parsed as Snapshot;
}
