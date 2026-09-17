import { describe, expect, it } from 'vitest';
import {
  RateLimiterRegistry,
  RATE_LIMIT_DEFAULTS,
  SlidingWindowLimiter,
  TokenBucketLimiter,
} from '../../src/security/rate-limiter';

describe('Rate Limiting Subsystem', () => {
  describe('TokenBucketLimiter', () => {
    it('throws error if capacity or refillRate is non-positive', () => {
      expect(() => new TokenBucketLimiter({ capacity: 0, refillRate: 10 })).toThrow();
      expect(() => new TokenBucketLimiter({ capacity: 10, refillRate: -1 })).toThrow();
    });

    it('allows consuming tokens up to capacity', () => {
      const limiter = new TokenBucketLimiter({ capacity: 5, refillRate: 1 });
      const t0 = 1000000;

      for (let i = 0; i < 5; i++) {
        const res = limiter.consume(1, t0);
        expect(res.allowed).toBe(true);
      }

      // 6th consume should fail
      const failed = limiter.consume(1, t0);
      expect(failed.allowed).toBe(false);
      expect(failed.retryAfterMs).toBeGreaterThan(0);
    });

    it('refills tokens over time accurately', () => {
      const limiter = new TokenBucketLimiter({ capacity: 10, refillRate: 2 });
      const t0 = 1000000;

      // Drain all 10 tokens
      limiter.consume(10, t0);
      expect(limiter.getAvailableTokens(t0)).toBe(0);

      // Advance by 2.5 seconds -> 5 tokens refilled
      const t1 = t0 + 2500;
      expect(limiter.consume(5, t1).allowed).toBe(true);
      expect(limiter.consume(1, t1).allowed).toBe(false);

      // Advance by 10 seconds -> capped at capacity (10)
      const t2 = t1 + 10000;
      expect(limiter.getAvailableTokens(t2)).toBe(10);
    });

    it('resets correctly to capacity', () => {
      const limiter = new TokenBucketLimiter({ capacity: 5, refillRate: 1 });
      const t0 = 1000000;
      limiter.consume(5, t0);
      expect(limiter.consume(1, t0).allowed).toBe(false);

      limiter.reset(t0);
      expect(limiter.getAvailableTokens(t0)).toBe(5);
      expect(limiter.consume(5, t0).allowed).toBe(true);
    });
  });

  describe('SlidingWindowLimiter', () => {
    it('throws error on non-positive windowMs or maxRequests', () => {
      expect(() => new SlidingWindowLimiter({ windowMs: 0, maxRequests: 10 })).toThrow();
      expect(() => new SlidingWindowLimiter({ windowMs: 1000, maxRequests: 0 })).toThrow();
    });

    it('allows requests within threshold and blocks beyond threshold', () => {
      const limiter = new SlidingWindowLimiter({ windowMs: 10000, maxRequests: 3 });
      const t0 = 1000000;
      const key = 'user:123';

      expect(limiter.check(key, t0).allowed).toBe(true);
      expect(limiter.check(key, t0 + 100).allowed).toBe(true);
      expect(limiter.check(key, t0 + 200).allowed).toBe(true);

      // 4th request within 10s window should fail
      const blocked = limiter.check(key, t0 + 300);
      expect(blocked.allowed).toBe(false);
      expect(blocked.current).toBe(3);
      expect(blocked.retryAfterMs).toBe(10000 - 300);
    });

    it('slides the window and permits requests once oldest timestamps expire', () => {
      const limiter = new SlidingWindowLimiter({ windowMs: 1000, maxRequests: 2 });
      const t0 = 1000000;
      const key = 'ip:1.2.3.4';

      expect(limiter.check(key, t0).allowed).toBe(true);
      expect(limiter.check(key, t0 + 500).allowed).toBe(true);
      expect(limiter.check(key, t0 + 600).allowed).toBe(false);

      // Advance time past t0 + 1000 (first request expires, second request at t0+500 still active)
      const t1 = t0 + 1001;
      expect(limiter.check(key, t1).allowed).toBe(true);
      // Now we have t0+500 and t0+1001 in window (2 requests), next fails
      expect(limiter.check(key, t1 + 100).allowed).toBe(false);

      // Advance time past t0 + 1500 (second request expires)
      const t2 = t0 + 1501;
      expect(limiter.check(key, t2).allowed).toBe(true);
    });

    it('isolates different keys independently', () => {
      const limiter = new SlidingWindowLimiter({ windowMs: 1000, maxRequests: 1 });
      const t0 = 1000000;

      expect(limiter.check('keyA', t0).allowed).toBe(true);
      expect(limiter.check('keyA', t0).allowed).toBe(false);

      expect(limiter.check('keyB', t0).allowed).toBe(true);
      expect(limiter.check('keyB', t0).allowed).toBe(false);
    });

    it('cleans up stale entries on garbage collection', () => {
      const limiter = new SlidingWindowLimiter({ windowMs: 1000, maxRequests: 5 });
      const t0 = 1000000;

      limiter.check('key1', t0);
      limiter.check('key2', t0);
      expect(limiter.size).toBe(2);

      // Running cleanup at t0 does not evict active entries
      expect(limiter.cleanup(t0)).toBe(0);
      expect(limiter.size).toBe(2);

      // Running cleanup at t0 + 1500 evicts both expired keys
      const evicted = limiter.cleanup(t0 + 1500);
      expect(evicted).toBe(2);
      expect(limiter.size).toBe(0);
    });

    it('resets a specific key or clears all keys', () => {
      const limiter = new SlidingWindowLimiter({ windowMs: 1000, maxRequests: 1 });
      const t0 = 1000000;

      limiter.check('key1', t0);
      limiter.check('key2', t0);

      limiter.resetKey('key1');
      expect(limiter.check('key1', t0).allowed).toBe(true);
      expect(limiter.check('key2', t0).allowed).toBe(false);

      limiter.clear();
      expect(limiter.size).toBe(0);
      expect(limiter.check('key2', t0).allowed).toBe(true);
    });
  });

  describe('RateLimiterRegistry', () => {
    it('initializes with default options and handles IP & pubkey checks', () => {
      const registry = new RateLimiterRegistry();
      const t0 = 1000000;

      const ipResult = registry.checkIpHandshake('192.168.1.1', t0);
      expect(ipResult.allowed).toBe(true);
      expect(ipResult.limit).toBe(RATE_LIMIT_DEFAULTS.IP_HANDSHAKE_LIMIT);

      const pubkeyResult = registry.checkPubkeyWrite('abcdef0123456789', t0);
      expect(pubkeyResult.allowed).toBe(true);
      expect(pubkeyResult.limit).toBe(RATE_LIMIT_DEFAULTS.PUBKEY_WRITE_LIMIT);
    });

    it('creates isolated session message limiters with custom or default bounds', () => {
      const registry = new RateLimiterRegistry();
      const sessionLimiter = registry.createSessionMessageLimiter({
        maxMessages: 5,
        windowMs: 1000,
      });

      const t0 = 1000000;
      for (let i = 0; i < 5; i++) {
        expect(sessionLimiter.check('session-ws', t0).allowed).toBe(true);
      }
      expect(sessionLimiter.check('session-ws', t0).allowed).toBe(false);
    });

    it('clears registry limiters', () => {
      const registry = new RateLimiterRegistry({ ipHandshakeLimit: 1 });
      const t0 = 1000000;

      expect(registry.checkIpHandshake('10.0.0.1', t0).allowed).toBe(true);
      expect(registry.checkIpHandshake('10.0.0.1', t0).allowed).toBe(false);

      registry.clear();
      expect(registry.checkIpHandshake('10.0.0.1', t0).allowed).toBe(true);
    });
  });
});
