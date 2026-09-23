import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MocaClient } from '../src/client/client.js';
import { IGNORE_SSL_TRUE } from '../src/cli/load-config.js';
import { introspect } from '../src/codegen/introspect.js';

const live = process.env.MOCA_URL ? describe : describe.skip;

live('live MOCA server', () => {
  // Created lazily in beforeAll: even under describe.skip, Vitest still runs this describe
  // callback, and MocaClient's constructor now throws on blank credentials -- which env vars
  // are when MOCA_URL is unset.
  let client: MocaClient;

  beforeAll(() => {
    client = new MocaClient({
      url: process.env.MOCA_URL!,
      username: process.env.MOCA_USER!,
      password: process.env.MOCA_PASSWORD!,
      ignoreSslIssues: IGNORE_SSL_TRUE.test(process.env.MOCA_IGNORE_SSL ?? ''),
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
    const { snapshot, warnings } = await introspect(client, { version: 'live', server: process.env.MOCA_URL! });
    console.log(`introspected ${snapshot.commands.length} commands; warnings:`, warnings);
    expect(snapshot.commands.length).toBeGreaterThan(0);
    expect(snapshot.commands.some((c) => c.args.length > 0)).toBe(true);
  }, 600_000);
});
