import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { baseConfig, fakeMoca, loginOk, mocaXml, type FakeRequest } from '../../test/helpers/fake-moca.js';
import {
  MocaArgumentError,
  MocaAuthError,
  MocaCommandError,
  MocaProtocolError,
  MocaTransportError,
  isMocaStatus,
} from '../errors.js';
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

    // The raw password is `p'w` (doubled to `p''w` once quoted for MOCA). Assert it is
    // absent everywhere a careless log/serialize call might surface it.
    expect(error.message).not.toContain("p''w");
    expect(error.command).not.toContain("p''w");
    expect(JSON.stringify(error)).not.toContain("p''w");
    expect(String(error.cause)).not.toContain("p''w");
    // toJSON() (rather than `inspect(error, { getters: true })`, which never actually
    // surfaced `command` here) is what util.inspect and other loggers would show for this
    // error's own data, so inspect that directly.
    expect(inspect(error.toJSON())).not.toContain("p''w");
    expect(inspect(error.toJSON())).toContain('command');
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

describe('MocaClient shared login error isolation', () => {
  it('does not leak one concurrent call\'s args onto another when the shared login fails', async () => {
    const fake = fakeMoca(() => mocaXml(523, {}, 'Invalid user'));
    const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    const spec: CommandSpec = ['list orders', [['wh_id', 'S', 1]]];

    const [first, second] = (await Promise.all([
      moca.call(spec, { wh_id: 'A' }).catch((e: unknown) => e),
      moca.call(spec, { wh_id: 'B' }).catch((e: unknown) => e),
    ])) as [MocaAuthError, MocaAuthError];

    for (const error of [first, second]) {
      expect(error).toBeInstanceOf(MocaAuthError);
      expect(error.args).toBeUndefined();
      expect(error.command).toMatch(/^login user where usr_id = 'JDOE' and usr_pswd = '\*\*\*'$/);
    }
  });

  it('does not leak args when the shared post-523 re-login fails', async () => {
    // The initial login succeeds (so both calls get to the command), every command attempt
    // then gets a 523, and the *re*-login (triggered by the retry) fails. That re-login is
    // itself single-flight and shared by both concurrent calls.
    let loginCount = 0;
    const fake = fakeMoca((r) => {
      if (r.query.startsWith('login user')) {
        loginCount += 1;
        return loginCount === 1 ? loginOk() : mocaXml(1, {}, 're-login failed');
      }
      return mocaXml(523, {}, 'Session expired');
    });
    const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    const spec: CommandSpec = ['list orders', [['wh_id', 'S', 1]]];

    const [first, second] = (await Promise.all([
      moca.call(spec, { wh_id: 'A' }).catch((e: unknown) => e),
      moca.call(spec, { wh_id: 'B' }).catch((e: unknown) => e),
    ])) as [MocaAuthError, MocaAuthError];

    for (const error of [first, second]) {
      expect(error).toBeInstanceOf(MocaAuthError);
      expect(error.args).toBeUndefined();
    }
  });
});

describe('MocaClient protected environment keys', () => {
  it('rejects an env override of USR_ID before contacting the server', async () => {
    const { moca, requests } = client(() => ORDERS);
    const error = (await moca.exec('a', { env: { usr_id: 'HACKED' } }).catch((e: unknown) => e)) as MocaArgumentError;
    expect(error).toBeInstanceOf(MocaArgumentError);
    expect(error.message).toBe('USR_ID and SESSION_KEY cannot be overridden per call');
    expect(requests).toHaveLength(0);
  });

  it('rejects an env override of SESSION_KEY (case-insensitive) before contacting the server', async () => {
    const { moca, requests } = client(() => ORDERS);
    const error = (await moca.exec('a', { env: { Session_Key: 'HACKED' } }).catch((e: unknown) => e)) as MocaArgumentError;
    expect(error).toBeInstanceOf(MocaArgumentError);
    expect(requests).toHaveLength(0);
  });

  it('still allows overriding WH_ID, DEVCOD and LOCALE_ID', async () => {
    const { moca, requests } = client(() => ORDERS, { warehouse: 'WMD1' });
    await moca.exec('a', { env: { WH_ID: 'OTHER', DEVCOD: 'DEV1', LOCALE_ID: 'US_ENGLISH' } });
    expect(requests[1]).toMatchObject({ env: { WH_ID: 'OTHER', DEVCOD: 'DEV1', LOCALE_ID: 'US_ENGLISH' } });
  });
});

describe('MocaClient abort handling while waiting for a login', () => {
  it('rejects promptly when the caller aborts while a login is in flight, without cancelling the login', async () => {
    const LOGIN_DELAY_MS = 1_000;
    let loginSettled = false;
    const fake = fakeMoca(async (r) => {
      if (r.query.startsWith('login user')) {
        await new Promise((resolve) => setTimeout(resolve, LOGIN_DELAY_MS));
        loginSettled = true;
        return loginOk();
      }
      return ORDERS;
    });
    const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const started = Date.now();
    const error = (await moca
      .exec('list orders', { signal: controller.signal })
      .catch((e: unknown) => e)) as MocaTransportError;
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(MocaTransportError);
    expect(error.message).toMatch(/aborted/);
    // Comfortably below LOGIN_DELAY_MS: proves the caller did not wait for the login,
    // without being so tight that scheduler jitter makes the test flaky.
    expect(elapsed).toBeLessThan(200);
    expect(loginSettled).toBe(false);

    // The login is not cancelled by the abort -- it keeps running in the background (shared
    // with any other concurrent caller). Let it finish so it doesn't leak into a later test.
    await new Promise((resolve) => setTimeout(resolve, LOGIN_DELAY_MS));
    expect(loginSettled).toBe(true);
  });

  it('sends no additional request for a call made with an already-aborted signal', async () => {
    const { moca, requests } = client(() => ORDERS);
    await moca.exec('warm up the session');
    const before = requests.length;

    const error = (await moca
      .exec('a', { signal: AbortSignal.abort() })
      .catch((e: unknown) => e)) as MocaTransportError;

    expect(error).toBeInstanceOf(MocaTransportError);
    expect(error.message).toMatch(/aborted/);
    expect(requests).toHaveLength(before);
  });

  it('never starts a login for a pre-aborted call with no cached session, and raises no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      // A login that, if it were ever started, would fail -- proving it really never runs.
      const fake = fakeMoca(() => mocaXml(1, {}, 'login would fail'));
      const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });

      const error = (await moca
        .exec('list orders', { signal: AbortSignal.abort() })
        .catch((e: unknown) => e)) as MocaTransportError;

      expect(error).toBeInstanceOf(MocaTransportError);
      expect(error.message).toMatch(/aborted/);
      expect(fake.requests).toHaveLength(0);

      // Flush the microtask/macrotask queue so any rejection from a login that was started
      // (and never awaited by anything) would have surfaced as an unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('checks the signal before retrying after a 523, instead of always retrying', async () => {
    const controller = new AbortController();
    // Abort as the 523 response for the first attempt is produced, so the signal is already
    // aborted by the time #execute checks it, just before the retry would fire.
    const fake = fakeMoca((r) => {
      if (r.query.startsWith('login user')) return loginOk();
      controller.abort();
      return mocaXml(523, {}, 'Session expired');
    });
    const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    const error = (await moca
      .exec('list orders', { signal: controller.signal })
      .catch((e: unknown) => e)) as MocaTransportError;
    expect(error).toBeInstanceOf(MocaTransportError);
    expect(error.message).toMatch(/aborted/);
    // login + first attempt only; no second login triggered by the retry.
    expect(fake.requests.map((r) => r.query.split(' ')[0])).toEqual(['login', 'list']);
  });
});

describe('MocaClient session-expired retry', () => {
  it('evicts the fresh session before throwing when 523 persists after re-login, so the next call logs in again', async () => {
    const { moca, requests } = client(() => mocaXml(523));
    await expect(moca.exec('x')).rejects.toBeInstanceOf(MocaAuthError);
    await expect(moca.exec('x')).rejects.toBeInstanceOf(MocaAuthError);
    // Each call re-logs-in from scratch (login, x, login, x) because the previously acquired
    // session was evicted rather than left cached and stale.
    expect(requests.map((r) => r.query.split(' ')[0])).toEqual([
      'login', 'x', 'login', 'x',
      'login', 'x', 'login', 'x',
    ]);
  });
});

describe('MocaClient constructor validation', () => {
  it('rejects an empty url', () => {
    expect(() => new MocaClient({ ...baseConfig, url: '' })).toThrow(MocaArgumentError);
  });

  it('rejects an empty username', () => {
    expect(() => new MocaClient({ ...baseConfig, username: '' })).toThrow(MocaArgumentError);
  });

  it('rejects an empty password', () => {
    expect(() => new MocaClient({ ...baseConfig, password: '' })).toThrow(MocaArgumentError);
  });

  it('rejects a blank (whitespace-only) url/username/password', () => {
    expect(() => new MocaClient({ ...baseConfig, url: '   ' })).toThrow(MocaArgumentError);
    expect(() => new MocaClient({ ...baseConfig, username: '   ' })).toThrow(MocaArgumentError);
    expect(() => new MocaClient({ ...baseConfig, password: '   ' })).toThrow(MocaArgumentError);
  });

  it('rejects a non-string password (e.g. undefined slipping past a loose caller)', () => {
    expect(() => new MocaClient({ ...baseConfig, password: undefined as unknown as string })).toThrow(
      MocaArgumentError,
    );
  });

  it('rejects a non-finite session.maxAgeMinutes', () => {
    expect(() => new MocaClient({ ...baseConfig, session: { maxAgeMinutes: Number.NaN } })).toThrow(MocaArgumentError);
    expect(() => new MocaClient({ ...baseConfig, session: { maxAgeMinutes: Number.POSITIVE_INFINITY } })).toThrow(
      MocaArgumentError,
    );
  });

  it('rejects a non-positive or non-finite timeoutMs', () => {
    expect(() => new MocaClient({ ...baseConfig, timeoutMs: 0 })).toThrow(MocaArgumentError);
    expect(() => new MocaClient({ ...baseConfig, timeoutMs: -1 })).toThrow(MocaArgumentError);
    expect(() => new MocaClient({ ...baseConfig, timeoutMs: Number.NaN })).toThrow(MocaArgumentError);
  });

  it('rejects a timeoutMs beyond the 32-bit signed integer range', () => {
    expect(() => new MocaClient({ ...baseConfig, timeoutMs: 2_147_483_648 })).toThrow(MocaArgumentError);
    // The cap itself is still valid.
    expect(() => new MocaClient({ ...baseConfig, timeoutMs: 2_147_483_647 })).not.toThrow();
  });
});

describe('MocaClient additional environment and result coverage', () => {
  it('sends DEVCOD when device is set', async () => {
    const { moca, requests } = client(() => ORDERS, { device: 'DEV42' });
    await moca.exec('a');
    expect(requests[1]).toMatchObject({ env: { DEVCOD: 'DEV42' } });
  });

  it('sends exactly USR_ID (nothing else) in the login request env', async () => {
    const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : ORDERS));
    await new MocaClient({ ...baseConfig }, { transport: fake.transport }).exec('a');
    expect(fake.requests[0]!.env).toEqual({ USR_ID: 'JDOE' });
  });

  it('keeps message and columns for a 510 with format: full', async () => {
    const { moca } = client(() => mocaXml(510, { columns: [{ name: 'ordnum', type: 'S' }] }, 'No Data Found'));
    const result = await moca.exec('list orders', { format: 'full' });
    expect(result).toEqual({
      status: 510,
      message: 'No Data Found',
      columns: [{ name: 'ordnum', type: 'S' }],
      rows: [],
    });
  });

  it('logs in exactly twice for three concurrent calls that all hit a 523, and all succeed', async () => {
    // Fail each distinct command's first attempt only, so every one of the three concurrent
    // calls needs exactly one retry -- but since the retries share one single-flight login,
    // only two logins total should occur (one for the first attempts, one for the retries).
    const seen = new Set<string>();
    const fake = fakeMoca((r) => {
      if (r.query.startsWith('login user')) return loginOk();
      if (!seen.has(r.query)) {
        seen.add(r.query);
        return mocaXml(523, {}, 'Session expired');
      }
      return ORDERS;
    });
    const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    const results = await Promise.all([moca.exec('list a'), moca.exec('list b'), moca.exec('list c')]);
    expect(results).toEqual([
      [{ ordnum: 'A1', ordqty: 5, cancel_flg: false }],
      [{ ordnum: 'A1', ordqty: 5, cancel_flg: false }],
      [{ ordnum: 'A1', ordqty: 5, cancel_flg: false }],
    ]);
    expect(fake.requests.filter((r) => r.query.startsWith('login user'))).toHaveLength(2);
  });

  it('logout() still evicts the session when the server returns an error status, and rethrows', async () => {
    const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : mocaXml(1, {}, 'boom')));
    const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    await moca.exec('a').catch(() => undefined);
    await expect(moca.logout()).rejects.toBeInstanceOf(MocaCommandError);
    // The session was still evicted: the next call logs in again.
    await moca.exec('a').catch(() => undefined);
    expect(fake.requests.map((r) => r.query.split(' ')[0])).toEqual(['login', 'a', 'logout', 'login', 'a']);
  });
});
