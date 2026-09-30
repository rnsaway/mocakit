import type { DateCodec } from '../dates/codec.js';
import { MocaArgumentError } from '../errors.js';
import type { CallOptions, MocaArgValue, MocaResult } from '../types.js';
import { isMocaArgName } from '../util/text.js';
import { renderArgValue } from './render.js';

/** Options accepted by `from(...).rows()`: a select has nothing to roll back and no command arguments. */
export type QueryRowsOptions = Pick<CallOptions, 'format' | 'convert' | 'env' | 'signal'>;

/**
 * Equality filter. `null` means `is null`; `undefined` leaves the column out. Untyped rows accept any
 * argument value; typed rows get each column's value type (`Date` is also accepted for string columns,
 * because date columns are strings in the schema model).
 * Filter date columns with a `Date`: it is sent through `to_date(@col, 'YYYYMMDDHH24MISS')`. A
 * YYYYMMDDHH24MISS string is sent as a plain string and may fail on SQL Server.
 */
export type QueryFilter<Row> = string extends keyof Row
  ? Record<string, MocaArgValue>
  : { [K in keyof Row]?: (NonNullable<Row[K]> extends string ? string | Date : NonNullable<Row[K]>) | null };

/** An immutable single-table select. Build it with `moca.from(table)`, run it with `.rows()`. */
export interface Query<Row extends object, Picked extends keyof Row = keyof Row> {
  /** Columns to return; omitted means every column. Replaces an earlier `select`. */
  select<K extends keyof Row & string>(...columns: K[]): Query<Row, K>;
  /** Equality filters, combined with `and`. Can be called repeatedly; a column may appear once. */
  where(filter: QueryFilter<Row>): Query<Row, Picked>;
  /** Adds an `order by` column (default `asc`). */
  orderBy(column: keyof Row & string, direction?: 'asc' | 'desc'): Query<Row, Picked>;
  rows(opts?: QueryRowsOptions & { format?: 'rows' }): Promise<Array<Pick<Row, Picked>>>;
  rows(opts: QueryRowsOptions & { format: 'full' }): Promise<MocaResult<Pick<Row, Picked>>>;
}

type Direction = 'asc' | 'desc';

export interface QueryState {
  readonly table: string;
  readonly columns: readonly string[];
  readonly filter: ReadonlyArray<readonly [string, unknown]>;
  readonly order: ReadonlyArray<readonly [string, Direction]>;
}

const SQL_NAME = /^[a-z_][a-z0-9_$#]*$/;

function sqlName(kind: 'Table' | 'Column', name: unknown): string {
  if (typeof name !== 'string' || !SQL_NAME.test(name)) {
    throw new MocaArgumentError(
      `${kind} name ${JSON.stringify(name)} is not a lowercase SQL identifier (letters, digits, _, $, #)`,
      String(name),
    );
  }
  return name;
}

/** `publish data where a = 'x' | [select … where a = @a and b is null order by …]` */
export function renderQuery(state: QueryState, codec: DateCodec): string {
  const published: string[] = [];
  const conditions: string[] = [];
  for (const [column, value] of state.filter) {
    if (value === undefined) continue;
    if (value === null) {
      conditions.push(`${column} is null`);
      continue;
    }
    published.push(`${column} = ${renderArgValue(column, value, codec)}`);
    conditions.push(
      value instanceof Date ? `${column} = to_date(@${column}, 'YYYYMMDDHH24MISS')` : `${column} = @${column}`,
    );
  }
  let sql = `select ${state.columns.length > 0 ? state.columns.join(', ') : '*'} from ${state.table}`;
  if (conditions.length > 0) sql += ` where ${conditions.join(' and ')}`;
  if (state.order.length > 0) sql += ` order by ${state.order.map(([c, d]) => `${c} ${d}`).join(', ')}`;
  return published.length > 0 ? `publish data where ${published.join(' and ')} | [${sql}]` : `[${sql}]`;
}

const REJECTED_OPTIONS = ['dryRun', 'extraArgs', 'noRowsIsError'] as const;

type Run = (text: string, opts: CallOptions) => Promise<unknown>;

class QueryBuilder {
  readonly #run: Run;
  readonly #codec: DateCodec;
  readonly #state: QueryState;

  constructor(run: Run, codec: DateCodec, state: QueryState) {
    this.#run = run;
    this.#codec = codec;
    this.#state = state;
  }

  #with(change: Partial<QueryState>): QueryBuilder {
    return new QueryBuilder(this.#run, this.#codec, { ...this.#state, ...change });
  }

  select(...columns: string[]): QueryBuilder {
    const seen = new Set<string>();
    for (const column of columns) {
      sqlName('Column', column);
      if (seen.has(column)) throw new MocaArgumentError(`Column "${column}" appears twice in select()`, column);
      seen.add(column);
    }
    return this.#with({ columns: [...columns] });
  }

  where(filter: Record<string, unknown>): QueryBuilder {
    const entries = [...this.#state.filter];
    const seen = new Set(entries.map(([column]) => column));
    for (const [column, value] of Object.entries(filter ?? {})) {
      if (value === undefined) continue;
      sqlName('Column', column);
      if (!isMocaArgName(column)) {
        throw new MocaArgumentError(
          `Column "${column}" cannot be used in where(): MOCA variable names allow only letters, digits and _ (use exec())`,
          column,
        );
      }
      if (seen.has(column)) throw new MocaArgumentError(`Column "${column}" appears twice in where()`, column);
      seen.add(column);
      entries.push([column, value]);
    }
    return this.#with({ filter: entries });
  }

  orderBy(column: string, direction: Direction = 'asc'): QueryBuilder {
    sqlName('Column', column);
    if (direction !== 'asc' && direction !== 'desc') {
      throw new MocaArgumentError(`orderBy direction must be one of asc, desc; got ${JSON.stringify(direction)}`, column);
    }
    if (this.#state.order.some(([c]) => c === column)) {
      throw new MocaArgumentError(`Column "${column}" appears twice in orderBy()`, column);
    }
    return this.#with({ order: [...this.#state.order, [column, direction]] });
  }

  async rows(opts: QueryRowsOptions = {}): Promise<unknown> {
    for (const option of REJECTED_OPTIONS) {
      if (Object.hasOwn(opts ?? {}, option)) {
        throw new MocaArgumentError(`${option} is not supported by from().rows()`, option);
      }
    }
    return this.#run(renderQuery(this.#state, this.#codec), opts ?? {});
  }
}

export function createQuery<Row extends object>(run: Run, codec: DateCodec, table: string): Query<Row> {
  sqlName('Table', table);
  return new QueryBuilder(run, codec, { table, columns: [], filter: [], order: [] }) as unknown as Query<Row>;
}
