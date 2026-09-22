import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import { MemorySessionStore, type SessionState } from './store.js';

function setup(maxAgeMs = 60_000) {
  const clock = { t: 1_000 };
  const now = () => clock.t;
  const store = new MemorySessionStore();
  let count = 0;
  const login = vi.fn(async (): Promise<SessionState> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    count += 1;
    return { key: `K${count}`, locale: 'US_ENGLISH', createdAt: now() };
  });
  const make = () => new SessionManager({ cacheKey: 'ck', store, maxAgeMs, login, now });
  return { clock, store, login, make };
}

describe('SessionManager', () => {
  it('logs in lazily once and caches in the store', async () => {
    const { make, login, store } = setup();
    const manager = make();
    expect(manager.current).toBeNull();
    expect((await manager.acquire()).key).toBe('K1');
    expect((await manager.acquire()).key).toBe('K1');
    expect(login).toHaveBeenCalledTimes(1);
    expect((await store.get('ck'))?.key).toBe('K1');
  });

  it('shares a cached session between managers on the same store', async () => {
    const { make, login } = setup();
    await make().acquire();
    expect((await make().acquire()).key).toBe('K1');
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('logs in again once the session is older than maxAge', async () => {
    const { make, clock, login } = setup();
    const manager = make();
    await manager.acquire();
    clock.t += 60_001;
    expect((await manager.acquire()).key).toBe('K2');
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('never expires with an infinite maxAge', async () => {
    const { make, clock, login } = setup(Number.POSITIVE_INFINITY);
    const manager = make();
    await manager.acquire();
    clock.t += 10 ** 12;
    await manager.acquire();
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent logins across managers', async () => {
    const { make, login } = setup();
    const managers = Array.from({ length: 4 }, make);
    const states = await Promise.all(Array.from({ length: 20 }, (_, i) => managers[i % 4]!.acquire()));
    expect(new Set(states.map((s) => s.key))).toEqual(new Set(['K1']));
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed login', async () => {
    const { make, login } = setup();
    login.mockRejectedValueOnce(new Error('bad password'));
    const manager = make();
    await expect(manager.acquire()).rejects.toThrow('bad password');
    expect((await manager.acquire()).key).toBe('K1');
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('invalidate only removes the stale session, not a newer one', async () => {
    const { make, store } = setup();
    const manager = make();
    const stale = await manager.acquire();
    await store.set('ck', { key: 'NEWER', locale: null, createdAt: 1_000 });
    await manager.invalidate(stale);
    expect(manager.current).toBeNull();
    expect((await store.get('ck'))?.key).toBe('NEWER');
    expect((await manager.acquire()).key).toBe('NEWER');
  });

  it('invalidate removes the matching session from the store', async () => {
    const { make, store } = setup();
    const manager = make();
    const state = await manager.acquire();
    await manager.invalidate(state);
    expect(await store.get('ck')).toBeUndefined();
  });

  it('adopt stores an externally obtained session; peek never logs in', async () => {
    const { make, login } = setup();
    const manager = make();
    expect(await manager.peek()).toBeNull();
    await manager.adopt({ key: 'EXT', locale: null, createdAt: 1_000 });
    expect((await manager.peek())?.key).toBe('EXT');
    expect((await make().acquire()).key).toBe('EXT');
    expect(login).not.toHaveBeenCalled();
  });
});
