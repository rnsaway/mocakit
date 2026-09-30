import { describe, expect, it } from 'vitest';
import { baseConfig, fakeMoca, loginOk, mocaXml, type FakeRequest } from '../../test/helpers/fake-moca.js';
import { MocaClient } from '../client/client.js';
import { introspectSchema, oracleColumns, oracleKeys, SQLSERVER_COLUMNS, SQLSERVER_KEYS } from './introspect-schema.js';

const database = (name: string) => mocaXml(0, { columns: [{ name: 'database' }], rows: [[name]] });

const SS_COLUMNS = mocaXml(0, {
  columns: [
    { name: 'table_name' }, { name: 'table_kind' }, { name: 'table_comment' }, { name: 'column_name' },
    { name: 'ordinal', type: 'I' }, { name: 'data_type' }, { name: 'max_length', type: 'I' },
    { name: 'precision', type: 'I' }, { name: 'scale', type: 'I' }, { name: 'is_nullable', type: 'O' },
    { name: 'column_comment' },
  ],
  rows: [
    ['widget', 'table', 'Widgets.', 'widget_id', '1', 'nvarchar', '40', '0', '0', '0', 'Id.'],
    ['widget', 'table', 'Widgets.', 'qty', '2', 'numeric', '9', '19', '4', '1', null],
  ],
});
const SS_KEYS = mocaXml(0, {
  columns: [{ name: 'table_name' }, { name: 'column_name' }, { name: 'key_ordinal', type: 'I' }],
  rows: [['widget', 'widget_id', '1']],
});

function run(handler: (r: FakeRequest) => string) {
  const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : handler(r)));
  const client = new MocaClient({ ...baseConfig }, { transport: fake.transport });
  const result = introspectSchema(client, { version: '0.3.0', server: 'https://u:p@moca.test/service?x=1' });
  return { result, requests: fake.requests };
}

describe('catalog SQL', () => {
  it.each([
    ['SQLSERVER_COLUMNS', SQLSERVER_COLUMNS],
    ['SQLSERVER_KEYS', SQLSERVER_KEYS],
    ['oracle user columns', oracleColumns('user')],
    ['oracle all columns', oracleColumns('all')],
    ['oracle user keys', oracleKeys('user')],
    ['oracle all keys', oracleKeys('all')],
  ])('%s is one bracketed statement with no MOCA hazards', (_name, sql) => {
    expect(sql.startsWith('[') && sql.endsWith(']')).toBe(true);
    expect(sql).not.toMatch(/@/);
    expect(sql).not.toMatch(/--/);
    expect(sql).toMatch(/order by/i);
  });

  it('scopes SQL Server to user objects in the login schema', () => {
    expect(SQLSERVER_COLUMNS).toContain('o.is_ms_shipped = 0');
    expect(SQLSERVER_COLUMNS).toContain('t.user_type_id = c.system_type_id');
    expect(SQLSERVER_COLUMNS).toContain('o.schema_id = schema_id()');
    expect(SQLSERVER_COLUMNS.match(/class = 1/g)).toHaveLength(2);
    expect(SQLSERVER_COLUMNS).toContain('cast(tp.value as nvarchar(4000))');
  });

  it('scopes Oracle ALL_* queries to the current schema and skips the recycle bin', () => {
    expect(oracleColumns('all')).toContain("sys_context('USERENV', 'CURRENT_SCHEMA')");
    expect(oracleColumns('user')).not.toContain('owner');
    expect(oracleColumns('user')).toContain("not like 'BIN$%'");
    expect(oracleKeys('all')).toContain("sys_context('USERENV', 'CURRENT_SCHEMA')");
  });
});

describe('introspectSchema', () => {
  it('detects SQL Server, reads columns then keys, and builds a redacted snapshot', async () => {
    const { result, requests } = run((r) =>
      r.query === 'get database' ? database('SQLServer') : r.query === SQLSERVER_COLUMNS ? SS_COLUMNS : SS_KEYS,
    );
    const { snapshot, warnings } = await result;
    expect(requests.map((r) => r.query).filter((q) => !q.startsWith('login'))).toEqual(['get database', SQLSERVER_COLUMNS, SQLSERVER_KEYS]);
    expect(snapshot).toMatchObject({ mocakitVersion: '0.3.0', server: 'https://moca.test/service', database: 'sqlserver' });
    expect(snapshot.tables[0]).toEqual({
      name: 'widget',
      kind: 'table',
      comment: 'Widgets.',
      primaryKey: ['widget_id'],
      columns: [
        { name: 'widget_id', type: 'nvarchar', category: 'string', nullable: false, length: 20, comment: 'Id.' },
        { name: 'qty', type: 'numeric', category: 'decimal', nullable: true, precision: 19, scale: 4 },
      ],
    });
    expect(warnings).toEqual([]);
  });

  it('falls back to ALL_* views on Oracle when USER_* returns no rows', async () => {
    const oraColumns = mocaXml(0, {
      columns: [
        { name: 'table_name' }, { name: 'table_kind' }, { name: 'table_comment' }, { name: 'column_name' },
        { name: 'ordinal', type: 'I' }, { name: 'data_type' }, { name: 'char_length', type: 'I' },
        { name: 'precision', type: 'I' }, { name: 'scale', type: 'I' }, { name: 'nullable' }, { name: 'column_comment' },
      ],
      rows: [['widget', 'table', null, 'widget_id', '1', 'VARCHAR2', '20', null, null, 'N', null]],
    });
    const { result, requests } = run((r) => {
      if (r.query === 'get database') return database('oracle');
      if (r.query === oracleColumns('user')) return mocaXml(510, {}, 'No rows affected');
      if (r.query === oracleColumns('all')) return oraColumns;
      if (r.query === oracleKeys('all')) return mocaXml(510, {}, 'No rows affected');
      throw new Error(`unexpected ${r.query}`);
    });
    const { snapshot } = await result;
    expect(snapshot.database).toBe('oracle');
    expect(snapshot.tables.map((t) => t.name)).toEqual(['widget']);
    expect(requests.some((r) => r.query === oracleKeys('user'))).toBe(false);
  });

  it.each([['db2'], ['']])('rejects an unsupported database %j', async (name) => {
    const { result } = run(() => (name === '' ? mocaXml(510, {}, 'No rows') : database(name)));
    await expect(result).rejects.toThrow(`Unsupported database "${name}"; mocakit supports SQL Server and Oracle`);
  });

  it('wraps a catalog failure with the status and guidance', async () => {
    const { result } = run((r) =>
      r.query === 'get database' ? database('sqlserver') : r.query === SQLSERVER_COLUMNS ? SS_COLUMNS : mocaXml(511, {}, 'permission denied'),
    );
    await expect(result).rejects.toThrow(
      /^Schema introspection failed \(MOCA status 511\): .*permission denied.*read access to the database catalog.*--no-schema/s,
    );
  });

  it('fails when the login schema has no tables', async () => {
    const { result } = run((r) => (r.query === 'get database' ? database('sqlserver') : mocaXml(510, {}, 'No rows')));
    await expect(result).rejects.toThrow("Schema introspection found no tables in the MOCA login's schema");
  });
});
