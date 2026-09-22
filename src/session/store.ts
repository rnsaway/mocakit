import { createHash } from 'node:crypto';

export interface SessionState {
  key: string;
  locale: string | null;
  createdAt: number;
}

/** Pluggable session cache (e.g. file- or Redis-backed). Only the in-memory store ships. */
export interface SessionStore {
  get(cacheKey: string): Promise<SessionState | undefined>;
  set(cacheKey: string, state: SessionState): Promise<void>;
  delete(cacheKey: string): Promise<void>;
}

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
  return createHash('sha256').update([url, username, password].join('\n')).digest('hex');
}
