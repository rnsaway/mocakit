import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { stripBom } from '../util/text.js';

export interface LoadedEnvFile {
  path: string;
  vars: Record<string, string>;
}

/**
 * Reads and parses a dotenv file with Node's own `util.parseEnv` (the parser behind
 * `node --env-file`). Returns `null` when the file is absent and `optional` is set.
 *
 * Errors never include the file's content or the parser's own message (either could quote a
 * secret): only the path and, for fs failures, the Node error code.
 */
export async function loadEnvFile(path: string, options: { optional?: boolean } = {}): Promise<LoadedEnvFile | null> {
  let raw: string;
  try {
    raw = stripBom(await readFile(path, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (options.optional && code === 'ENOENT') return null;
    throw new Error(`Cannot read env file ${path}: ${typeof code === 'string' ? code : 'read failed'}`);
  }
  let parsed: NodeJS.Dict<string>;
  try {
    parsed = parseEnv(raw);
  } catch {
    throw new Error(`Cannot parse env file ${path}`);
  }
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) if (value !== undefined) vars[name] = value;
  return { path, vars };
}

/**
 * Makes `vars` visible through `process.env` for names the real environment doesn't already
 * define (the real environment wins, as with `node --env-file`), so a `mocakit.config.ts`
 * that reads `process.env` sees them. Returns a function that removes exactly the names it
 * added, leaving `process.env` as it was.
 */
export function exposeOnProcessEnv(vars: Record<string, string>): () => void {
  const added: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    if (process.env[name] === undefined) {
      process.env[name] = value;
      added.push(name);
    }
  }
  return () => {
    for (const name of added) delete process.env[name];
  };
}
