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
import { MOCA_STATUS, MocaClient } from './client.js';
import { defineCommands } from './commands.js';

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
      autocommit: true,
      env: { USR_ID: 'JDOE' },
    });
    expect(requests[1]).toMatchObject({
      query: 'list orders',
      autocommit: true,
      env: { USR_ID: 'JDOE', SESSION_KEY: 'KEY1', WH_ID: 'WMD1', LOCALE_ID: 'US_ENGLISH' },
    });
  });

  it('sends login user with autocommit=true, so the login never leaves a transaction open on a pooled connection', async () => {
    const fake = fakeMoca(() => loginOk());
    const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    await moca.login();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.query.startsWith('login user')).toBe(true);
    expect(fake.requests[0]!.autocommit).toBe(true);
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
    const { moca, requests } = client(() => ORDERS, { defaults: { convert: false } });
    const rows = await moca.exec('x', { env: { WH_ID: 'OVR' } });
    expect(rows).toEqual([{ ordnum: 'A1', ordqty: '5', cancel_flg: '0' }]);
    expect(requests[1]).toMatchObject({ autocommit: true, env: { WH_ID: 'OVR' } });
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
    await expect(moca.login()).resolves.toEqual({ usr_id: 'JDOE', locale_id: 'US_ENGLISH', addon_id: 'WM', cust_lvl: 0 });
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

describe('MOCA_STATUS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(MOCA_STATUS)).toBe(true);
  });
});

describe('MocaClient final-review fixes', () => {
  it('exec() rejects extraArgs without contacting the server', async () => {
    const { moca, requests } = client(() => ORDERS);
    const error = (await moca.exec('delete orders', { extraArgs: { ordnum: 'A1' } }).catch((e: unknown) => e)) as MocaArgumentError;
    expect(error).toBeInstanceOf(MocaArgumentError);
    expect(error.message).toBe('extraArgs is not supported by exec(); put arguments in the MOCA text or use a generated command');
    expect(requests).toHaveLength(0);
  });

  it('exec() rejects extraArgs even when every value is null/undefined', async () => {
    const { moca } = client(() => ORDERS);
    await expect(moca.exec('x', { extraArgs: { a: undefined } })).rejects.toBeInstanceOf(MocaArgumentError);
  });

  it('exec() accepts an empty extraArgs object', async () => {
    const { moca } = client(() => ORDERS);
    await expect(moca.exec('list orders', { extraArgs: {} })).resolves.toHaveLength(1);
  });

  it('login() omits session_key (any casing) from the returned row', async () => {
    const fake = fakeMoca(() =>
      mocaXml(0, {
        columns: [{ name: 'usr_id' }, { name: 'locale_id' }, { name: 'addon_id' }, { name: 'cust_lvl', type: 'I' }, { name: 'SESSION_KEY' }],
        rows: [['JDOE', 'US_ENGLISH', 'WM', '0', 'KEY1']],
      }),
    );
    const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    const row = await moca.login();
    expect(row).toEqual({ usr_id: 'JDOE', locale_id: 'US_ENGLISH', addon_id: 'WM', cust_lvl: 0 });
    expect(JSON.stringify(row)).not.toContain('KEY1');
  });

  it('login() omits the session key when it is found by column position under another name', async () => {
    const fake = fakeMoca(() =>
      mocaXml(0, {
        columns: [{ name: 'usr_id' }, { name: 'locale_id' }, { name: 'addon_id' }, { name: 'cust_lvl', type: 'I' }, { name: 'sess' }],
        rows: [['JDOE', 'US_ENGLISH', 'WM', '0', 'KEY9']],
      }),
    );
    const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    const row = await moca.login();
    expect(row).toEqual({ usr_id: 'JDOE', locale_id: 'US_ENGLISH', addon_id: 'WM', cust_lvl: 0 });
    expect(JSON.stringify(row)).not.toContain('KEY9');
  });

  it('login() omits a numeric-looking session key even when its column converts to a number', async () => {
    const fake = fakeMoca(() =>
      mocaXml(0, {
        columns: [{ name: 'usr_id' }, { name: 'locale_id' }, { name: 'addon_id' }, { name: 'cust_lvl', type: 'I' }, { name: 'sess', type: 'I' }],
        rows: [['JDOE', 'US_ENGLISH', 'WM', '0', '12345']],
      }),
    );
    const moca = new MocaClient({ ...baseConfig }, { transport: fake.transport });
    const row = await moca.login();
    expect(row).toEqual({ usr_id: 'JDOE', locale_id: 'US_ENGLISH', addon_id: 'WM', cust_lvl: 0 });
  });

  it('login() honours defaults.convert', async () => {
    const { moca } = client(() => ORDERS, { defaults: { convert: false } });
    const row = await moca.login();
    expect(row).toEqual({ usr_id: 'JDOE', locale_id: 'US_ENGLISH', addon_id: 'WM', cust_lvl: '0' });
  });

  it('rejects session.store combined with reuse: false', () => {
    expect(() => new MocaClient({ ...baseConfig, session: { reuse: false, store: new MemorySessionStore() } })).toThrow(
      MocaArgumentError,
    );
  });

  it.each([0, -5])('maxAgeMinutes %d reuses a session until the server rejects it', async (maxAgeMinutes) => {
    const clock = { t: 0 };
    const { moca, requests } = client(() => ORDERS, { session: { reuse: false, maxAgeMinutes } }, () => clock.t);
    await moca.exec('a');
    clock.t = 365 * 24 * 60 * 60_000;
    await moca.exec('b');
    expect(requests.map((r) => r.query.split(' ')[0])).toEqual(['login', 'a', 'b']);
    expect(moca.session.active).toBe(true);
  });
});

const AUTOCOMMIT_REMOVED =
  'The autocommit option was removed in mocakit 0.2.0: autocommit=false leaves the transaction open on a pooled database connection. Use { dryRun: true } to roll back, or moca.batch() for several commands in one transaction.';

const DRY_RUN = (text: string): string => `try { ${text} } finally { try { [rollback] } catch (@?) { noop } }`;

describe('MocaClient autocommit (removed in 0.2.0)', () => {
  it('sends every exec and call with autocommit=true', async () => {
    const { moca, requests } = client(() => ORDERS);
    await moca.exec('x');
    await moca.call(['list orders', []]);
    expect(requests.map((r) => r.autocommit)).toEqual([true, true, true]);
  });

  it("rejects autocommit in a call's options, before contacting the server", async () => {
    const { moca, requests } = client(() => ORDERS);
    for (const value of [false, true, undefined]) {
      const opts = { autocommit: value } as unknown as object;
      const error = (await moca.exec('x', opts).catch((e: unknown) => e)) as MocaArgumentError;
      expect(error).toBeInstanceOf(MocaArgumentError);
      expect(error.message).toBe(AUTOCOMMIT_REMOVED);
      await expect(moca.call(['list orders', []], {}, opts)).rejects.toThrow(AUTOCOMMIT_REMOVED);
    }
    expect(requests).toHaveLength(0);
  });

  it('rejects autocommit in config.defaults', () => {
    const defaults = { autocommit: false } as unknown as MocaConfig['defaults'];
    expect(() => new MocaClient({ ...baseConfig, defaults })).toThrow(MocaArgumentError);
    expect(() => new MocaClient({ ...baseConfig, defaults })).toThrow(AUTOCOMMIT_REMOVED);
  });

  it('ignores an inherited (non-own) autocommit property', async () => {
    const { moca, requests } = client(() => ORDERS);
    await moca.exec('x', Object.create({ autocommit: false }) as object);
    expect(requests[1]!.autocommit).toBe(true);
  });
});

describe('MocaClient dryRun', () => {
  it('wraps exec text in try/finally rollback, still sent with autocommit=true', async () => {
    const { moca, requests } = client(() => ORDERS);
    const rows = await moca.exec('create widget where id = 1', { dryRun: true });
    expect(rows).toEqual([{ ordnum: 'A1', ordqty: 5, cancel_flg: false }]);
    expect(requests[1]).toMatchObject({
      query: 'try { create widget where id = 1 } finally { try { [rollback] } catch (@?) { noop } }',
      autocommit: true,
    });
  });

  it('wraps the rendered command for call, and passes the full result through', async () => {
    const { moca, requests } = client(() => ORDERS);
    const full = await moca.call(['list orders', [['wh_id', 'S', 1]]], { wh_id: 'W' }, { dryRun: true, format: 'full' });
    expect(full).toMatchObject({ status: 0, rows: [{ ordnum: 'A1' }] });
    expect(requests[1]!.query).toBe(DRY_RUN(`list orders where wh_id = 'W'`));
    expect(requests[1]!.autocommit).toBe(true);
  });

  it('dryRun: false behaves like no dryRun', async () => {
    const { moca, requests } = client(() => ORDERS);
    await moca.exec('x', { dryRun: false });
    expect(requests[1]).toMatchObject({ query: 'x', autocommit: true });
  });

  it('reports the wrapped (and redacted) text as error.command', async () => {
    const { moca } = client(() => mocaXml(99, {}, 'boom'));
    const error = (await moca.exec("change pw where usr_pswd = 'secret'", { dryRun: true }).catch((e: unknown) => e)) as MocaCommandError;
    expect(error).toBeInstanceOf(MocaCommandError);
    expect(error.command).toBe(DRY_RUN("change pw where usr_pswd = '***'"));
  });

  it('never wraps the login', async () => {
    const { moca, requests } = client(() => ORDERS);
    await moca.exec('x', { dryRun: true });
    expect(requests[0]!.query.startsWith('login user')).toBe(true);
    expect(requests[0]!.autocommit).toBe(true);
  });
});

describe('MocaClient.batch', () => {
  class Sub extends MocaClient {}
  defineCommands(Sub.prototype, {
    listOrders: ['list orders', [['wh_id', 'S', 1], ['ordqty', 'I', 0]]],
    createWidget: ['create widget', [['widget_id', 'S', 0]]],
  });
  type Builder = Record<string, (args?: object) => unknown> & { raw(text: string): unknown };
  type Batch = (build: (b: Builder) => readonly unknown[], opts?: object) => Promise<unknown>;

  function batchClient(handler: (r: FakeRequest) => string = () => ORDERS) {
    const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : handler(r)));
    const moca = new Sub({ ...baseConfig }, { transport: fake.transport });
    const batch = (moca.batch as unknown as Batch).bind(moca);
    return { moca, batch, requests: fake.requests };
  }

  it('joins the steps in braces and sends them once with autocommit=true', async () => {
    const { batch, requests } = batchClient();
    await batch((b) => [
      b.createWidget!({ widget_id: 'W1' }),
      b.raw('[select 1 a] | publish data where x = @a'),
      b.listOrders!({ wh_id: 'W' }),
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      query: "{ create widget where widget_id = 'W1' } ;\n{ [select 1 a] | publish data where x = @a } ;\n{ list orders where wh_id = 'W' }",
      autocommit: true,
    });
  });

  it("returns the last step's rows (what MOCA returns), or the full result", async () => {
    const { batch } = batchClient();
    await expect(batch((b) => [b.raw('a'), b.raw('b')])).resolves.toEqual([{ ordnum: 'A1', ordqty: 5, cancel_flg: false }]);
    await expect(batch((b) => [b.raw('a')], { format: 'full', convert: false })).resolves.toMatchObject({
      status: 0,
      rows: [{ ordnum: 'A1', ordqty: '5' }],
    });
  });

  it('accepts an optional-args command with no arguments', async () => {
    const { batch, requests } = batchClient();
    await batch((b) => [b.createWidget!()]);
    expect(requests[1]!.query).toBe('{ create widget }');
  });

  it('wraps the whole batch for dryRun, still sent with autocommit=true', async () => {
    const { batch, requests } = batchClient();
    await batch((b) => [b.raw('a'), b.raw('b')], { dryRun: true });
    expect(requests[1]).toMatchObject({ query: DRY_RUN('{ a } ;\n{ b }'), autocommit: true });
  });

  it('exposes only generated commands and raw on the builder', async () => {
    const { batch } = batchClient();
    await batch((b) => {
      expect(b.exec).toBeUndefined();
      expect(b.login).toBeUndefined();
      expect(b.call).toBeUndefined();
      expect(b.batch).toBeUndefined();
      expect(b.session).toBeUndefined();
      expect(b.nope).toBeUndefined();
      expect(typeof b.listOrders).toBe('function');
      return [b.raw('x')];
    });
  });

  it('validates each step while it is built, and sends nothing when one fails', async () => {
    const { batch, requests } = batchClient();
    const error = (await batch((b) => [b.raw('a'), b.listOrders!({})]).catch((e: unknown) => e)) as MocaArgumentError;
    expect(error).toBeInstanceOf(MocaArgumentError);
    expect(error.message).toBe('Missing required argument "wh_id" for "list orders"');
    expect(error.command).toBe('list orders');
    await expect(batch((b) => [b.listOrders!({ wh_id: 'W', bogus: 1 })])).rejects.toBeInstanceOf(MocaArgumentError);
    expect(requests).toHaveLength(0);
  });

  it('rejects an empty step list', async () => {
    const { batch, requests } = batchClient();
    await expect(batch(() => [])).rejects.toBeInstanceOf(MocaArgumentError);
    expect(requests).toHaveLength(0);
  });

  it('rejects anything that is not a BatchStep, including a look-alike object', async () => {
    const { batch, requests } = batchClient();
    for (const bad of [{ moca: 'x' }, 'x', null, undefined, Object.freeze({ moca: 'x' })]) {
      const error = await batch((b) => [b.raw('a'), bad]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MocaArgumentError);
    }
    await expect(batch(() => 'x' as unknown as unknown[])).rejects.toBeInstanceOf(MocaArgumentError);
    expect(requests).toHaveLength(0);
  });

  it('rejects a non-string raw step', async () => {
    const { batch } = batchClient();
    await expect(batch((b) => [b.raw(42 as unknown as string)])).rejects.toBeInstanceOf(MocaArgumentError);
  });

  it('rejects autocommit and extraArgs in the batch options', async () => {
    const { batch, requests } = batchClient();
    await expect(batch((b) => [b.raw('a')], { autocommit: true })).rejects.toThrow(AUTOCOMMIT_REMOVED);
    await expect(batch((b) => [b.raw('a')], { extraArgs: { a: 1 } })).rejects.toBeInstanceOf(MocaArgumentError);
    expect(requests).toHaveLength(0);
  });

  it('throws a MocaCommandError whose command is the full, redacted batch text', async () => {
    const { batch } = batchClient(() => mocaXml(99, {}, 'boom'));
    const error = (await batch((b) => [b.raw("set pw where usr_pswd = 'secret'"), b.raw('b')]).catch(
      (e: unknown) => e,
    )) as MocaCommandError;
    expect(error).toBeInstanceOf(MocaCommandError);
    expect(error.status).toBe(99);
    expect(error.command).toBe("{ set pw where usr_pswd = '***' } ;\n{ b }");
  });

  it('works on a plain MocaClient with raw steps only', async () => {
    const { moca, requests } = client(() => ORDERS);
    await moca.batch((b) => [b.raw('a'), b.raw('b')]);
    expect(requests[1]!.query).toBe('{ a } ;\n{ b }');
  });
});

describe('MocaClient hardening (0.2.0 review)', () => {
  class Sub extends MocaClient {}
  defineCommands(Sub.prototype, {
    listOrders: ['list orders', [['wh_id', 'S', 1]]],
    createWidget: ['create widget', [['widget_id', 'S', 0]]],
  });
  type Builder = Record<string, (...args: unknown[]) => unknown> & { raw(...args: unknown[]): unknown };
  type Batch = (build: (b: Builder) => unknown, opts?: unknown) => Promise<unknown>;

  function batchClient(handler: (r: FakeRequest) => string = () => ORDERS, ctor: typeof MocaClient = Sub) {
    const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : handler(r)));
    const moca = new ctor({ ...baseConfig }, { transport: fake.transport });
    const batch = (moca.batch as unknown as Batch).bind(moca);
    return { moca, batch, requests: fake.requests };
  }

  it('never sends autocommit=false: login, exec, call, dryRun, batch, dryRun batch and logout', async () => {
    const { moca, batch, requests } = batchClient();
    await moca.exec('x');
    await moca.exec('x', { dryRun: true });
    await moca.call(['list orders', []], {}, { dryRun: true });
    await batch((b) => [b.raw('a')]);
    await batch((b) => [b.raw('a')], { dryRun: true });
    await moca.logout();
    expect(requests.length).toBe(7);
    expect(requests.every((r) => r.autocommit)).toBe(true);
  });

  describe('batch and status 510 (MOCA rolls the whole request back)', () => {
    const noRows = () => mocaXml(510, {}, 'No Data Found');

    it('throws a MocaCommandError instead of returning [] when a step finds no rows', async () => {
      const { batch } = batchClient(noRows);
      const error = (await batch((b) => [b.raw('a'), b.raw('b')]).catch((e: unknown) => e)) as MocaCommandError;
      expect(error).toBeInstanceOf(MocaCommandError);
      expect(error.status).toBe(510);
      expect(error.serverMessage).toBe('No Data Found');
      expect(error.message).toBe(
        'A batch step returned no rows (status 510), so MOCA rolled back the whole batch: No Data Found',
      );
      expect(error.command).toBe('{ a } ;\n{ b }');
    });

    it('throws for format: full and for a dryRun batch too', async () => {
      const { batch } = batchClient(noRows);
      await expect(batch((b) => [b.raw('a')], { format: 'full' })).rejects.toSatisfy((e) => isMocaStatus(e, 510));
      await expect(batch((b) => [b.raw('a')], { dryRun: true })).rejects.toSatisfy((e) => isMocaStatus(e, 510));
    });

    it('rejects noRowsIsError in the batch options (not settable)', async () => {
      const { batch, requests } = batchClient();
      for (const value of [true, false, undefined]) {
        const error = (await batch((b) => [b.raw('a')], { noRowsIsError: value }).catch((e: unknown) => e)) as MocaArgumentError;
        expect(error).toBeInstanceOf(MocaArgumentError);
        expect(error.message).toMatch(/noRowsIsError is not supported by batch\(\)/);
      }
      expect(requests).toHaveLength(0);
    });

    it('ignores defaults.noRowsIsError: false for a batch', async () => {
      const fake = fakeMoca((r) => (r.query.startsWith('login user') ? loginOk() : noRows()));
      const moca = new MocaClient({ ...baseConfig, defaults: { noRowsIsError: false } }, { transport: fake.transport });
      await expect(moca.batch((b) => [b.raw('a')])).rejects.toSatisfy((e) => isMocaStatus(e, 510));
    });

    it('exec still returns [] for 510', async () => {
      const { moca } = batchClient(noRows);
      await expect(moca.exec('a')).resolves.toEqual([]);
    });
  });

  describe('dryRun validation', () => {
    it('rejects defaults.dryRun in the constructor', () => {
      for (const value of [true, false, undefined]) {
        const defaults = { dryRun: value } as unknown as MocaConfig['defaults'];
        expect(() => new MocaClient({ ...baseConfig, defaults })).toThrow(MocaArgumentError);
        expect(() => new MocaClient({ ...baseConfig, defaults })).toThrow(/dryRun cannot be a client default/);
      }
    });

    it('rejects a non-boolean dryRun in exec, call and batch, before contacting the server', async () => {
      const { moca, batch, requests } = batchClient();
      for (const value of ['yes', 1, null, {}]) {
        const opts = { dryRun: value } as unknown as object;
        await expect(moca.exec('x', opts)).rejects.toThrow('dryRun must be a boolean');
        await expect(moca.call(['list orders', []], {}, opts)).rejects.toThrow('dryRun must be a boolean');
        await expect(batch((b) => [b.raw('a')], opts)).rejects.toThrow('dryRun must be a boolean');
      }
      expect(requests).toHaveLength(0);
    });

    it('accepts dryRun: undefined as absent', async () => {
      const { moca, requests } = batchClient();
      await moca.exec('x', { dryRun: undefined });
      expect(requests[1]!.query).toBe('x');
    });

    it('rejects [commit] in dryRun text for exec and batch (including raw steps), without sending', async () => {
      const { moca, batch, requests } = batchClient();
      for (const text of ['[commit]', 'a ; [ COMMIT ]', 'x | [commit work]']) {
        const error = (await moca.exec(text, { dryRun: true }).catch((e: unknown) => e)) as MocaArgumentError;
        expect(error).toBeInstanceOf(MocaArgumentError);
        expect(error.message).toMatch(/\[commit\] would defeat dryRun/);
        await expect(batch((b) => [b.raw('a'), b.raw(text)], { dryRun: true })).rejects.toThrow(/\[commit\] would defeat dryRun/);
      }
      expect(requests).toHaveLength(0);
      // Not a commit statement, and no dryRun: both are sent.
      await moca.exec('[select commitment from t]', { dryRun: true });
      await moca.exec('[commit]');
      expect(requests.map((r) => r.query.startsWith('login') ? 'login' : r.query)).toEqual([
        'login',
        DRY_RUN('[select commitment from t]'),
        '[commit]',
      ]);
    });
  });

  describe('step factories', () => {
    it('reject a second argument: options go on batch()', async () => {
      const { batch, requests } = batchClient();
      for (const second of [{ format: 'full' }, undefined, {}]) {
        const error = (await batch((b) => [b.listOrders!({ wh_id: 'W' }, second)]).catch((e: unknown) => e)) as MocaArgumentError;
        expect(error).toBeInstanceOf(MocaArgumentError);
        expect(error.message).toBe(
          'Batch step "list orders" takes only its arguments; pass options (format, dryRun, …) to batch() itself',
        );
      }
      await expect(batch((b) => [b.raw('a', {})])).rejects.toThrow(/b\.raw\(\) takes only MOCA text/);
      expect(requests).toHaveLength(0);
    });

    it('b.raw rejects empty and whitespace-only text', async () => {
      const { batch } = batchClient();
      for (const text of ['', '   ', '\n\t ']) {
        await expect(batch((b) => [b.raw(text)])).rejects.toThrow('b.raw() needs non-empty MOCA text');
      }
    });
  });

  describe('overridden commands', () => {
    it('uses the original spec found up the prototype chain; the override never runs in a batch', async () => {
      let overrideRan = 0;
      class MethodOverride extends Sub {
        listOrders(args: object, opts?: object): Promise<unknown> {
          overrideRan++;
          return (Sub.prototype as unknown as Record<string, (a: object, o?: object) => Promise<unknown>>).listOrders!.call(this, args, opts);
        }
      }
      class FieldOverride extends Sub {
        createWidget = (): Promise<unknown> => {
          overrideRan++;
          return Promise.resolve([]);
        };
      }
      for (const ctor of [MethodOverride, FieldOverride] as unknown as Array<typeof MocaClient>) {
        const { batch, requests } = batchClient(() => ORDERS, ctor);
        await batch((b) => [b.listOrders!({ wh_id: 'W' }), b.createWidget!({ widget_id: 'X' })]);
        expect(requests[1]!.query).toBe("{ list orders where wh_id = 'W' } ;\n{ create widget where widget_id = 'X' }");
      }
      expect(overrideRan).toBe(0);
    });

    it('still exposes nothing for client members and unknown names', async () => {
      const { batch } = batchClient();
      await batch((b) => {
        expect([b.exec, b.call, b.batch, b.login, b.toString, b.constructor, b.nope]).toEqual(Array(7).fill(undefined));
        return [b.raw('x')];
      });
    });
  });

  describe('null options and async builders', () => {
    it('treats null options like undefined in exec, call and batch', async () => {
      const { moca, batch, requests } = batchClient();
      await expect(moca.exec('x', null as unknown as undefined)).resolves.toHaveLength(1);
      await expect(moca.call(['list orders', []], undefined, null as unknown as undefined)).resolves.toHaveLength(1);
      await expect(batch((b) => [b.raw('a')], null)).resolves.toHaveLength(1);
      expect(requests.map((r) => r.autocommit)).toEqual([true, true, true, true]);
    });

    it('rejects an async build callback with a specific error, and sends nothing', async () => {
      const { batch, requests } = batchClient();
      const error = (await batch(async (b) => [b.raw('a')]).catch((e: unknown) => e)) as MocaArgumentError;
      expect(error).toBeInstanceOf(MocaArgumentError);
      expect(error.message).toMatch(/^the batch builder must return steps synchronously/);
      // A rejecting async builder must not surface as an unhandled rejection either.
      await expect(batch(async () => Promise.reject(new Error('boom')))).rejects.toThrow(/synchronously/);
      expect(requests).toHaveLength(0);
    });
  });
});
