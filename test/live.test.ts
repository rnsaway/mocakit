import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MocaClient } from '../src/client/client.js';
import { introspect } from '../src/codegen/introspect.js';
import { classifyMocaType } from '../src/protocol/moca-types.js';

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
      ignoreSslIssues: process.env.MOCA_IGNORE_SSL === 'true',
      session: { reuse: false },
    });
  });

  afterAll(async () => {
    await client.logout();
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

  it('lists active command arguments (prints columns and dtype codes)', async () => {
    const result = await client
      .exec('list active command arguments', { format: 'full' })
      .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    console.log('unfiltered list active command arguments:', result);
    if (result instanceof Error) return;
    const dtypeColumn = Object.keys(result.rows[0] ?? {}).find((k) => /type/i.test(k));
    const codes = new Set(result.rows.map((r) => String(dtypeColumn ? r[dtypeColumn] : '')));
    console.log('dtype codes:', [...codes].map((c) => `${c}→${classifyMocaType(c)}`));
  }, 120_000);

  it('introspects', async () => {
    const snapshot = await introspect(client, { version: 'live', server: process.env.MOCA_URL! });
    console.log(`introspected ${snapshot.commands.length} commands`);
    expect(snapshot.commands.length).toBeGreaterThan(0);
    expect(snapshot.commands.some((c) => c.args.length > 0)).toBe(true);
  }, 600_000);
});
