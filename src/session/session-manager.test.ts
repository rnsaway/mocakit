import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import { MemorySessionStore, type SessionState, type SessionStore } from './store.js';

/** Wraps a store so a `get` reads the current value immediately but delivers it after a delay,
 * simulating network latency: the read reflects the state at call time, not at resolution time. */
class LatentStore implements SessionStore {
  constructor(
    private readonly inner: SessionStore,
    private readonly delayMs: number,
  ) {}

  async get(cacheKey: string): Promise<SessionState | undefined> {
    const value = await this.inner.get(cacheKey);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return value;
  }

  async set(cacheKey: string, state: SessionState): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    await this.inner.set(cacheKey, state);
  }

  async delete(cacheKey: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    await this.inner.delete(cacheKey);
  }
}

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

  it('a stale peek does not delete a session written concurrently by another manager', async () => {
    const inner = new MemorySessionStore();
    await inner.set('ck', { key: 'STALE', locale: null, createdAt: 0 });
    const store = new LatentStore(inner, 20);
    const now = () => 100_000;
    const manager = new SessionManager({ cacheKey: 'ck', store, maxAgeMs: 1_000, login: vi.fn(), now });

    // peek() reads the stale value at call time, but its resolution is delayed.
    const peeking = manager.peek();

    // Meanwhile another manager finishes a login and writes a fresh session directly.
    await inner.set('ck', { key: 'FRESH', locale: null, createdAt: 100_000 });

    expect(await peeking).toBeNull();
    // The stale peek must not have deleted the freshly-written entry.
    expect((await inner.get('ck'))?.key).toBe('FRESH');
  });

  it('double-checks the store for a fresh session before calling login', async () => {
    const now = () => 1_000;
    let getCallCount = 0;
    let resolveDoubleCheck: (value: SessionState | undefined) => void = () => undefined;
    const store: SessionStore = {
      get: vi.fn(async (): Promise<SessionState | undefined> => {
        getCallCount += 1;
        if (getCallCount === 1) return undefined; // peek(): nothing cached yet
        // singleFlightLogin's double-check read, resolved manually below.
        return new Promise<SessionState | undefined>((resolve) => {
          resolveDoubleCheck = resolve;
        });
      }),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const login = vi.fn(async (): Promise<SessionState> => ({ key: 'FROM_LOGIN', locale: null, createdAt: now() }));
    const manager = new SessionManager({ cacheKey: 'ck', store, maxAgeMs: 60_000, login, now });

    const acquiring = manager.acquire();
    // Let peek() and the start of singleFlightLogin run up to the double-check read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Simulate another process finishing a login concurrently.
    resolveDoubleCheck({ key: 'EXTERNAL', locale: null, createdAt: now() });

    expect((await acquiring).key).toBe('EXTERNAL');
    expect(login).not.toHaveBeenCalled();
  });

  it('single-flights across managers even with a store that delays get/set', async () => {
    const inner = new MemorySessionStore();
    const store = new LatentStore(inner, 20);
    const now = () => 1_000;
    let resolveLogin: (state: SessionState) => void = () => undefined;
    const login = vi.fn(
      () =>
        new Promise<SessionState>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    const managerA = new SessionManager({ cacheKey: 'ck', store, maxAgeMs: 60_000, login, now });
    const managerB = new SessionManager({ cacheKey: 'ck', store, maxAgeMs: 60_000, login, now });

    const acquiringA = managerA.acquire();
    const acquiringB = managerB.acquire();
    // Wait until login() has actually been invoked (peek + the pre-login double-check each add
    // a 20ms round trip through the store) before resolving it.
    await vi.waitFor(() => expect(login).toHaveBeenCalled());
    resolveLogin({ key: 'K1', locale: null, createdAt: now() });

    const [stateA, stateB] = await Promise.all([acquiringA, acquiringB]);
    expect(stateA.key).toBe('K1');
    expect(stateB.key).toBe('K1');
    expect(login).toHaveBeenCalledTimes(1);
  });
});
