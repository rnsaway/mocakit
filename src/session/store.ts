import { createHash } from 'node:crypto';

export interface SessionState {
  key: string;
  locale: string | null;
  createdAt: number;
}

/**
 * Pluggable session cache (e.g. file- or Redis-backed). Only the in-memory store ships.
 *
 * Cache keys (see `sessionCacheKey`) are an unsalted sha256 hash of the URL, username and
 * password. A persistent store such as Redis or a file should restrict read access to its
 * keys, or re-hash the key with a secret before using it, since anyone who can read a key
 * and knows (or guesses) the URL/username can brute-force short passwords offline.
 */
export interface SessionStore {
  get(cacheKey: string): Promise<SessionState | undefined>;
  set(cacheKey: string, state: SessionState): Promise<void>;
  delete(cacheKey: string): Promise<void>;
}

/**
 * States are stored by reference and are never evicted except when overwritten or explicitly
 * deleted on a stale lookup. That is acceptable for v1 (bounded by the number of distinct
 * credentials a process uses) but would need a TTL or LRU policy for long-lived, high-cardinality
 * use.
 */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionState>();

  async get(cacheKey: string): Promise<SessionState | undefined> {
    return this.#sessions.get(cacheKey);
  }

  async set(cacheKey: string, state: SessionState): Promise<void> {
    this.#sessions.set(cacheKey, state);
  }

  async delete(cacheKey: string): Promise<void> {
    this.#sessions.delete(cacheKey);
  }
}

/** Process-wide store shared by every client that has `session.reuse` enabled (the default). */
export const sharedSessionStore = new MemorySessionStore();

export function sessionCacheKey(url: string, username: string, password: string): string {
  return createHash('sha256').update(JSON.stringify([url, username, password])).digest('hex');
}
