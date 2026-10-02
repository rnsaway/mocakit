import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { stripBom } from '../util/text.js';

export type ApiMethod = 'get' | 'post' | 'put' | 'delete' | 'patch';
export const API_METHODS: readonly ApiMethod[] = ['get', 'post', 'put', 'delete', 'patch'];

export type ApiSchema =
  | { kind: 'string'; format?: string; enum?: string[] }
  | { kind: 'number'; integer: boolean; format?: string }
  | { kind: 'boolean' }
  | { kind: 'array'; items: ApiSchema }
  | { kind: 'ref'; name: string }
  | { kind: 'object'; properties: Record<string, ApiProperty>; required: string[]; additional?: ApiSchema }
  | { kind: 'unknown' };
export type ApiProperty = ApiSchema & { description?: string };

export interface ApiParameter {
  in: 'query' | 'path' | 'formData';
  name: string;
  required: boolean;
  schema: ApiSchema;
  description?: string;
}

export interface ApiOperation {
  group: string;
  tag: string;
  /** Namespace on `moca.api`. */
  tagKey: string;
  method: ApiMethod;
  /** Path as in the spec, without the group's basePath. */
  path: string;
  /** basePath + path: what the runtime requests. */
  fullPath: string;
  /** Method name, unique within tagKey. */
  name: string;
  description?: string;
  permissions: string[];
  parameters: ApiParameter[];
  body?: { required: boolean; schema: ApiSchema; description?: string };
  response?: { envelope: 'data' | 'body'; schema: ApiSchema };
}

export interface ApiGroup {
  name: string;
  basePath: string;
  private: boolean;
}

export interface ApiSnapshot {
  mocakitVersion: string;
  generatedAt: string;
  /** Redacted server URL. */
  server: string;
  groups: ApiGroup[];
  /** Sorted by tagKey, path, method. */
  operations: ApiOperation[];
  /** Named schemas reachable from the operations, keyed by original name. */
  definitions: Record<string, ApiSchema>;
}

export async function writeApiSnapshot(path: string, snapshot: ApiSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function invalid(path: string, detail?: string): never {
  throw new Error(`${path} is not a mocakit API snapshot${detail === undefined ? '' : `: ${detail}`}`);
}

function validSchema(s: unknown, depth = 0): boolean {
  if (!isObject(s) || depth > 64) return false;
  switch (s.kind) {
    case 'string':
      return (s.enum === undefined || isStringArray(s.enum)) && (s.format === undefined || isString(s.format));
    case 'number':
      return typeof s.integer === 'boolean';
    case 'boolean':
    case 'unknown':
      return true;
    case 'array':
      return validSchema(s.items, depth + 1);
    case 'ref':
      return isString(s.name);
    case 'object':
      return (
        isObject(s.properties) &&
        Object.values(s.properties).every((p) => validSchema(p, depth + 1)) &&
        isStringArray(s.required) &&
        (s.additional === undefined || validSchema(s.additional, depth + 1))
      );
    default:
      return false;
  }
}

function checkOperation(path: string, op: unknown): void {
  const name = isObject(op) && isString(op.name) ? op.name : '?';
  const where = `operation "${name}"`;
  if (!isObject(op)) invalid(path, where);
  const ok =
    ['group', 'tag', 'tagKey', 'path', 'fullPath', 'name'].every((k) => isString(op[k])) &&
    ['get', 'post', 'put', 'delete', 'patch'].includes(op.method as string) &&
    isStringArray(op.permissions) &&
    Array.isArray(op.parameters) &&
    (op.parameters as unknown[]).every(
      (p) => isObject(p) && ['query', 'path', 'formData'].includes(p.in as string) && isString(p.name) && typeof p.required === 'boolean' && validSchema(p.schema),
    ) &&
    (op.body === undefined || (isObject(op.body) && typeof op.body.required === 'boolean' && validSchema(op.body.schema))) &&
    (op.response === undefined || (isObject(op.response) && (op.response.envelope === 'data' || op.response.envelope === 'body') && validSchema(op.response.schema)));
  if (!ok) invalid(path, where);
}

export async function readApiSnapshot(path: string): Promise<ApiSnapshot> {
  const raw = stripBom(await readFile(path, 'utf8'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed) || !isString(parsed.server) || !Array.isArray(parsed.groups) || !Array.isArray(parsed.operations) || !isObject(parsed.definitions)) {
    invalid(path);
  }
  for (const g of parsed.groups as unknown[]) {
    if (!isObject(g) || !isString(g.name) || !isString(g.basePath) || typeof g.private !== 'boolean') invalid(path, 'groups');
  }
  for (const op of parsed.operations as unknown[]) checkOperation(path, op);
  for (const [name, schema] of Object.entries(parsed.definitions)) if (!validSchema(schema)) invalid(path, `definition "${name}"`);
  return parsed as unknown as ApiSnapshot;
}

export function sameApi(a: ApiSnapshot, b: ApiSnapshot): boolean {
  return isDeepStrictEqual(a.groups, b.groups) && isDeepStrictEqual(a.operations, b.operations) && isDeepStrictEqual(a.definitions, b.definitions);
}
