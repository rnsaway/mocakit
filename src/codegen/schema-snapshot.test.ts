import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSchemaSnapshot, sameSchema, writeSchemaSnapshot, type SchemaSnapshot } from './schema-snapshot.js';

const snapshot: SchemaSnapshot = {
  mocakitVersion: '0.3.0',
  generatedAt: '2026-09-30T00:00:00.000Z',
  server: 'https://moca.test/service',
  database: 'sqlserver',
  tables: [
    {
      name: 'widget',
      kind: 'table',
      comment: 'Widgets on hand.',
      primaryKey: ['widget_id'],
      columns: [
        { name: 'widget_id', type: 'nvarchar', category: 'string', nullable: false, length: 20, comment: 'Id.' },
        { name: 'qty', type: 'numeric', category: 'decimal', nullable: true, precision: 19, scale: 4 },
      ],
    },
  ],
};

const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'mocakit-schema-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('schema snapshot', () => {
  it('round-trips through disk, creating the directory', async () => {
    const path = join(await temp(), 'nested/moca.schema.json');
    await writeSchemaSnapshot(path, snapshot);
    expect(await readSchemaSnapshot(path)).toEqual(snapshot);
  });

  it('accepts a leading BOM', async () => {
    const path = join(await temp(), 's.json');
    await writeFile(path, `﻿${JSON.stringify(snapshot)}`);
    expect((await readSchemaSnapshot(path)).tables).toHaveLength(1);
  });

  it.each([
    ['not JSON', '{', /is not valid JSON/],
    ['wrong database', JSON.stringify({ ...snapshot, database: 'db2' }), /is not a mocakit schema snapshot: database/],
    ['missing tables', JSON.stringify({ ...snapshot, tables: undefined }), /is not a mocakit schema snapshot/],
    ['bad kind', JSON.stringify({ ...snapshot, tables: [{ ...snapshot.tables[0], kind: 'synonym' }] }), /table "widget"/],
    [
      'bad category',
      JSON.stringify({ ...snapshot, tables: [{ ...snapshot.tables[0], columns: [{ ...snapshot.tables[0]!.columns[0], category: 'money' }] }] }),
      /column "widget\.widget_id"/,
    ],
    ['empty table name', JSON.stringify({ ...snapshot, tables: [{ ...snapshot.tables[0], name: '' }] }), /table ""/],
  ])('rejects %s', async (_label, content, message) => {
    const path = join(await temp(), 's.json');
    await writeFile(path, content);
    await expect(readSchemaSnapshot(path)).rejects.toThrow(message);
  });

  it('compares database and tables only', () => {
    expect(sameSchema(snapshot, { ...snapshot, generatedAt: 'later', mocakitVersion: '9.9.9' })).toBe(true);
    expect(sameSchema(snapshot, { ...snapshot, database: 'oracle' })).toBe(false);
    expect(sameSchema(snapshot, { ...snapshot, tables: [] })).toBe(false);
  });

  const withExtras: SchemaSnapshot = {
    ...snapshot,
    codes: { locale: 'US_ENGLISH', columns: [{ column: 'wdgsts', values: [{ value: 'A', short: 'Active' }, { value: 'X' }] }] },
    usage: [{ table: 'widget', readBy: ['list widgets'], writtenBy: ['create widget'] }],
  };

  it('round-trips codes and usage, and still reads a 0.3.0 snapshot without them', async () => {
    const dir = await temp();
    await writeSchemaSnapshot(join(dir, 'a.json'), withExtras);
    expect(await readSchemaSnapshot(join(dir, 'a.json'))).toEqual(withExtras);
    await writeSchemaSnapshot(join(dir, 'b.json'), snapshot);
    expect((await readSchemaSnapshot(join(dir, 'b.json'))).codes).toBeUndefined();
  });

  it.each([
    ['codes without locale', { ...snapshot, codes: { columns: [] } }, /codes/],
    ['code value not a string', { ...snapshot, codes: { locale: 'X', columns: [{ column: 'c', values: [{ value: 1 }] }] } }, /codes column "c"/],
    ['usage entry malformed', { ...snapshot, usage: [{ table: 'widget', readBy: 'x', writtenBy: [] }] }, /usage table "widget"/],
  ])('rejects %s', async (_label, content, message) => {
    const path = join(await temp(), 's.json');
    await writeFile(path, JSON.stringify(content));
    await expect(readSchemaSnapshot(path)).rejects.toThrow(message);
  });

  it('compares codes and usage', () => {
    expect(sameSchema(withExtras, { ...withExtras, generatedAt: 'later' })).toBe(true);
    expect(sameSchema(withExtras, { ...withExtras, usage: [] })).toBe(false);
    expect(sameSchema(withExtras, { ...withExtras, codes: undefined })).toBe(false);
  });
});
