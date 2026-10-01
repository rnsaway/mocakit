import type { MocaClient } from '../client/client.js';
import { quoteMocaString } from '../client/render.js';
import { MocaError } from '../errors.js';
import type { MocaRow } from '../types.js';
import { resolveColumns, TRUE_FLAGS } from './introspect.js';
import { byCodeUnit, commandKey, isValidCommandName } from './names.js';
import type { CodeValue, SchemaCodes } from './schema-snapshot.js';

export interface CommandDefinition {
  level: string;
  levelSeq: number;
  type?: string;
  source?: string;
  javaClass?: string;
  cFunction?: string;
  transaction?: string;
  description?: string;
}

export interface CommandInfo {
  /** Display name (whitespace-normalised) of the active definition. */
  name: string;
  /** `commandKey(name)`. */
  key: string;
  /** Highest `cmplvlseq` definition. */
  active: CommandDefinition;
  /** Lower-level definitions, highest first. */
  overrides: CommandDefinition[];
}

export interface TriggerInfo {
  name: string;
  /** Command key the trigger fires on. */
  command: string;
  seq: number;
  enabled: boolean;
  source?: string;
}

const DEFINITION_COLUMNS = {
  name: ['command', 'cmd_nam', 'cmdnam', 'command_name'],
  level: ['cmplvl', 'cmp_lvl', 'level', 'component_level'],
  seq: ['cmplvlseq', 'cmp_lvl_seq', 'level_seq'],
  type: ['type', 'cmdtyp', 'cmd_typ'],
  source: ['syntax', 'source'],
  javaClass: ['class'],
  cFunction: ['functn', 'function'],
  transaction: ['trnstyp', 'trn_typ'],
  description: ['description', 'desc', 'cmd_desc'],
};

const TRIGGER_COLUMNS = {
  name: ['name', 'trgnam', 'trigger_name'],
  command: ['command', 'cmd_nam'],
  seq: ['trgseq', 'seq', 'trg_seq'],
  source: ['syntax', 'source'],
  enabled: ['enabled', 'enaflg', 'ena_flg'],
};

const str = (row: MocaRow, column: string | undefined): string => {
  if (column === undefined) return '';
  const value = row[column];
  return value === null || value === undefined || Array.isArray(value) ? '' : String(value).trim();
};
const raw = (row: MocaRow, column: string | undefined): string => {
  if (column === undefined) return '';
  const value = row[column];
  return value === null || value === undefined || Array.isArray(value) ? '' : String(value);
};
const num = (text: string): number => (Number.isFinite(Number(text)) && text !== '' ? Number(text) : 0);
const normalizeName = (name: string): string => name.trim().replace(/\s+/g, ' ');

export function readCommandDefinitions(rawRows: { columns: string[]; rows: MocaRow[] }): CommandInfo[] {
  const c = resolveColumns<keyof typeof DEFINITION_COLUMNS>(rawRows.columns, DEFINITION_COLUMNS, ['name'], 'list active commands');
  const groups = new Map<string, Array<{ name: string; def: CommandDefinition }>>();
  for (const row of rawRows.rows) {
    const name = normalizeName(str(row, c.name));
    if (name === '' || !isValidCommandName(name)) continue;
    const def: CommandDefinition = { level: str(row, c.level), levelSeq: num(str(row, c.seq)) };
    const add = (field: Exclude<keyof CommandDefinition, 'level' | 'levelSeq'>, value: string) => {
      if (value.trim() !== '') def[field] = value;
    };
    add('type', str(row, c.type));
    add('source', raw(row, c.source));
    add('javaClass', str(row, c.javaClass));
    add('cFunction', str(row, c.cFunction));
    add('transaction', str(row, c.transaction));
    add('description', str(row, c.description));
    const key = commandKey(name);
    const group = groups.get(key) ?? [];
    group.push({ name, def });
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([key, group]) => {
      const sorted = [...group].sort((a, b) => b.def.levelSeq - a.def.levelSeq || byCodeUnit(a.def.level, b.def.level));
      const [first, ...rest] = sorted as [(typeof sorted)[number], ...typeof sorted];
      return { name: first.name, key, active: first.def, overrides: rest.map((r) => r.def) };
    });
}

function wrap(what: string, setting: string, error: unknown): Error {
  const status = error instanceof MocaError && error.status !== -1 ? ` (MOCA status ${error.status})` : '';
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Reading ${what} failed${status}: ${message}. Set ${setting} to false to skip them.`, { cause: error });
}

export async function readTriggers(client: MocaClient): Promise<TriggerInfo[]> {
  let result;
  let c;
  try {
    result = await client.exec('list active triggers', { format: 'full' });
    if (result.rows.length === 0) return [];
    c = resolveColumns<keyof typeof TRIGGER_COLUMNS>(
      result.columns.map((col) => col.name),
      TRIGGER_COLUMNS,
      ['name', 'command'],
      'list active triggers',
    );
  } catch (error) {
    throw wrap('triggers', 'commandDocs.triggers', error);
  }
  const triggers: TriggerInfo[] = [];
  for (const row of result.rows) {
    const name = str(row, c.name);
    const command = normalizeName(str(row, c.command));
    if (name === '' || command === '') continue;
    const enabledValue = c.enabled === undefined ? true : row[c.enabled];
    const trigger: TriggerInfo = {
      name,
      command: commandKey(command),
      seq: num(str(row, c.seq)),
      enabled: typeof enabledValue === 'boolean' ? enabledValue : TRUE_FLAGS.has(String(enabledValue ?? '').toLowerCase()),
    };
    const source = raw(row, c.source);
    if (source.trim() !== '') trigger.source = source;
    triggers.push(trigger);
  }
  return triggers.sort((a, b) => byCodeUnit(a.command, b.command) || a.seq - b.seq || byCodeUnit(a.name, b.name));
}

const isPurged = (row: MocaRow): boolean => {
  const value = row.is_purged;
  return value === true || TRUE_FLAGS.has(String(value ?? '').toLowerCase());
};

export async function readCodes(client: MocaClient, locale: string): Promise<{ codes: SchemaCodes; warnings: string[] }> {
  const warnings: string[] = [];
  const describe = (loc: string) =>
    client.exec(`[select * from dscmst where locale_id = ${quoteMocaString(loc)} order by colnam, colval]`);
  let codmst: MocaRow[];
  let dscmst: MocaRow[];
  let used = locale;
  try {
    codmst = await client.exec('[select * from codmst order by colnam, srtseq, codval]');
    dscmst = await describe(locale);
    if (dscmst.length === 0 && locale !== 'US_ENGLISH') {
      dscmst = await describe('US_ENGLISH');
      used = 'US_ENGLISH';
      warnings.push(`No code descriptions for locale "${locale}"; used US_ENGLISH`);
    }
  } catch (error) {
    throw wrap('code values', 'schema.codes', error);
  }

  const byColumn = new Map<string, Map<string, CodeValue & { order: number }>>();
  const entry = (column: string) => {
    let values = byColumn.get(column);
    if (values === undefined) {
      values = new Map();
      byColumn.set(column, values);
    }
    return values;
  };
  for (const row of codmst) {
    if (isPurged(row)) continue;
    const column = String(row.colnam ?? '').trim().toLowerCase();
    const value = String(row.codval ?? '').trim();
    if (column === '' || value === '') continue;
    const values = entry(column);
    if (!values.has(value)) values.set(value, { value, order: num(String(row.srtseq ?? '')) });
  }
  for (const row of dscmst) {
    if (isPurged(row)) continue;
    const column = String(row.colnam ?? '').trim().toLowerCase();
    const value = String(row.colval ?? '').trim();
    if (column === '' || value === '') continue;
    const values = entry(column);
    const existing = values.get(value) ?? { value, order: Number.MAX_SAFE_INTEGER };
    const short = String(row.short_dsc ?? '').trim();
    const long = String(row.lngdsc ?? '').trim();
    if (short !== '') existing.short = short;
    if (long !== '') existing.long = long;
    values.set(value, existing);
  }
  const columns = [...byColumn.entries()]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([column, values]) => ({
      column,
      values: [...values.values()]
        .sort((a, b) => a.order - b.order || byCodeUnit(a.value, b.value))
        .map(({ order: _order, ...value }) => value),
    }));
  return { codes: { locale: used, columns }, warnings };
}
