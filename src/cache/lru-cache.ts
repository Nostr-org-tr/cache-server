interface CacheEntry<V> {
  value: V;
  expiresAt: number | null;
}

export interface LruCacheOptions {
  maxSize: number;
  defaultTtlMs?: number;
}

/**
 * High-performance, zero-dependency in-memory LRU cache with TTL support.
 * Utilizes JavaScript Map insertion-order semantics for O(1) reads, updates, and evictions.
 */
export class MemoryLruCache<K, V> {
  private readonly maxSize: number;
  private readonly defaultTtlMs: number | null;
  private readonly cache: Map<K, CacheEntry<V>>;

  constructor(options: LruCacheOptions) {
    if (options.maxSize <= 0) {
      throw new Error('MemoryLruCache maxSize must be greater than 0');
    }
    this.maxSize = options.maxSize;
    this.defaultTtlMs = options.defaultTtlMs && options.defaultTtlMs > 0 ? options.defaultTtlMs : null;
    this.cache = new Map<K, CacheEntry<V>>();
  }

  /**
   * Returns current number of entries in the cache.
   */
  public get size(): number {
    return this.cache.size;
  }

  /**
   * Returns maximum capacity of the cache.
   */
  public get capacity(): number {
    return this.maxSize;
  }

  /**
   * Retrieves an entry by key.
   * If expired, removes it and returns undefined.
   * If found and valid, moves key to MRU position.
   */
  public get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    const now = Date.now();
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      this.cache.delete(key);
      return undefined;
    }

    // Refresh LRU ordering by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Checks if a valid, unexpired entry exists for the given key.
   */
  public has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) {
      return false;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Stores a value in the cache with optional custom TTL in milliseconds.
   * If capacity is exceeded, the least recently used item is evicted.
   */
  public set(key: K, value: V, ttlMs?: number): this {
    const effectiveTtl = ttlMs !== undefined ? ttlMs : this.defaultTtlMs;
    const expiresAt = effectiveTtl !== null && effectiveTtl > 0 ? Date.now() + effectiveTtl : null;

    // If key exists, delete it first to ensure new insertion is at MRU end
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first item in Map iteration)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { value, expiresAt });
    return this;
  }

  /**
   * Removes a specific key from the cache.
   */
  public delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clears all entries from the cache.
   */
  public clear(): void {
    this.cache.clear();
  }

  /**
   * Removes all expired entries and returns count of evicted items.
   */
  public pruneExpired(): number {
    const now = Date.now();
    let evictedCount = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.cache.delete(key);
        evictedCount++;
      }
    }

    return evictedCount;
  }
}
