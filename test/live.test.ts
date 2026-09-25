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

  it('enforces a flagged argument on a compiled command with status 507 (spec §14)', async () => {
    snapshot ??= (await introspect(client, { version: 'live', server: process.env.MOCA_URL! })).snapshot;
    const compiled = new Set(['c function', 'java method']);
    const stackTypes = new Set(['POINTER', 'RESULTS', 'OBJECT', 'BINARY']);
    const command = snapshot.commands.find((c) => {
      if (!compiled.has(c.type?.trim().toLowerCase() ?? '') || !c.name.startsWith('list ')) return false;
      const flagged = c.args.filter((a) => a.required);
      return flagged.length === 1 && !stackTypes.has(flagged[0]!.dtype.trim().toUpperCase());
    });
    expect(command, 'a list command of type C Function or Java Method with one flagged argument').toBeDefined();
    // Read-only: a `list` command, called without its one required argument, so MOCA rejects it.
    const error = await client.exec(command!.name).catch((e: unknown) => e);
    console.log('missing required argument -> status', error instanceof MocaCommandError ? error.status : 'not a MocaCommandError');
    expect(error).toBeInstanceOf(MocaCommandError);
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
});
