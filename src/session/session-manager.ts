import type { SessionState, SessionStore } from './store.js';

export interface SessionManagerOptions {
  cacheKey: string;
  store: SessionStore;
  /** `Number.POSITIVE_INFINITY` disables age-based expiry. */
  maxAgeMs: number;
  login: () => Promise<SessionState>;
  now: () => number;
}

/** In-flight logins, per store and cache key, so concurrent callers share one login. */
const inFlight = new WeakMap<SessionStore, Map<string, Promise<SessionState>>>();

/**
 * Caches a MOCA session, checks its freshness, and single-flights logins.
 *
 * A login in flight is shared by every `SessionManager` using the same `store` and `cacheKey`
 * (see the module-level `inFlight` map), not just by this instance. Whichever client happens
 * to start that login runs it with its own settings (transport, timeout, credentials), so the
 * result other clients receive was produced under settings they did not choose.
 */
export class SessionManager {
  #current: SessionState | null = null;
  readonly #options: SessionManagerOptions;

  constructor(options: SessionManagerOptions) {
    this.#options = options;
  }

  get current(): SessionState | null {
    return this.#current;
  }

  isFresh(state: SessionState): boolean {
    return this.#options.now() - state.createdAt < this.#options.maxAgeMs;
  }

  /** Returns a fresh session, from memory, the store, or a (shared) login. */
  async acquire(): Promise<SessionState> {
    const fresh = await this.peek();
    if (fresh !== null) return fresh;
    this.#current = await this.#singleFlightLogin();
    return this.#current;
  }

  /**
   * Returns a fresh session if one is cached, without logging in.
   *
   * A stale entry is left in the store rather than deleted: this read may be looking at a
   * snapshot that is already out of date (another client can have written a fresh session to
   * the store while this call was in flight), and deleting on that basis could destroy a newer
   * session we never saw. The next successful login overwrites the stale entry instead.
   */
  async peek(): Promise<SessionState | null> {
    if (this.#current !== null && this.isFresh(this.#current)) return this.#current;
    this.#current = null;
    const { store, cacheKey } = this.#options;
    const cached = await store.get(cacheKey);
    if (cached === undefined || !this.isFresh(cached)) return null;
    this.#current = cached;
    return cached;
  }

  /** Stores a session obtained by an explicit login. */
  async adopt(state: SessionState): Promise<void> {
    this.#current = state;
    await this.#options.store.set(this.#options.cacheKey, state);
  }

  /** Drops `stale`, leaving any newer session another client stored in the meantime. */
  async invalidate(stale: SessionState): Promise<void> {
    if (this.#current?.key === stale.key) this.#current = null;
    const { store, cacheKey } = this.#options;
    const cached = await store.get(cacheKey);
    if (cached?.key === stale.key) await store.delete(cacheKey);
  }

  async #singleFlightLogin(): Promise<SessionState> {
    const { store, cacheKey, login } = this.#options;
    let pending = inFlight.get(store);
    if (pending === undefined) {
      pending = new Map();
      inFlight.set(store, pending);
    }
    const existing = pending.get(cacheKey);
    if (existing !== undefined) return existing;

    const promise = (async () => {
      // Re-check the store immediately before logging in: another process sharing this store
      // (with its own in-memory single-flight map) may have finished a login while we were
      // getting here, and there is no point paying for a second one.
      const recheck = await store.get(cacheKey);
      if (recheck !== undefined && this.isFresh(recheck)) return recheck;
      const state = await login();
      await store.set(cacheKey, state);
      return state;
    })();
    pending.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      if (pending.get(cacheKey) === promise) pending.delete(cacheKey);
    }
  }
}
