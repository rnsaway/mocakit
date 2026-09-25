import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGenerate } from '../src/cli/generate.js';
import { IGNORE_SSL_TRUE } from '../src/cli/load-config.js';
import { MocaClient } from '../src/client/client.js';
import { introspect } from '../src/codegen/introspect.js';
import type { Snapshot } from '../src/codegen/snapshot.js';
import { isMocaStatus, MocaCommandError } from '../src/errors.js';
import { buildRequest } from '../src/protocol/request.js';
import { parseResponse } from '../src/protocol/response.js';
import { httpTransport } from '../src/transport/http.js';

const live = process.env.MOCA_URL ? describe : describe.skip;
const ignoreSsl = (): boolean => IGNORE_SSL_TRUE.test(process.env.MOCA_IGNORE_SSL ?? '');

live('live MOCA server', () => {
  // Created lazily in beforeAll: even under describe.skip, Vitest still runs this describe
  // callback, and MocaClient's constructor now throws on blank credentials -- which env vars
  // are when MOCA_URL is unset.
  let client: MocaClient;
  let snapshot: Snapshot | undefined;

  beforeAll(() => {
    client = new MocaClient({
      url: process.env.MOCA_URL!,
      username: process.env.MOCA_USER!,
      password: process.env.MOCA_PASSWORD!,
      ignoreSslIssues: ignoreSsl(),
      session: { reuse: false },
    });
  });

  afterAll(async () => {
    await client?.logout();
  });

  it('logs in', async () => {
    const row = await client.login();
    console.log('login columns:', Object.keys(row));
    expect(client.session.active).toBe(true);
  });

  it('lists active commands (prints columns)', async () => {
    const result = await client.exec('list active commands', { format: 'full' });
    console.log('list active commands columns:', result.columns);
    expect(result.rows.length).toBeGreaterThan(0);
  }, 120_000);

  it('lists active command arguments (prints columns and their distinct values)', async () => {
    const result = await client
      .exec('list active command arguments', { format: 'full' })
      .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    console.log('unfiltered list active command arguments:', result);
    if (result instanceof Error) return;
    // Log every column's distinct values (capped) rather than guessing which one is the dtype
    // column, so all candidates -- dtype, required flag, whatever else -- can be read by eye.
    const columns = Object.keys(result.rows[0] ?? {});
    for (const column of columns) {
      const values = [...new Set(result.rows.map((r) => String(r[column])))];
      console.log(`column "${column}" (${values.length} distinct):`, values.slice(0, 30));
    }
  }, 120_000);

  it('introspects', async () => {
    const result = await introspect(client, { version: 'live', server: process.env.MOCA_URL! });
    snapshot = result.snapshot;
    console.log(`introspected ${snapshot.commands.length} commands; warnings:`, result.warnings);
    expect(snapshot.commands.length).toBeGreaterThan(0);
    expect(snapshot.commands.some((c) => c.args.length > 0)).toBe(true);
  }, 600_000);

  it('enforces a flagged argument on a compiled command with status 507 (spec §14)', async (ctx) => {
    snapshot ??= (await introspect(client, { version: 'live', server: process.env.MOCA_URL! })).snapshot;
    const compiled = new Set(['c function', 'simple c function', 'java method']);
    const stackTypes = new Set(['POINTER', 'RESULTS', 'OBJECT', 'BINARY']);
    const command = snapshot.commands.find((c) => {
      if (!compiled.has(c.type?.trim().toLowerCase() ?? '') || !c.name.startsWith('list ')) return false;
      const flagged = c.args.filter((a) => a.required);
      return flagged.length === 1 && !stackTypes.has(flagged[0]!.dtype.trim().toUpperCase());
    });
    if (!command) {
      console.log('no list command of a compiled type with exactly one flagged non-stack argument; skipped');
      return ctx.skip();
    }
    // Read-only: a `list` command, called without its one required argument, so MOCA rejects it.
    const error = await client.exec(command.name).catch((e: unknown) => e);
    console.log('missing required argument -> status', error instanceof MocaCommandError ? error.status : 'not a MocaCommandError');
    // Plain boolean checks: a failed toBeInstanceOf would print the value, which could hold result rows.
    expect(error instanceof MocaCommandError).toBe(true);
    expect((error as MocaCommandError).status).toBe(507);
  }, 600_000);

  it('returns [] for a query with no rows (510), and throws 510 with noRowsIsError', async () => {
    // Oracle syntax; on another SQL dialect the query itself fails, which is logged rather
    // than failed, since it says nothing about mocakit's 510 handling.
    const query = '[select 1 x from dual where 1 = 0]';
    let rows: unknown[];
    try {
      rows = await client.exec(query);
    } catch (error) {
      console.log('510 check skipped; the no-rows query failed (different SQL dialect?):', (error as Error).message);
      return;
    }
    expect(rows).toEqual([]);
    const error = await client.exec(query, { noRowsIsError: true }).catch((e: unknown) => e);
    expect(isMocaStatus(error, 510)).toBe(true);
  }, 120_000);

  it('reports a non-zero status for a bogus SESSION_KEY (spec §14 item 5)', async () => {
    const text = await httpTransport({
      url: process.env.MOCA_URL!,
      body: buildRequest('list active commands', { USR_ID: process.env.MOCA_USER!, SESSION_KEY: 'mocakit-bogus-session-key' }),
      timeoutMs: 60_000,
      ignoreSslIssues: ignoreSsl(),
    });
    const response = parseResponse(text);
    console.log('bogus SESSION_KEY -> status', response.status, 'message', response.message);
    expect(response.status).not.toBe(0);
  }, 120_000);

  it('generate --dry-run reports "Would write" and writes no files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mocakit-live-'));
    try {
      const out: string[] = [];
      const err: string[] = [];
      await runGenerate({
        dryRun: true,
        cwd: dir,
        env: {
          MOCA_URL: process.env.MOCA_URL,
          MOCA_USER: process.env.MOCA_USER,
          MOCA_PASSWORD: process.env.MOCA_PASSWORD,
          MOCA_IGNORE_SSL: process.env.MOCA_IGNORE_SSL,
        },
        io: { log: (m) => out.push(m), error: (m) => err.push(m) },
      });
      console.log('dry-run output:', out.at(-1), `(${err.length} warnings)`);
      expect(out.at(-1)).toMatch(/^Would write \d+ commands to /);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);

  // Transactions (spec "Transactions"). SQL Server syntax. Each test uses its own global temp
  // table, which lives only in tempdb: nothing else on the server is touched. Only statuses,
  // counts and booleans are logged. (MOCA intercepts `@@name` inside `[...]`, so none is used.)
  describe('transactions', () => {
    const stamp = Date.now();
    const table = (suffix: string): string => `##mk_${stamp}_${suffix}`;
    const firstValue = (rows: ReadonlyArray<Record<string, unknown>>): number => Number(Object.values(rows[0] ?? {})[0]);

    /** Asked in a separate request, so it sees only what was committed. */
    async function exists(name: string): Promise<boolean> {
      const rows = await client.exec(`[select case when object_id('tempdb..${name}') is null then 0 else 1 end present]`);
      return firstValue(rows) === 1;
    }

    async function dropIfExists(name: string): Promise<void> {
      await client.exec(`[if object_id('tempdb..${name}') is not null drop table ${name}]`);
    }

    it('dryRun returns the rows, then rolls everything back', async () => {
      const name = table('dry');
      try {
        const rows = await client.exec(
          `[create table ${name} (id int)] ; [insert into ${name} (id) values (1)] ; [select count(*) n from ${name}]`,
          { dryRun: true },
        );
        const count = firstValue(rows);
        const present = await exists(name);
        console.log('dryRun: count inside', count, '| table present afterwards', present);
        expect(count).toBe(1);
        expect(present).toBe(false);
      } finally {
        await dropIfExists(name);
      }
    }, 120_000);

    it('batch commits every step at the end of the request', async () => {
      const name = table('commit');
      try {
        await client.batch((b) => [b.raw(`[create table ${name} (id int)]`), b.raw(`[insert into ${name} (id) values (1)]`)]);
        const present = await exists(name);
        const count = firstValue(await client.exec(`[select count(*) n from ${name}]`));
        console.log('batch: table present afterwards', present, '| count', count);
        expect(present).toBe(true);
        expect(count).toBe(1);
      } finally {
        await dropIfExists(name);
      }
      expect(await exists(name)).toBe(false);
    }, 120_000);

    it('batch rolls back every step when a later step fails', async () => {
      const name = table('rollback');
      try {
        const error = await client
          .batch((b) => [b.raw(`[create table ${name} (id int)]`), b.raw(`[select id from mk_${stamp}_no_such_table]`)])
          .catch((e: unknown) => e);
        const present = await exists(name);
        console.log(
          'batch error: status',
          error instanceof MocaCommandError ? error.status : 'not a MocaCommandError',
          '| table present afterwards',
          present,
        );
        expect(error instanceof MocaCommandError).toBe(true);
        expect(present).toBe(false);
      } finally {
        await dropIfExists(name);
      }
    }, 120_000);

    it('a read-only dryRun returns its rows without error (the catch (@?) / 511 path)', async () => {
      const rows = await client.exec('[select 1 a]', { dryRun: true });
      console.log('read-only dryRun: rows', rows.length, '| a', firstValue(rows));
      expect(rows.length).toBe(1);
      expect(firstValue(rows)).toBe(1);
    }, 120_000);

    it('a batch whose last step finds no rows throws 510, and MOCA rolled every step back', async () => {
      const name = table('norows_last');
      try {
        const error = await client
          .batch((b) => [
            b.raw(`[create table ${name} (x int)]`),
            b.raw(`[insert into ${name} values (1)]`),
            b.raw(`[select x from ${name} where x = 2]`),
          ])
          .catch((e: unknown) => e);
        const present = await exists(name);
        console.log('batch 510 last: status', error instanceof MocaCommandError ? error.status : 'no MocaCommandError', '| table present afterwards', present);
        expect(error instanceof MocaCommandError).toBe(true);
        expect((error as MocaCommandError).status).toBe(510);
        expect(present).toBe(false);
      } finally {
        await dropIfExists(name);
      }
    }, 120_000);

    it('a batch whose middle step finds no rows throws 510, and nothing survives', async () => {
      const name = table('norows_mid');
      try {
        const error = await client
          .batch((b) => [
            b.raw(`[create table ${name} (x int)]`),
            b.raw(`[select x from ${name} where x = 2]`),
            b.raw(`[insert into ${name} values (1)]`),
          ])
          .catch((e: unknown) => e);
        const present = await exists(name);
        console.log('batch 510 middle: status', error instanceof MocaCommandError ? error.status : 'no MocaCommandError', '| table present afterwards', present);
        expect(error instanceof MocaCommandError).toBe(true);
        expect((error as MocaCommandError).status).toBe(510);
        expect(present).toBe(false);
      } finally {
        await dropIfExists(name);
      }
    }, 120_000);

    it('a dryRun batch returns the last step and rolls every step back', async () => {
      const name = table('drybatch');
      try {
        const rows = await client.batch(
          (b) => [
            b.raw(`[create table ${name} (id int)]`),
            b.raw(`[insert into ${name} (id) values (1)]`),
            b.raw(`[select count(*) n from ${name}]`),
          ],
          { dryRun: true },
        );
        const count = firstValue(rows);
        const present = await exists(name);
        console.log('dryRun batch: count inside', count, '| table present afterwards', present);
        expect(count).toBe(1);
        expect(present).toBe(false);
      } finally {
        await dropIfExists(name);
      }
    }, 120_000);
  });
});
