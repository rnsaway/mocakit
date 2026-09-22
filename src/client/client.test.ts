import { describe, expect, it } from 'vitest';
import { baseConfig, fakeMoca, loginOk, mocaXml, type FakeRequest } from '../../test/helpers/fake-moca.js';
import { MocaArgumentError, MocaAuthError, MocaCommandError, MocaProtocolError, isMocaStatus } from '../errors.js';
import { MemorySessionStore } from '../session/store.js';
import type { CommandSpec, MocaConfig } from '../types.js';
import { MocaClient } from './client.js';

const ORDERS = mocaXml(0, {
  columns: [{ name: 'ordnum', type: 'S' }, { name: 'ordqty', type: 'I' }, { name: 'cancel_flg', type: 'O' }],
  rows: [['A1', '5', '0']],
});

function client(handler: (r: FakeRequest) => string, config: Partial<MocaConfig> = {}, now?: () => number) {
  const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : handler(r)));
  const moca = new MocaClient({ ...baseConfig, ...config }, { transport: fake.transport, now });
  return { moca, requests: fake.requests };
}

describe('MocaClient.exec', () => {
  it('logs in first, then returns converted rows', async () => {
    const { moca, requests } = client(() => ORDERS, { warehouse: 'WMD1' });
    await expect(moca.exec('list orders')).resolves.toEqual([{ ordnum: 'A1', ordqty: 5, cancel_flg: false }]);

    expect(requests[0]).toMatchObject({
      query: `login user where usr_id = 'JDOE' and usr_pswd = 'p''w'`,
      autocommit: false,
      env: { USR_ID: 'JDOE' },
    });
    expect(requests[1]).toMatchObject({
      query: 'list orders',
      autocommit: true,
      env: { USR_ID: 'JDOE', SESSION_KEY: 'KEY1', WH_ID: 'WMD1', LOCALE_ID: 'US_ENGLISH' },
    });
  });

  it('reuses the session for later calls', async () => {
    const { moca, requests } = client(() => ORDERS);
    await moca.exec('a');
    await moca.exec('b');
    expect(requests.map((r) => r.query.split(' ')[0])).toEqual(['login', 'a', 'b']);
  });

  it('returns the full result with format: full, and raw strings with convert: false', async () => {
    const { moca } = client(() => ORDERS);
    const full = await moca.exec('list orders', { format: 'full', convert: false });
    expect(full).toEqual({
      status: 0,
      message: null,
      columns: [{ name: 'ordnum', type: 'S' }, { name: 'ordqty', type: 'I' }, { name: 'cancel_flg', type: 'O' }],
      rows: [{ ordnum: 'A1', ordqty: '5', cancel_flg: '0' }],
    });
  });

  it('returns [] on 510 by default and throws with noRowsIsError', async () => {
    const { moca } = client(() => mocaXml(510, {}, 'No Data Found'));
    await expect(moca.exec('list orders')).resolves.toEqual([]);
    await expect(moca.exec('list orders', { noRowsIsError: true })).rejects.toSatisfy((e) => isMocaStatus(e, 510));
  });

  it('throws MocaCommandError with status, server message and command', async () => {
    const { moca } = client(() => mocaXml(10134, {}, 'Invalid location'));
    const error = (await moca.exec('validate location').catch((e: unknown) => e)) as MocaCommandError;
    expect(error).toBeInstanceOf(MocaCommandError);
    expect(error).toMatchObject({ status: 10134, serverMessage: 'Invalid location', command: 'validate location' });
  });

  it('throws MocaProtocolError for a non-MOCA body', async () => {
    const { moca } = client(() => '<html>proxy error</html>');
    await expect(moca.exec('x')).rejects.toBeInstanceOf(MocaProtocolError);
  });

  it('re-logs in once on 523 and retries', async () => {
    let first = true;
    const { moca, requests } = client(() => {
      if (first) {
        first = false;
        return mocaXml(523, {}, 'Session expired');
      }
      return ORDERS;
    });
    await expect(moca.exec('list orders')).resolves.toHaveLength(1);
    expect(requests.map((r) => r.query.split(' ')[0])).toEqual(['login', 'list', 'login', 'list']);
  });

  it('throws MocaAuthError when 523 persists after re-login', async () => {
    const { moca } = client(() => mocaXml(523));
    await expect(moca.exec('x')).rejects.toBeInstanceOf(MocaAuthError);
  });

  it('honours client defaults and per-call env overrides', async () => {
    const { moca, requests } = client(() => ORDERS, { defaults: { autocommit: false, convert: false } });
    const rows = await moca.exec('x', { env: { WH_ID: 'OVR' } });
    expect(rows).toEqual([{ ordnum: 'A1', ordqty: '5', cancel_flg: '0' }]);
    expect(requests[1]).toMatchObject({ autocommit: false, env: { WH_ID: 'OVR' } });
  });
});

describe('MocaClient.call', () => {
  const spec: CommandSpec = ['list orders', [['wh_id', 'S', 1], ['ordqty', 'I', 0]]];

  it('renders the where clause', async () => {
    const { moca, requests } = client(() => ORDERS);
    await moca.call(spec, { wh_id: 'W', ordqty: null }, { extraArgs: { prtnum: 'P' } });
    expect(requests[1]!.query).toBe(`list orders where wh_id = 'W' and prtnum = 'P'`);
  });

  it('throws MocaArgumentError without contacting the server', async () => {
    const { moca, requests } = client(() => ORDERS);
    const error = (await moca.call(spec, {}).catch((e: unknown) => e)) as MocaArgumentError;
    expect(error).toBeInstanceOf(MocaArgumentError);
    expect(error.command).toBe('list orders');
    expect(requests).toHaveLength(0);
  });

  it('attaches args to server errors', async () => {
    const { moca } = client(() => mocaXml(99, {}, 'boom'));
    const error = (await moca.call(spec, { wh_id: 'W' }).catch((e: unknown) => e)) as MocaCommandError;
    expect(error.args).toEqual({ wh_id: 'W' });
    expect(error.command).toBe(`list orders where wh_id = 'W'`);
  });
});

describe('MocaClient login, logout and session', () => {
  it('login() fails with MocaAuthError and never leaks the password', async () => {
    const fake = fakeMoca(() => mocaXml(523, {}, 'Invalid user'));
    const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    const error = (await moca.login().catch((e: unknown) => e)) as MocaAuthError;
    expect(error).toBeInstanceOf(MocaAuthError);
    expect(error.command).toContain(`usr_pswd = '***'`);
    expect(JSON.stringify(error)).not.toContain("p''w");
  });

  it('login() returns the converted login row and makes the session active', async () => {
    const { moca } = client(() => ORDERS);
    await expect(moca.login()).resolves.toMatchObject({ session_key: 'KEY1', cust_lvl: 0 });
    expect(moca.session).toMatchObject({ active: true, locale: 'US_ENGLISH' });
  });

  it('logout() sends logout user and forces a new login next time', async () => {
    const { moca, requests } = client(() => ORDERS);
    await moca.exec('a');
    await moca.logout();
    expect(moca.session).toEqual({ active: false, locale: null, ageMs: null });
    await moca.exec('b');
    expect(requests.map((r) => r.query)).toEqual([
      expect.stringMatching(/^login user/),
      'a',
      'logout user',
      expect.stringMatching(/^login user/),
      'b',
    ]);
  });

  it('logout() with no session does nothing', async () => {
    const { moca, requests } = client(() => ORDERS);
    await moca.logout();
    expect(requests).toHaveLength(0);
  });

  it('shares sessions between clients when reuse is on', async () => {
    const store = new MemorySessionStore();
    const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : ORDERS));
    const config = { ...baseConfig, session: { reuse: true, store } };
    await new MocaClient(config, { transport: fake.transport }).exec('a');
    await new MocaClient(config, { transport: fake.transport }).exec('b');
    expect(fake.requests.filter((r) => r.query.startsWith('login user'))).toHaveLength(1);
  });

  it('reports session age from the injected clock', async () => {
    const clock = { t: 0 };
    const { moca } = client(() => ORDERS, {}, () => clock.t);
    await moca.exec('a');
    clock.t = 1_500;
    expect(moca.session.ageMs).toBe(1_500);
  });
});
