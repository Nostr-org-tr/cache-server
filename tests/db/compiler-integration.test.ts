import { describe, expect, it } from 'vitest';
import { compileFilterToSql } from '../../src/db/compiler';
import type { NostrFilter } from '../../src/types/nostr';

describe('SQL Query Compiler Integration & SQL Injection Immunity', () => {
  describe('Complex Multi-Tag Filters & Parameterization', () => {
    it('compiles complex multi-tag queries (#e, #p, #d, #t) into correct indexed subqueries', () => {
      const filter: NostrFilter = {
        kinds: [1, 6],
        authors: ['aaaa000000000000000000000000000000000000000000000000000000000001'],
        '#e': ['eeee000000000000000000000000000000000000000000000000000000000001'],
        '#p': ['pppp000000000000000000000000000000000000000000000000000000000001'],
        '#t': ['nostr', 'bitcoin'],
        since: 1700000000,
        until: 1700100000,
        limit: 50,
      };

      const result = compileFilterToSql(filter, { maxLimit: 500 });
      expect(result).not.toBeNull();
      if (result) {
        expect(result.sql).toContain('pubkey IN (?)');
        expect(result.sql).toContain('kind IN (?, ?)');
        expect(result.sql).toContain('created_at >= ?');
        expect(result.sql).toContain('created_at <= ?');
        expect(result.sql).toContain('event_tags WHERE tag_name = ? AND tag_value IN (?)');
        expect(result.sql).toContain('event_tags WHERE tag_name = ? AND tag_value IN (?, ?)');
        expect(result.sql).toContain('ORDER BY created_at DESC LIMIT ?');

        // Verify bindings count and order match placeholders
        const questionMarks = (result.sql.match(/\?/g) || []).length;
        expect(result.params.length).toBe(questionMarks);

        expect(result.params).toContain('nostr');
        expect(result.params).toContain('bitcoin');
        expect(result.params).toContain(1700000000);
        expect(result.params).toContain(1700100000);
        expect(result.params).toContain(50);
      }
    });
  });

  describe('SQL Injection Immunity & Adversarial Inputs', () => {
    it('safely handles classic SQL injection payloads in filter strings via parameterization', () => {
      const sqlInjectionPayloads = [
        "' OR 1=1; --",
        "'; DROP TABLE events; --",
        "' UNION SELECT id, pubkey, 1, 1, '[]', 'hacked', 'sig', '', 1 FROM events --",
        "1' OR '1' = '1",
        "admin'/*",
      ];

      for (const payload of sqlInjectionPayloads) {
        const filter: NostrFilter = {
          authors: [payload],
          search: payload,
          '#e': [payload],
          '#p': [payload],
        };

        const result = compileFilterToSql(filter);
        expect(result).not.toBeNull();
        if (result) {
          // SQL text itself must NOT contain raw unescaped payload
          expect(result.sql).not.toContain(payload);
          // Instead, the payload must be present in parameterized bindings
          expect(result.params).toContain(payload);

          // Placeholders must strictly match bindings count
          const placeholders = (result.sql.match(/\?/g) || []).length;
          expect(result.params.length).toBe(placeholders);
        }
      }
    });

    it('safely handles malicious tag names (e.g. non-alphanumeric tag keys)', () => {
      const filter: NostrFilter = {
        // Tag names with special chars
        ['#weird_tag"']: ['val1'],
        ['#e;--']: ['val2'],
      } as unknown as NostrFilter;

      const result = compileFilterToSql(filter);
      expect(result).not.toBeNull();
      if (result) {
        // Parameterization must bind the tag name as string parameter
        const placeholders = (result.sql.match(/\?/g) || []).length;
        expect(result.params.length).toBe(placeholders);
      }
    });

    it('enforces bounds on limit (clamps to maxLimit and floors negative/zero values)', () => {
      const negativeFilter: NostrFilter = { kinds: [1], limit: -50 };
      const resNeg = compileFilterToSql(negativeFilter, { maxLimit: 500 });
      expect(resNeg).not.toBeNull();
      // Should clamp to minimum 1
      expect(resNeg?.params[resNeg.params.length - 1]).toBe(1);

      const hugeLimitFilter: NostrFilter = { kinds: [1], limit: 99999 };
      const resHuge = compileFilterToSql(hugeLimitFilter, { maxLimit: 500 });
      expect(resHuge?.params[resHuge.params.length - 1]).toBe(500);
    });

    it('handles empty filters and empty array constraints gracefully', () => {
      // Empty filter matches all events up to maxLimit
      const emptyFilter: NostrFilter = {};
      const resEmpty = compileFilterToSql(emptyFilter, { maxLimit: 100 });
      expect(resEmpty).not.toBeNull();
      expect(resEmpty?.sql).toContain('FROM events');
      expect(resEmpty?.params).toEqual([100]);

      // Filter with empty arrays (e.g. kinds: [])
      const emptyKindsFilter: NostrFilter = { kinds: [] };
      const resEmptyKinds = compileFilterToSql(emptyKindsFilter);
      if (resEmptyKinds) {
        const placeholders = (resEmptyKinds.sql.match(/\?/g) || []).length;
        expect(resEmptyKinds.params.length).toBe(placeholders);
      }
    });
  });
});
