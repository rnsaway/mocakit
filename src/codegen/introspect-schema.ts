import type { MocaClient } from '../client/client.js';
import { MocaError } from '../errors.js';
import type { MocaRow } from '../types.js';
import { redactUrl } from '../util/url.js';
import { normalizeSchema, type Dialect, type RawSchema } from './schema-normalize.js';
import type { SchemaSnapshot } from './schema-snapshot.js';

// Catalog SQL. Rules (spec §5.2): lowercase aliases, no @@ (MOCA intercepts it inside [...]),
// no -- comments, no @name tokens (MOCA would bind them), ordered for stable output.

export const SQLSERVER_COLUMNS = `[select o.name table_name,
        case o.type when 'V' then 'view' else 'table' end table_kind,
        cast(tp.value as nvarchar(4000)) table_comment,
        c.name column_name,
        c.column_id ordinal,
        t.name data_type,
        c.max_length max_length,
        c.precision precision,
        c.scale scale,
        c.is_nullable is_nullable,
        cast(cp.value as nvarchar(4000)) column_comment
   from sys.objects o
   join sys.columns c on c.object_id = o.object_id
   join sys.types t on t.user_type_id = c.user_type_id
   left join sys.extended_properties tp
     on tp.class = 1 and tp.major_id = o.object_id and tp.minor_id = 0 and tp.name = 'MS_Description'
   left join sys.extended_properties cp
     on cp.class = 1 and cp.major_id = o.object_id and cp.minor_id = c.column_id and cp.name = 'MS_Description'
  where o.type in ('U', 'V')
    and o.is_ms_shipped = 0
    and o.schema_id = schema_id()
  order by o.name, c.column_id]`;

export const SQLSERVER_KEYS = `[select o.name table_name, c.name column_name, ic.key_ordinal key_ordinal
   from sys.indexes i
   join sys.objects o on o.object_id = i.object_id
   join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
   join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
  where i.is_primary_key = 1
    and o.is_ms_shipped = 0
    and o.schema_id = schema_id()
  order by o.name, ic.key_ordinal]`;

const CURRENT_SCHEMA = "sys_context('USERENV', 'CURRENT_SCHEMA')";

export function oracleColumns(scope: 'user' | 'all'): string {
  const all = scope === 'all';
  const own = (alias: string, other: string) => (all ? ` and ${alias}.owner = ${other}.owner` : '');
  return `[select lower(c.table_name) table_name,
        lower(o.object_type) table_kind,
        tc.comments table_comment,
        lower(c.column_name) column_name,
        c.column_id ordinal,
        c.data_type data_type,
        c.char_length char_length,
        c.data_precision precision,
        c.data_scale scale,
        c.nullable nullable,
        cc.comments column_comment
   from ${scope}_tab_columns c
   join ${scope}_objects o on o.object_name = c.table_name${own('o', 'c')} and o.object_type in ('TABLE', 'VIEW')
   left join ${scope}_tab_comments tc on tc.table_name = c.table_name${own('tc', 'c')}
   left join ${scope}_col_comments cc on cc.table_name = c.table_name and cc.column_name = c.column_name${own('cc', 'c')}
  where c.table_name not like 'BIN$%'${all ? `\n    and c.owner = ${CURRENT_SCHEMA}` : ''}
  order by c.table_name, c.column_id]`;
}

export function oracleKeys(scope: 'user' | 'all'): string {
  const all = scope === 'all';
  return `[select lower(k.table_name) table_name, lower(k.column_name) column_name, k.position key_ordinal
   from ${scope}_constraints p
   join ${scope}_cons_columns k on k.constraint_name = p.constraint_name and k.table_name = p.table_name${all ? ' and k.owner = p.owner' : ''}
  where p.constraint_type = 'P'${all ? `\n    and p.owner = ${CURRENT_SCHEMA}` : ''}
  order by k.table_name, k.position]`;
}

async function detectDialect(client: MocaClient): Promise<Dialect> {
  const rows = await client.exec('get database');
  const first = rows[0] === undefined ? undefined : Object.values(rows[0])[0];
  const value = typeof first === 'string' ? first.trim() : '';
  const lower = value.toLowerCase();
  if (lower === 'sqlserver' || lower === 'oracle') return lower;
  throw new Error(`Unsupported database "${value}"; mocakit supports SQL Server and Oracle`);
}

async function readCatalog(client: MocaClient, dialect: Dialect): Promise<RawSchema> {
  if (dialect === 'sqlserver') {
    const columns = await client.exec(SQLSERVER_COLUMNS);
    return { columns, keys: await client.exec(SQLSERVER_KEYS) };
  }
  let scope: 'user' | 'all' = 'user';
  let columns: MocaRow[] = await client.exec(oracleColumns('user'));
  if (columns.length === 0) {
    scope = 'all';
    columns = await client.exec(oracleColumns('all'));
  }
  return { columns, keys: await client.exec(oracleKeys(scope)) };
}

function wrap(error: unknown): Error {
  const status = error instanceof MocaError && error.status !== -1 ? ` (MOCA status ${error.status})` : '';
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Schema introspection failed${status}: ${message}. The MOCA login needs read access to the database catalog ` +
      '(sys.* on SQL Server, USER_* on Oracle). Remove "schema" from the config (or pass --no-schema) to skip it.',
    { cause: error },
  );
}

/** Reads the login schema's tables, views, columns, comments and primary keys. */
export async function introspectSchema(
  client: MocaClient,
  options: { version: string; server: string },
): Promise<{ snapshot: SchemaSnapshot; warnings: string[] }> {
  let dialect: Dialect;
  let raw: RawSchema;
  try {
    dialect = await detectDialect(client);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unsupported database')) throw error;
    throw wrap(error);
  }
  try {
    raw = await readCatalog(client, dialect);
  } catch (error) {
    throw wrap(error);
  }
  const { tables, warnings } = normalizeSchema(dialect, raw);
  if (tables.length === 0) throw new Error("Schema introspection found no tables in the MOCA login's schema");
  return {
    snapshot: {
      mocakitVersion: options.version,
      generatedAt: new Date().toISOString(),
      server: redactUrl(options.server),
      database: dialect,
      tables,
    },
    warnings,
  };
}
