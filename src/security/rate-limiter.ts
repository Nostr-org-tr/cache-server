/**
 * Rate Limiting Subsystem for cache.nostr.org.tr
 *
 * Provides in-memory sliding window and token bucket rate limiters
 * for IP connection throttling, message throughput limiting, and pubkey write protection.
 */

export interface RateLimitResult {
  /** Whether the request is allowed or rate-limited */
  allowed: boolean;
  /** Current count or consumed tokens in active window */
  current: number;
  /** Maximum capacity or threshold */
  limit: number;
  /** Milliseconds until full reset or next token replenishment */
  retryAfterMs: number;
}

export interface TokenBucketOptions {
  /** Maximum number of tokens the bucket can hold (burst capacity) */
  capacity: number;
  /** Number of tokens refilled per second */
  refillRate: number;
  /** Initial token count (defaults to capacity) */
  initialTokens?: number;
}

/**
 * Token Bucket Rate Limiter
 *
 * Ideal for smooth traffic shaping with burst tolerance.
 */
export class TokenBucketLimiter {
  private capacity: number;
  private refillRate: number;
  private tokens: number;
  private lastRefill: number;

  constructor(options: TokenBucketOptions) {
    if (options.capacity <= 0) {
      throw new Error('TokenBucket capacity must be positive');
    }
    if (options.refillRate <= 0) {
      throw new Error('TokenBucket refillRate must be positive');
    }

    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.tokens = options.initialTokens ?? options.capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Refills tokens based on elapsed time since last check.
   */
  private refill(now: number = Date.now()): void {
    const elapsedMs = Math.max(0, now - this.lastRefill);
    const addedTokens = (elapsedMs / 1000) * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + addedTokens);
    this.lastRefill = now;
  }

  /**
   * Attempts to consume tokens.
   */
  consume(tokens: number = 1, now: number = Date.now()): RateLimitResult {
    this.refill(now);

    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return {
        allowed: true,
        current: Math.floor(this.tokens),
        limit: this.capacity,
        retryAfterMs: 0,
      };
    }

    const deficit = tokens - this.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillRate) * 1000);

    return {
      allowed: false,
      current: Math.floor(this.tokens),
      limit: this.capacity,
      retryAfterMs,
    };
  }

  /**
   * Current number of available tokens.
   */
  getAvailableTokens(now: number = Date.now()): number {
    this.refill(now);
    return this.tokens;
  }

  /**
   * Resets the bucket to full capacity.
   */
  reset(now: number = Date.now()): void {
    this.tokens = this.capacity;
    this.lastRefill = now;
  }
}

export interface SlidingWindowOptions {
  /** Window duration in milliseconds */
  windowMs: number;
  /** Maximum number of allowed requests per window */
  maxRequests: number;
  /** Optional max entries to store before triggering GC */
  maxEntries?: number;
}

interface WindowEntry {
  timestamps: number[];
  lastAccess: number;
}

/**
 * Sliding Window Rate Limiter (keyed)
 *
 * Tracks request timestamps per key within a sliding time window.
 * Provides automatic garbage collection of expired keys.
 */
export class SlidingWindowLimiter {
  private windowMs: number;
  private maxRequests: number;
  private maxEntries: number;
  private entries: Map<string, WindowEntry>;
  private lastCleanup: number;

  constructor(options: SlidingWindowOptions) {
    if (options.windowMs <= 0) {
      throw new Error('SlidingWindow windowMs must be positive');
    }
    if (options.maxRequests <= 0) {
      throw new Error('SlidingWindow maxRequests must be positive');
    }

    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;
    this.maxEntries = options.maxEntries ?? 10000;
    this.entries = new Map<string, WindowEntry>();
    this.lastCleanup = Date.now();
  }

  /**
   * Checks if a request for the given key is allowed, and records the request if permitted.
   */
  check(key: string, now: number = Date.now()): RateLimitResult {
    this.periodicCleanup(now);

    const cutoff = now - this.windowMs;
    let entry = this.entries.get(key);

    if (!entry) {
      entry = { timestamps: [now], lastAccess: now };
      this.entries.set(key, entry);
      return {
        allowed: true,
        current: 1,
        limit: this.maxRequests,
        retryAfterMs: 0,
      };
    }

    entry.lastAccess = now;

    // Filter out timestamps outside the sliding window
    entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);

    if (entry.timestamps.length >= this.maxRequests) {
      const oldestInWindow = entry.timestamps[0] ?? now;
      const retryAfterMs = Math.max(1, oldestInWindow + this.windowMs - now);

      return {
        allowed: false,
        current: entry.timestamps.length,
        limit: this.maxRequests,
        retryAfterMs,
      };
    }

    entry.timestamps.push(now);

    return {
      allowed: true,
      current: entry.timestamps.length,
      limit: this.maxRequests,
      retryAfterMs: 0,
    };
  }

  /**
   * Manually resets a specific key.
   */
  resetKey(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Clears all tracked keys.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Number of keys currently tracked.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Cleans up stale entries whose timestamps are all expired.
   */
  cleanup(now: number = Date.now()): number {
    const cutoff = now - this.windowMs;
    let evictedCount = 0;

    for (const [key, entry] of this.entries.entries()) {
      if (entry.lastAccess < cutoff) {
        this.entries.delete(key);
        evictedCount++;
      } else {
        entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);
        if (entry.timestamps.length === 0) {
          this.entries.delete(key);
          evictedCount++;
        }
      }
    }

    this.lastCleanup = now;
    return evictedCount;
  }

  private periodicCleanup(now: number): void {
    // Run cleanup if size exceeds limit or if 1 window length has elapsed since last cleanup
    if (this.entries.size > this.maxEntries || now - this.lastCleanup > this.windowMs) {
      this.cleanup(now);
    }
  }
}

/**
 * Standard Relay Rate Limiter Defaults
 */
export const RATE_LIMIT_DEFAULTS = {
  /** IP WebSocket connection upgrades per minute */
  IP_HANDSHAKE_LIMIT: 60,
  /** IP WebSocket connection upgrade window (60 seconds) */
  IP_HANDSHAKE_WINDOW_MS: 60_000,
  /** Inbound WebSocket messages per session per 10-second window */
  SESSION_MSG_LIMIT: 100,
  /** Inbound WebSocket messages window (10 seconds) */
  SESSION_MSG_WINDOW_MS: 10_000,
  /** EVENT writes per pubkey per minute */
  PUBKEY_WRITE_LIMIT: 30,
  /** EVENT writes window (60 seconds) */
  PUBKEY_WRITE_WINDOW_MS: 60_000,
} as const;

/**
 * High-level registry for managing relay rate limiters
 */
export class RateLimiterRegistry {
  private ipHandshakeLimiter: SlidingWindowLimiter;
  private pubkeyWriteLimiter: SlidingWindowLimiter;

  constructor(options?: {
    ipHandshakeLimit?: number;
    ipHandshakeWindowMs?: number;
    pubkeyWriteLimit?: number;
    pubkeyWriteWindowMs?: number;
  }) {
    this.ipHandshakeLimiter = new SlidingWindowLimiter({
      maxRequests: options?.ipHandshakeLimit ?? RATE_LIMIT_DEFAULTS.IP_HANDSHAKE_LIMIT,
      windowMs: options?.ipHandshakeWindowMs ?? RATE_LIMIT_DEFAULTS.IP_HANDSHAKE_WINDOW_MS,
    });

    this.pubkeyWriteLimiter = new SlidingWindowLimiter({
      maxRequests: options?.pubkeyWriteLimit ?? RATE_LIMIT_DEFAULTS.PUBKEY_WRITE_LIMIT,
      windowMs: options?.pubkeyWriteWindowMs ?? RATE_LIMIT_DEFAULTS.PUBKEY_WRITE_WINDOW_MS,
    });
  }

  /**
   * Check IP rate limit for HTTP/WebSocket upgrade handshake.
   */
  checkIpHandshake(ip: string, now?: number): RateLimitResult {
    return this.ipHandshakeLimiter.check(ip, now);
  }

  /**
   * Check pubkey rate limit for incoming EVENT writes.
   */
  checkPubkeyWrite(pubkey: string, now?: number): RateLimitResult {
    return this.pubkeyWriteLimiter.check(pubkey, now);
  }

  /**
   * Creates a dedicated per-session message rate limiter.
   */
  createSessionMessageLimiter(options?: {
    maxMessages?: number;
    windowMs?: number;
  }): SlidingWindowLimiter {
    return new SlidingWindowLimiter({
      maxRequests: options?.maxMessages ?? RATE_LIMIT_DEFAULTS.SESSION_MSG_LIMIT,
      windowMs: options?.windowMs ?? RATE_LIMIT_DEFAULTS.SESSION_MSG_WINDOW_MS,
    });
  }

  /**
   * Resets all limiters.
   */
  clear(): void {
    this.ipHandshakeLimiter.clear();
    this.pubkeyWriteLimiter.clear();
  }
}
