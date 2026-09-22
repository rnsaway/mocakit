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

  /** Returns a fresh session if one is cached, without logging in. Evicts stale entries. */
  async peek(): Promise<SessionState | null> {
    if (this.#current !== null && this.isFresh(this.#current)) return this.#current;
    this.#current = null;
    const { store, cacheKey } = this.#options;
    const cached = await store.get(cacheKey);
    if (cached === undefined) return null;
    if (!this.isFresh(cached)) {
      await store.delete(cacheKey);
      return null;
    }
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
