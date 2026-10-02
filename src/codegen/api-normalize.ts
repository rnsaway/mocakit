import type { ApiGroup, ApiMethod, ApiOperation, ApiParameter, ApiProperty, ApiSchema } from './api-snapshot.js';
import { API_METHODS } from './api-snapshot.js';
import { byCodeUnit } from './names.js';

const RESERVED = new Set(['constructor', 'then', '__proto__', ...Object.getOwnPropertyNames(Object.prototype)]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

const words = (s: string): string[] => s.split(/[^A-Za-z0-9]+/).filter(Boolean);
const upper = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/** camelCase identifier from free text; preserves inner camel humps (countSchedule stays countSchedule). */
export function identifierFrom(input: string): string {
  const parts = words(input);
  if (parts.length === 0) return '_';
  const first = parts[0]!;
  const head = /^[A-Z0-9]+$/.test(first) ? first.toLowerCase() : first.charAt(0).toLowerCase() + first.slice(1); // 'API' â†’ 'api'
  const id = head + parts.slice(1).map(upper).join('');
  return /^[0-9]/.test(id) ? `_${id}` : id;
}

const tagShort = (tag: string): string => tag.split(' (')[0] ?? tag;
const tagVersion = (tag: string): string => (tag.match(/\(([^)]+)\)\s*$/)?.[1] ?? '').trim();

const guardReserved = (key: string): string => (RESERVED.has(key) ? `op${upper(key)}` : key);

/** Identifier for a private group's namespace (reserved-name guarded). */
export const groupKeyFor = (name: string): string => guardReserved(identifierFrom(name));

/** Distinct (case-insensitively) namespace key per tag; clashes get a version suffix, then `_2`, `_3`… in input order. */
export function tagKeys(tags: string[]): Map<string, string> {
  const unique = [...new Set(tags)];
  const base = new Map(unique.map((tag) => [tag, guardReserved(identifierFrom(tagShort(tag)))]));
  const sharing = new Map<string, number>();
  for (const key of base.values()) sharing.set(key.toLowerCase(), (sharing.get(key.toLowerCase()) ?? 0) + 1);
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const tag of unique) {
    const key = base.get(tag)!;
    const version = tagVersion(tag);
    const candidate = sharing.get(key.toLowerCase())! > 1 && version !== '' ? `${key}${upper(identifierFrom(version))}` : key;
    let final = candidate;
    for (let n = 2; used.has(final.toLowerCase()); n++) final = `${candidate}_${n}`;
    used.add(final.toLowerCase());
    result.set(tag, final);
  }
  return result;
}

const pascal = (segment: string): string => words(segment).map(upper).join('');

/** `<method><Pascal path after /<tag>/<version>/>`, path params as `By<Param>`. */
export function operationName(method: ApiMethod, path: string, short: string): string {
  const segments = path.split('/').filter(Boolean);
  let rest = segments;
  if (rest[0] !== undefined && identifierFrom(rest[0]) === identifierFrom(short)) rest = rest.slice(1);
  if (rest[0] !== undefined && /^v\d+$/i.test(rest[0])) rest = rest.slice(1);
  if (rest.length === 0) rest = segments.slice(0, 1);
  const suffix = rest.map((s) => (/^\{.+\}$/.test(s) ? `By${pascal(s.slice(1, -1))}` : pascal(s))).join('');
  return `${method}${suffix || 'Root'}`;
}

export function convertSchema(raw: unknown): ApiSchema {
  if (!isObject(raw)) return { kind: 'unknown' };
  if (typeof raw.$ref === 'string') return { kind: 'ref', name: raw.$ref.replace(/^#\/definitions\//, '') };
  const type = raw.type;
  if (type === 'string') {
    const schema: ApiSchema = { kind: 'string' };
    if (typeof raw.format === 'string') schema.format = raw.format;
    if (Array.isArray(raw.enum)) schema.enum = raw.enum.map(String);
    return schema;
  }
  if (type === 'integer' || type === 'number') {
    const schema: ApiSchema = { kind: 'number', integer: type === 'integer' };
    if (typeof raw.format === 'string') schema.format = raw.format;
    return schema;
  }
  if (type === 'boolean') return { kind: 'boolean' };
  if (type === 'array') return { kind: 'array', items: convertSchema(raw.items) };
  if (type === 'object' || isObject(raw.properties) || isObject(raw.additionalProperties)) {
    const properties: Record<string, ApiProperty> = {};
    for (const [name, prop] of Object.entries(isObject(raw.properties) ? raw.properties : {})) {
      const converted: ApiProperty = convertSchema(prop);
      const description = isObject(prop) ? text(prop.description) : undefined;
      if (description !== undefined) converted.description = description;
      properties[name] = converted;
    }
    const schema: ApiSchema = { kind: 'object', properties, required: Array.isArray(raw.required) ? raw.required.map(String) : [] };
    if (isObject(raw.additionalProperties)) schema.additional = convertSchema(raw.additionalProperties);
    return schema;
  }
  return { kind: 'unknown' };
}

function parameterSchema(p: Record<string, unknown>): ApiSchema {
  return p.schema !== undefined ? convertSchema(p.schema) : convertSchema({ ...p, description: undefined });
}

/** Resolves a one-level `$ref` into spec.parameters / spec.responses; non-refs pass through. Unresolved refs warn and yield undefined. */
function resolveRef(
  entry: unknown,
  prefix: string,
  table: unknown,
  what: string,
  label: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!isObject(entry)) return undefined;
  if (typeof entry.$ref !== 'string') return entry;
  const target = entry.$ref.startsWith(prefix) && isObject(table) ? table[entry.$ref.slice(prefix.length)] : undefined;
  if (isObject(target)) return target;
  warnings.push(`API operation ${label}: unresolved ${what} $ref ${entry.$ref}`);
  return undefined;
}

export function normalizeSwagger(
  group: { name: string; private: boolean },
  spec: unknown,
): { group: ApiGroup; operations: Omit<ApiOperation, 'name'>[]; definitions: Record<string, ApiSchema>; warnings: string[] } {
  if (!isObject(spec) || spec.swagger !== '2.0') {
    const found = isObject(spec) ? (spec.openapi !== undefined ? `openapi ${String(spec.openapi)}` : spec.swagger !== undefined ? `swagger ${String(spec.swagger)}` : 'no version') : 'no version';
    throw new Error(`API spec "${group.name}" is not Swagger 2.0 (found ${found})`);
  }
  const basePath = typeof spec.basePath === 'string' && spec.basePath !== '/' ? spec.basePath.replace(/\/$/, '') : '';
  const paths = isObject(spec.paths) ? spec.paths : {};
  const allTags = new Set<string>();
  for (const item of Object.values(paths)) {
    if (!isObject(item)) continue;
    for (const m of API_METHODS) {
      const op = item[m];
      if (isObject(op) && Array.isArray(op.tags) && typeof op.tags[0] === 'string') allTags.add(op.tags[0]);
    }
  }
  const keys = tagKeys([...allTags]);
  const groupKey = groupKeyFor(group.name);
  const operations: Omit<ApiOperation, 'name'>[] = [];
  const warnings: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of API_METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const tag = Array.isArray(op.tags) && typeof op.tags[0] === 'string' ? op.tags[0] : group.name;
      const parameters: ApiParameter[] = [];
      let body: ApiOperation['body'];
      const label = `${method.toUpperCase()} ${path}`;
      const merged = new Map<string, Record<string, unknown>>();
      for (const entry of [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const raw = resolveRef(entry, '#/parameters/', spec.parameters, 'parameter', label, warnings);
        if (raw === undefined || typeof raw.name !== 'string') continue;
        merged.set(`${String(raw.in)}:${raw.name}`, raw); // operation-level replaces path-level, first-seen order kept
      }
      for (const raw of merged.values()) {
        const description = text(raw.description);
        if (raw.in === 'body') {
          body = { required: raw.required === true, schema: convertSchema(raw.schema), ...(description !== undefined && { description }) };
        } else if (raw.in === 'query' || raw.in === 'path' || raw.in === 'formData') {
          parameters.push({
            in: raw.in,
            name: String(raw.name),
            required: raw.required === true || raw.in === 'path',
            schema: parameterSchema(raw),
            ...(description !== undefined && { description }),
          });
        }
      }
      const responses = isObject(op.responses) ? op.responses : {};
      const okKey = Object.keys(responses).filter((k) => /^2\d\d$/.test(k)).sort()[0];
      const okResponse = okKey !== undefined ? resolveRef(responses[okKey], '#/responses/', spec.responses, 'response', label, warnings) : undefined;
      const okSchema = okResponse?.schema;
      let response: ApiOperation['response'];
      if (okSchema !== undefined) {
        const converted = convertSchema(okSchema);
        const keysOf = converted.kind === 'object' ? Object.keys(converted.properties) : [];
        if (converted.kind === 'object' && keysOf.length === 1 && keysOf[0] === 'data' && converted.properties.data!.kind === 'array') {
          response = { envelope: 'data', schema: (converted.properties.data as { kind: 'array'; items: ApiSchema }).items };
        } else {
          response = { envelope: 'body', schema: converted };
        }
      }
      const description = text(op.description) ?? text(op.summary);
      operations.push({
        group: group.name,
        tag,
        tagKey: group.private ? groupKey : (keys.get(tag) ?? identifierFrom(tag)),
        method,
        path,
        fullPath: `${basePath}${path}`,
        ...(description !== undefined && { description }),
        permissions: Array.isArray(op['x-permissions']) ? op['x-permissions'].map(String) : [],
        parameters,
        ...(body !== undefined && { body }),
        ...(response !== undefined && { response }),
      });
    }
  }
  const definitions: Record<string, ApiSchema> = {};
  for (const [name, schema] of Object.entries(isObject(spec.definitions) ? spec.definitions : {})) definitions[name] = convertSchema(schema);
  return { group: { name: group.name, basePath, private: group.private }, operations, definitions, warnings };
}

export function assignOperationNames(operations: Omit<ApiOperation, 'name'>[]): { operations: ApiOperation[]; warnings: string[] } {
  const sorted = [...operations].sort((a, b) => byCodeUnit(a.tagKey, b.tagKey) || byCodeUnit(a.path, b.path) || byCodeUnit(a.method, b.method));
  const groups = new Map<string, { key: string; items: { op: Omit<ApiOperation, 'name'>; base: string }[] }>();
  const named: ApiOperation[] = [];
  for (const op of sorted) {
    // Tag short name: strips a leading '/<tag>/' segment when present (private-group tags rarely match and are left alone).
    let base = operationName(op.method, op.path, op.tag.split(' (')[0]!);
    if (RESERVED.has(base)) base = `op${upper(base)}`;
    // Case-insensitive: Windows/macOS file systems would map getAb and getAB to one docs file.
    const folded = `${op.tagKey.toLowerCase()}.${base.toLowerCase()}`;
    const entry = groups.get(folded) ?? { key: `${op.tagKey}.${base}`, items: [] };
    entry.items.push({ op, base });
    groups.set(folded, entry);
    named.push({ ...op, name: entry.items.length === 1 ? base : `${base}_${entry.items.length}` });
  }
  const warnings = [...groups.values()]
    .filter((g) => g.items.length > 1)
    .map(({ key, items }) => {
      const names = items.map((it, i) => (i === 0 ? it.base : `${it.base}_${i + 1}`));
      return `API operations ${items.map((it) => `${it.op.method.toUpperCase()} ${it.op.path}`).join(', ')} map to the same name ${key}; generated ${names.join(', ')}`;
    });
  return { operations: named, warnings };
}

function collectRefs(schema: ApiSchema, into: Set<string>): void {
  switch (schema.kind) {
    case 'ref':
      into.add(schema.name);
      break;
    case 'array':
      collectRefs(schema.items, into);
      break;
    case 'object':
      for (const p of Object.values(schema.properties)) collectRefs(p, into);
      if (schema.additional !== undefined) collectRefs(schema.additional, into);
      break;
    default:
  }
}

export function reachableDefinitions(operations: ApiOperation[], all: Record<string, ApiSchema>): Record<string, ApiSchema> {
  const pending = new Set<string>();
  for (const op of operations) {
    for (const p of op.parameters) collectRefs(p.schema, pending);
    if (op.body !== undefined) collectRefs(op.body.schema, pending);
    if (op.response !== undefined) collectRefs(op.response.schema, pending);
  }
  const result: Record<string, ApiSchema> = {};
  const queue = [...pending];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (name in result || all[name] === undefined) continue;
    result[name] = all[name]!;
    const next = new Set<string>();
    collectRefs(all[name]!, next);
    queue.push(...next);
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => byCodeUnit(a, b)));
}
