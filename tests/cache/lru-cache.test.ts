import { describe, expect, it, vi } from 'vitest';
import { MemoryLruCache } from '../../src/cache/lru-cache';

describe('MemoryLruCache', () => {
  it('throws error when maxSize is <= 0', () => {
    expect(() => new MemoryLruCache({ maxSize: 0 })).toThrow();
    expect(() => new MemoryLruCache({ maxSize: -5 })).toThrow();
  });

  it('stores and retrieves items correctly', () => {
    const cache = new MemoryLruCache<string, number>({ maxSize: 3 });
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.size).toBe(2);
    expect(cache.capacity).toBe(3);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBeUndefined();
  });

  it('evicts least recently used items upon reaching capacity', () => {
    const cache = new MemoryLruCache<string, string>({ maxSize: 3 });
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');
    cache.set('k3', 'v3');

    // Access k1 so k2 becomes the oldest (LRU)
    cache.get('k1');

    // Add k4 -> should evict k2
    cache.set('k4', 'v4');

    expect(cache.size).toBe(3);
    expect(cache.has('k2')).toBe(false);
    expect(cache.get('k2')).toBeUndefined();
    expect(cache.get('k1')).toBe('v1');
    expect(cache.get('k3')).toBe('v3');
    expect(cache.get('k4')).toBe('v4');
  });

  it('updates existing keys without increasing size or evicting prematurely', () => {
    const cache = new MemoryLruCache<string, number>({ maxSize: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(10);

    // 'b' is now LRU, adding 'c' should evict 'b'
    cache.set('c', 3);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
  });

  it('handles item expiration with TTL', () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryLruCache<string, string>({ maxSize: 5, defaultTtlMs: 1000 });
      cache.set('temp', 'val');
      cache.set('custom', 'val2', 5000);

      expect(cache.get('temp')).toBe('val');
      expect(cache.has('temp')).toBe(true);

      // Advance time by 1500ms
      vi.advanceTimersByTime(1500);

      expect(cache.has('temp')).toBe(false);
      expect(cache.get('temp')).toBeUndefined();
      expect(cache.has('custom')).toBe(true);
      expect(cache.get('custom')).toBe('val2');

      // Advance by another 4000ms
      vi.advanceTimersByTime(4000);
      expect(cache.has('custom')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes and clears items properly', () => {
    const cache = new MemoryLruCache<string, number>({ maxSize: 5 });
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('nonexistent')).toBe(false);
    expect(cache.size).toBe(1);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('b')).toBe(false);
  });

  it('prunes expired items correctly', () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryLruCache<string, number>({ maxSize: 5 });
      cache.set('a', 1, 1000);
      cache.set('b', 2, 2000);
      cache.set('c', 3); // no expiration

      vi.advanceTimersByTime(1500);

      const pruned = cache.pruneExpired();
      expect(pruned).toBe(1);
      expect(cache.size).toBe(2);
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(true);
      expect(cache.has('c')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
