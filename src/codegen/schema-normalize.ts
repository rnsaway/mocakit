import type { MocaRow } from '../types.js';
import { byCodeUnit } from './names.js';
import type { ColumnCategory, SchemaColumn, SchemaTable } from './schema-snapshot.js';

export type Dialect = 'sqlserver' | 'oracle';

/** Raw catalog rows, keyed by the lowercase aliases used in introspect-schema.ts. */
export interface RawSchema {
  columns: MocaRow[];
  keys: MocaRow[];
}

const SQLSERVER_CATEGORIES: Record<string, ColumnCategory> = {
  char: 'string', varchar: 'string', nchar: 'string', nvarchar: 'string', text: 'string', ntext: 'string',
  sysname: 'string', uniqueidentifier: 'string', xml: 'string',
  tinyint: 'integer', smallint: 'integer', int: 'integer', bigint: 'integer',
  numeric: 'decimal', decimal: 'decimal', float: 'decimal', real: 'decimal', money: 'decimal', smallmoney: 'decimal',
  date: 'date', datetime: 'date', datetime2: 'date', smalldatetime: 'date', datetimeoffset: 'date', time: 'date',
  binary: 'binary', varbinary: 'binary', image: 'binary', timestamp: 'binary', rowversion: 'binary',
  bit: 'boolean',
};

const ORACLE_CATEGORIES: Record<string, ColumnCategory> = {
  char: 'string', varchar2: 'string', nchar: 'string', nvarchar2: 'string', clob: 'string', nclob: 'string',
  long: 'string', rowid: 'string', urowid: 'string',
  integer: 'integer',
  number: 'decimal', float: 'decimal', binary_float: 'decimal', binary_double: 'decimal',
  date: 'date', timestamp: 'date',
  blob: 'binary', raw: 'binary', 'long raw': 'binary',
};

/** SQL Server types whose `max_length` is a character length (in bytes: halved for the n-types). */
const SQLSERVER_LENGTH = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'sysname']);
const SQLSERVER_HALVED = new Set(['nchar', 'nvarchar', 'sysname']);
const ORACLE_LENGTH = new Set(['char', 'varchar2', 'nchar', 'nvarchar2']);
const NUMERIC_TYPES: Record<Dialect, Set<string>> = {
  sqlserver: new Set(['numeric', 'decimal']),
  oracle: new Set(['number']),
};

function text(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const s = text(value)?.toLowerCase();
  return s === '1' || s === 'y' || s === 'yes' || s === 't' || s === 'true';
}

const positive = (n: number | undefined): number | undefined => (n !== undefined && n > 0 ? n : undefined);

function baseType(dialect: Dialect, raw: string): string {
  const type = raw.toLowerCase().replace(/\(.*$/s, '').trim();
  return dialect === 'oracle' && type.startsWith('timestamp') ? 'timestamp' : type;
}

function toColumn(dialect: Dialect, row: MocaRow, rawName: string, unknownTypes: Set<string>): SchemaColumn {
  const type = baseType(dialect, text(row.data_type) ?? '');
  const precision = positive(num(row.precision));
  const scale = num(row.scale);
  let category = (dialect === 'sqlserver' ? SQLSERVER_CATEGORIES : ORACLE_CATEGORIES)[type];
  if (dialect === 'oracle' && type === 'number' && scale === 0) category = 'integer';
  if (category === undefined) {
    category = 'other';
    if (type !== '') unknownTypes.add(type);
  }

  const column: SchemaColumn = {
    name: rawName.toLowerCase(),
    type: type === '' ? 'unknown' : type,
    category,
    nullable: dialect === 'sqlserver' ? bool(row.is_nullable) : text(row.nullable)?.toUpperCase() === 'Y',
  };
  let length: number | undefined;
  if (dialect === 'sqlserver' && SQLSERVER_LENGTH.has(type)) {
    const bytes = positive(num(row.max_length)); // -1 means (max): no length
    length = bytes !== undefined && SQLSERVER_HALVED.has(type) ? bytes / 2 : bytes;
  } else if (dialect === 'oracle' && ORACLE_LENGTH.has(type)) {
    length = positive(num(row.char_length));
  }
  if (length !== undefined) column.length = length;
  if (NUMERIC_TYPES[dialect].has(type)) {
    if (precision !== undefined) column.precision = precision;
    if (scale !== undefined && scale > 0) column.scale = scale;
  }
  const comment = text(row.column_comment);
  if (comment !== undefined) column.comment = comment;
  return column;
}

interface RawTable {
  kind: 'table' | 'view';
  comment: string | undefined;
  columns: Array<{ raw: string; ordinal: number; column: SchemaColumn }>;
}

/** Turns raw catalog rows into sorted, lowercased tables. Pure; warnings are returned, not printed. */
export function normalizeSchema(dialect: Dialect, raw: RawSchema): { tables: SchemaTable[]; warnings: string[] } {
  const warnings: string[] = [];
  const unknownTypes = new Set<string>();

  const byRaw = new Map<string, RawTable>();
  for (const row of raw.columns) {
    const rawTable = text(row.table_name);
    const rawColumn = text(row.column_name);
    if (rawTable === undefined || rawColumn === undefined) continue;
    let entry = byRaw.get(rawTable);
    if (entry === undefined) {
      entry = { kind: text(row.table_kind)?.toLowerCase() === 'view' ? 'view' : 'table', comment: text(row.table_comment), columns: [] };
      byRaw.set(rawTable, entry);
    }
    entry.columns.push({ raw: rawColumn, ordinal: num(row.ordinal) ?? entry.columns.length + 1, column: toColumn(dialect, row, rawColumn, unknownTypes) });
  }

  const keys = new Map<string, Array<{ column: string; ordinal: number }>>();
  for (const row of raw.keys) {
    const table = text(row.table_name)?.toLowerCase();
    const column = text(row.column_name)?.toLowerCase();
    if (table === undefined || column === undefined) continue;
    const list = keys.get(table) ?? [];
    list.push({ column, ordinal: num(row.key_ordinal) ?? list.length + 1 });
    keys.set(table, list);
  }

  const tables: SchemaTable[] = [];
  const keptTable = new Map<string, string>();
  for (const rawTable of [...byRaw.keys()].sort(byCodeUnit)) {
    const name = rawTable.toLowerCase();
    const kept = keptTable.get(name);
    if (kept !== undefined) {
      warnings.push(`Tables "${kept}" and "${rawTable}" both lowercase to "${name}"; keeping "${kept}"`);
      continue;
    }
    keptTable.set(name, rawTable);
    const entry = byRaw.get(rawTable) as RawTable;

    // Case collisions: the byCodeUnit-first raw name wins; output stays in ordinal order.
    const winner = new Map<string, string>();
    for (const raw of entry.columns.map((c) => c.raw).sort(byCodeUnit)) {
      const lower = raw.toLowerCase();
      const first = winner.get(lower);
      if (first === undefined) winner.set(lower, raw);
      else if (first !== raw) warnings.push(`Table "${name}": columns "${first}" and "${raw}" both lowercase to "${lower}"; keeping "${first}"`);
    }
    // A repeated raw column (e.g. a catalog join that multiplied rows) is kept once.
    const columns: SchemaColumn[] = [];
    for (const c of [...entry.columns].sort((a, b) => a.ordinal - b.ordinal)) {
      if (winner.get(c.column.name) !== c.raw || columns.some((kept) => kept.name === c.column.name)) continue;
      columns.push(c.column);
    }

    let primaryKey: string[] | undefined;
    const keyRows = entry.kind === 'table' ? keys.get(name) : undefined;
    if (keyRows !== undefined) {
      const names = new Set(columns.map((c) => c.name));
      primaryKey = [];
      for (const key of [...keyRows].sort((a, b) => a.ordinal - b.ordinal)) {
        if (names.has(key.column)) primaryKey.push(key.column);
        else warnings.push(`Primary key column "${key.column}" not found on table "${name}"; dropped`);
      }
      if (primaryKey.length === 0) primaryKey = undefined;
    }

    tables.push({
      name,
      kind: entry.kind,
      ...(entry.comment !== undefined && { comment: entry.comment }),
      ...(primaryKey !== undefined && { primaryKey }),
      columns,
    });
  }

  for (const type of [...unknownTypes].sort(byCodeUnit)) {
    warnings.push(`Column type "${type}" is not recognised; typed as MocaValue`);
  }
  return { tables, warnings };
}
