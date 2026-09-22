import { describe, expect, it } from 'vitest';
import { MemorySessionStore, sessionCacheKey } from './store.js';

describe('MemorySessionStore', () => {
  it('gets, sets and deletes', async () => {
    const store = new MemorySessionStore();
    const state = { key: 'K', locale: null, createdAt: 1 };
    expect(await store.get('a')).toBeUndefined();
    await store.set('a', state);
    expect(await store.get('a')).toBe(state);
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
  });
});

describe('sessionCacheKey', () => {
  it('is a stable sha256 hex that differs per credential and never contains the password', () => {
    const key = sessionCacheKey('https://m/service', 'JDOE', 'secret');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(sessionCacheKey('https://m/service', 'JDOE', 'secret'));
    expect(key).not.toBe(sessionCacheKey('https://m/service', 'JDOE', 'other'));
    expect(key).not.toContain('secret');
  });

  it('encodes fields unambiguously so a boundary shift does not collide', () => {
    const a = sessionCacheKey('u\np', 'q', 'x');
    const b = sessionCacheKey('u', 'p\nq', 'x');
    expect(a).not.toBe(b);
  });
});
