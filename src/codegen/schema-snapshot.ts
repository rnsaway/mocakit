import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { stripBom } from '../util/text.js';

export type ColumnCategory = 'string' | 'integer' | 'decimal' | 'date' | 'binary' | 'boolean' | 'other';

export const COLUMN_CATEGORIES: readonly ColumnCategory[] = ['string', 'integer', 'decimal', 'date', 'binary', 'boolean', 'other'];

export interface SchemaColumn {
  /** Lowercased. */
  name: string;
  /** Native type name, lowercased, without a `(…)` suffix. */
  type: string;
  category: ColumnCategory;
  nullable: boolean;
  /** Characters, for bounded string types. */
  length?: number;
  precision?: number;
  scale?: number;
  comment?: string;
}

export interface SchemaTable {
  /** Lowercased. */
  name: string;
  kind: 'table' | 'view';
  comment?: string;
  /** Ordered primary-key column names. */
  primaryKey?: string[];
  /** In ordinal order. */
  columns: SchemaColumn[];
}

export interface CodeValue {
  value: string;
  short?: string;
  long?: string;
}

export interface ColumnCodes {
  column: string;
  values: CodeValue[];
}

export interface SchemaCodes {
  locale: string;
  columns: ColumnCodes[];
}

export interface TableUsage {
  table: string;
  readBy: string[];
  writtenBy: string[];
}

export interface SchemaSnapshot {
  mocakitVersion: string;
  generatedAt: string;
  /** Server URL with credentials and query removed. */
  server: string;
  database: 'sqlserver' | 'oracle';
  /** Sorted by name. */
  tables: SchemaTable[];
  /** Code values (codmst/dscmst) for one locale, when `schema.codes` is on. */
  codes?: SchemaCodes;
  /** Commands that read/write each table, found by scanning command source (approximate). */
  usage?: TableUsage[];
}

export async function writeSchemaSnapshot(path: string, snapshot: SchemaSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optString = (v: unknown) => v === undefined || typeof v === 'string';
const optNumber = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

function invalid(path: string, detail?: string): never {
  throw new Error(`${path} is not a mocakit schema snapshot${detail === undefined ? '' : `: ${detail}`}`);
}

function checkColumn(path: string, table: string, column: unknown): void {
  const name = isObject(column) && typeof column.name === 'string' ? column.name : '?';
  const where = `column "${table}.${name}"`;
  if (!isObject(column) || typeof column.name !== 'string' || column.name === '') invalid(path, where);
  if (typeof column.type !== 'string' || typeof column.nullable !== 'boolean') invalid(path, where);
  if (!COLUMN_CATEGORIES.includes(column.category as ColumnCategory)) invalid(path, where);
  if (!optNumber(column.length) || !optNumber(column.precision) || !optNumber(column.scale) || !optString(column.comment)) {
    invalid(path, where);
  }
}

function checkTable(path: string, table: unknown): void {
  const name = isObject(table) && typeof table.name === 'string' ? table.name : '?';
  const where = `table "${name}"`;
  if (!isObject(table) || typeof table.name !== 'string' || table.name === '') invalid(path, where);
  if (table.kind !== 'table' && table.kind !== 'view') invalid(path, where);
  if (!optString(table.comment) || !Array.isArray(table.columns)) invalid(path, where);
  if (table.primaryKey !== undefined && !(Array.isArray(table.primaryKey) && table.primaryKey.every((c) => typeof c === 'string'))) {
    invalid(path, where);
  }
  for (const column of table.columns as unknown[]) checkColumn(path, table.name, column);
}

function checkCodes(path: string, codes: unknown): void {
  if (!isObject(codes) || typeof codes.locale !== 'string' || !Array.isArray(codes.columns)) invalid(path, 'codes');
  for (const column of codes.columns as unknown[]) {
    const name = isObject(column) && typeof column.column === 'string' ? column.column : '?';
    if (!isObject(column) || typeof column.column !== 'string' || !Array.isArray(column.values)) invalid(path, `codes column "${name}"`);
    for (const value of column.values as unknown[]) {
      if (!isObject(value) || typeof value.value !== 'string' || !optString(value.short) || !optString(value.long)) {
        invalid(path, `codes column "${name}"`);
      }
    }
  }
}

function checkUsage(path: string, usage: unknown): void {
  if (!Array.isArray(usage)) invalid(path, 'usage');
  for (const entry of usage as unknown[]) {
    const name = isObject(entry) && typeof entry.table === 'string' ? entry.table : '?';
    if (!isObject(entry) || typeof entry.table !== 'string' || !isStringArray(entry.readBy) || !isStringArray(entry.writtenBy)) {
      invalid(path, `usage table "${name}"`);
    }
  }
}

export async function readSchemaSnapshot(path: string): Promise<SchemaSnapshot> {
  const raw = stripBom(await readFile(path, 'utf8'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed) || typeof parsed.server !== 'string' || !Array.isArray(parsed.tables)) invalid(path);
  if (parsed.database !== 'sqlserver' && parsed.database !== 'oracle') invalid(path, `database ${JSON.stringify(parsed.database)}`);
  for (const table of parsed.tables as unknown[]) checkTable(path, table);
  if (parsed.codes !== undefined) checkCodes(path, parsed.codes);
  if (parsed.usage !== undefined) checkUsage(path, parsed.usage);
  return parsed as unknown as SchemaSnapshot;
}

/** True when two snapshots describe the same schema (timestamps and versions are ignored). */
export function sameSchema(a: SchemaSnapshot, b: SchemaSnapshot): boolean {
  return (
    a.database === b.database &&
    isDeepStrictEqual(a.tables, b.tables) &&
    isDeepStrictEqual(a.codes, b.codes) &&
    isDeepStrictEqual(a.usage, b.usage)
  );
}
