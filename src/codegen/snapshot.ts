import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

export async function readSnapshot(path: string): Promise<Snapshot> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<Snapshot>;
  if (!Array.isArray(parsed.commands) || typeof parsed.server !== 'string') {
    throw new Error(`${path} is not a mocakit snapshot`);
  }
  return parsed as Snapshot;
}
