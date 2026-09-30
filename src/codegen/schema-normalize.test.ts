import { describe, expect, it } from 'vitest';
import type { MocaRow } from '../types.js';
import { normalizeSchema } from './schema-normalize.js';

const ss = (table: string, column: string, ordinal: number, dataType: string, extra: MocaRow = {}): MocaRow => ({
  table_name: table,
  table_kind: 'table',
  table_comment: null,
  column_name: column,
  ordinal,
  data_type: dataType,
  max_length: null,
  precision: 0,
  scale: 0,
  is_nullable: true,
  column_comment: null,
  ...extra,
});

const ora = (table: string, column: string, ordinal: number, dataType: string, extra: MocaRow = {}): MocaRow => ({
  table_name: table,
  table_kind: 'table',
  table_comment: null,
  column_name: column,
  ordinal,
  data_type: dataType,
  char_length: 0,
  precision: null,
  scale: null,
  nullable: 'Y',
  column_comment: null,
  ...extra,
});

describe('normalizeSchema (SQL Server)', () => {
  it('maps types, lengths, nullability, comments and kinds', () => {
    const { tables, warnings } = normalizeSchema('sqlserver', {
      columns: [
        ss('widget', 'widget_id', 1, 'nvarchar', { max_length: 40, is_nullable: false, column_comment: '  Id.  ', table_comment: 'Widgets.' }),
        ss('widget', 'qty', 2, 'numeric', { precision: 19, scale: 4 }),
        ss('widget', 'cnt', 3, 'int', { precision: 10 }),
        ss('widget', 'notes', 4, 'nvarchar', { max_length: -1 }),
        ss('widget', 'code', 5, 'char', { max_length: 3 }),
        ss('widget', 'moddte', 6, 'datetime'),
        ss('widget', 'flag', 7, 'bit'),
        ss('widget', 'blob', 8, 'varbinary', { max_length: 16 }),
        ss('widget', 'geo', 9, 'geography'),
        ss('widget', 'empty_comment', 10, 'int', { column_comment: '   ' }),
        ss('widget_view', 'widget_id', 1, 'nvarchar', { table_kind: 'view', max_length: 40 }),
      ],
      keys: [{ table_name: 'widget', column_name: 'widget_id', key_ordinal: 1 }],
    });
    expect(tables.map((t) => [t.name, t.kind])).toEqual([
      ['widget', 'table'],
      ['widget_view', 'view'],
    ]);
    const widget = tables[0]!;
    expect(widget.comment).toBe('Widgets.');
    expect(widget.primaryKey).toEqual(['widget_id']);
    expect(widget.columns).toEqual([
      { name: 'widget_id', type: 'nvarchar', category: 'string', nullable: false, length: 20, comment: 'Id.' },
      { name: 'qty', type: 'numeric', category: 'decimal', nullable: true, precision: 19, scale: 4 },
      { name: 'cnt', type: 'int', category: 'integer', nullable: true },
      { name: 'notes', type: 'nvarchar', category: 'string', nullable: true },
      { name: 'code', type: 'char', category: 'string', nullable: true, length: 3 },
      { name: 'moddte', type: 'datetime', category: 'date', nullable: true },
      { name: 'flag', type: 'bit', category: 'boolean', nullable: true },
      { name: 'blob', type: 'varbinary', category: 'binary', nullable: true },
      { name: 'geo', type: 'geography', category: 'other', nullable: true },
      { name: 'empty_comment', type: 'int', category: 'integer', nullable: true },
    ]);
    expect(tables[1]!.primaryKey).toBeUndefined();
    expect(warnings).toEqual(['Column type "geography" is not recognised; typed as MocaValue']);
  });

  it('keeps numeric scale 0 as decimal and omits a zero scale', () => {
    const { tables } = normalizeSchema('sqlserver', { columns: [ss('w', 'n', 1, 'numeric', { precision: 10, scale: 0 })], keys: [] });
    expect(tables[0]!.columns[0]).toEqual({ name: 'n', type: 'numeric', category: 'decimal', nullable: true, precision: 10 });
  });

  it('accepts is_nullable as 1/0 strings', () => {
    const { tables } = normalizeSchema('sqlserver', { columns: [ss('w', 'a', 1, 'int', { is_nullable: '0' })], keys: [] });
    expect(tables[0]!.columns[0]!.nullable).toBe(false);
  });
});

describe('normalizeSchema (Oracle)', () => {
  it('lowercases names and maps Oracle types', () => {
    const { tables } = normalizeSchema('oracle', {
      columns: [
        ora('WIDGET', 'WIDGET_ID', 1, 'VARCHAR2', { char_length: 20, nullable: 'N' }),
        ora('WIDGET', 'QTY', 2, 'NUMBER', { precision: 19, scale: 4 }),
        ora('WIDGET', 'CNT', 3, 'NUMBER', { precision: 10, scale: 0 }),
        ora('WIDGET', 'ANYNUM', 4, 'NUMBER'),
        ora('WIDGET', 'MODDTE', 5, 'TIMESTAMP(6) WITH TIME ZONE'),
        ora('WIDGET', 'BODY', 6, 'CLOB'),
        ora('WIDGET', 'PIC', 7, 'LONG RAW'),
      ],
      keys: [{ table_name: 'WIDGET', column_name: 'WIDGET_ID', key_ordinal: 1 }],
    });
    expect(tables[0]!.name).toBe('widget');
    expect(tables[0]!.primaryKey).toEqual(['widget_id']);
    expect(tables[0]!.columns).toEqual([
      { name: 'widget_id', type: 'varchar2', category: 'string', nullable: false, length: 20 },
      { name: 'qty', type: 'number', category: 'decimal', nullable: true, precision: 19, scale: 4 },
      { name: 'cnt', type: 'number', category: 'integer', nullable: true, precision: 10 },
      { name: 'anynum', type: 'number', category: 'decimal', nullable: true },
      { name: 'moddte', type: 'timestamp', category: 'date', nullable: true },
      { name: 'body', type: 'clob', category: 'string', nullable: true },
      { name: 'pic', type: 'long raw', category: 'binary', nullable: true },
    ]);
  });
});

describe('normalizeSchema (shared rules)', () => {
  it('sorts tables and orders columns by ordinal', () => {
    const { tables } = normalizeSchema('sqlserver', {
      columns: [ss('zeta', 'b', 2, 'int'), ss('alpha', 'x', 1, 'int'), ss('zeta', 'a', 1, 'int')],
      keys: [],
    });
    expect(tables.map((t) => t.name)).toEqual(['alpha', 'zeta']);
    expect(tables[1]!.columns.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('keeps the first of two tables that lowercase to the same name, and warns', () => {
    const { tables, warnings } = normalizeSchema('sqlserver', {
      columns: [ss('widget', 'a', 1, 'int'), ss('Widget', 'b', 1, 'int')],
      keys: [],
    });
    expect(tables).toHaveLength(1);
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(['b']);
    expect(warnings).toEqual(['Tables "Widget" and "widget" both lowercase to "widget"; keeping "Widget"']);
  });

  it('keeps the first of two columns that lowercase to the same name, and warns', () => {
    const { tables, warnings } = normalizeSchema('sqlserver', {
      columns: [ss('w', 'qty', 1, 'int'), ss('w', 'QTY', 2, 'int')],
      keys: [],
    });
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(['qty']);
    expect(warnings).toEqual(['Table "w": columns "QTY" and "qty" both lowercase to "qty"; keeping "QTY"']);
  });

  it('orders multi-column keys and drops key columns the table does not have', () => {
    const { tables, warnings } = normalizeSchema('sqlserver', {
      columns: [ss('w', 'a', 1, 'int'), ss('w', 'b', 2, 'int')],
      keys: [
        { table_name: 'w', column_name: 'b', key_ordinal: 2 },
        { table_name: 'w', column_name: 'a', key_ordinal: 1 },
        { table_name: 'w', column_name: 'gone', key_ordinal: 3 },
        { table_name: 'missing_table', column_name: 'a', key_ordinal: 1 },
      ],
    });
    expect(tables[0]!.primaryKey).toEqual(['a', 'b']);
    expect(warnings).toEqual(['Primary key column "gone" not found on table "w"; dropped']);
  });

  it('writes keys in a stable property order for JSON', () => {
    const { tables } = normalizeSchema('sqlserver', {
      columns: [ss('w', 'a', 1, 'nvarchar', { max_length: 4, table_comment: 'T', column_comment: 'C' })],
      keys: [{ table_name: 'w', column_name: 'a', key_ordinal: 1 }],
    });
    expect(Object.keys(tables[0]!)).toEqual(['name', 'kind', 'comment', 'primaryKey', 'columns']);
    expect(Object.keys(tables[0]!.columns[0]!)).toEqual(['name', 'type', 'category', 'nullable', 'length', 'comment']);
  });

  it('keeps a column once when the catalog repeats its row', () => {
    const { tables, warnings } = normalizeSchema('sqlserver', { columns: [ss('w', 'a', 1, 'int'), ss('w', 'a', 1, 'int')], keys: [] });
    expect(tables[0]!.columns.map((c) => c.name)).toEqual(['a']);
    expect(warnings).toEqual([]);
  });

  it('skips rows without a table or column name', () => {
    const { tables } = normalizeSchema('sqlserver', { columns: [ss('', 'a', 1, 'int'), ss('w', '', 1, 'int')], keys: [] });
    expect(tables).toEqual([]);
  });
});
