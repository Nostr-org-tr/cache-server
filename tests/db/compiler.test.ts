import { describe, expect, it } from 'vitest';
import {
  compileCountToSql,
  compileDeletionQueries,
  compileFilterToSql,
} from '../../src/db/compiler';
import type { NostrEvent, NostrFilter } from '../../src/types/nostr';

describe('NIP-01 Filter to SQL Compiler', () => {
  describe('compileFilterToSql', () => {
    it('should compile an empty filter with default limit and ordering', () => {
      const filter: NostrFilter = {};
      const { sql, params } = compileFilterToSql(filter);

      expect(sql).toBe(
        'SELECT id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded FROM events ORDER BY created_at DESC LIMIT ?'
      );
      expect(params).toEqual([500]);
    });

    it('should compile exact ids and prefix ids', () => {
      const exactId = 'a'.repeat(64);
      const prefixId = 'abcd';
      const filter: NostrFilter = { ids: [exactId, prefixId] };
      const { sql, params } = compileFilterToSql(filter);

      expect(sql).toContain('WHERE (id IN (?) OR id LIKE ?)');
      expect(params).toEqual([exactId, 'abcd%', 500]);
    });

    it('should compile exact authors and prefix authors', () => {
      const exactAuthor = 'b'.repeat(64);
      const prefixAuthor = '1234';
      const filter: NostrFilter = { authors: [exactAuthor, prefixAuthor] };
      const { sql, params } = compileFilterToSql(filter);

      expect(sql).toContain('WHERE (pubkey IN (?) OR pubkey LIKE ?)');
      expect(params).toEqual([exactAuthor, '1234%', 500]);
    });

    it('should compile kinds filter', () => {
      const filter: NostrFilter = { kinds: [0, 1, 3] };
      const { sql, params } = compileFilterToSql(filter);

      expect(sql).toContain('WHERE kind IN (?, ?, ?)');
      expect(params).toEqual([0, 1, 3, 500]);
    });

    it('should compile since and until time boundaries', () => {
      const filter: NostrFilter = { since: 1000, until: 2000 };
      const { sql, params } = compileFilterToSql(filter);

      expect(sql).toContain('WHERE created_at >= ? AND created_at <= ?');
      expect(params).toEqual([1000, 2000, 500]);
    });

    it('should compile single and multi-tag filters (#e, #p, #d)', () => {
      const filter: NostrFilter = {
        '#e': ['event1', 'event2'],
        '#p': ['pubkey1'],
      };
      const { sql, params } = compileFilterToSql(filter);

      expect(sql).toContain(
        'id IN (SELECT event_id FROM event_tags WHERE tag_name = ? AND tag_value IN (?, ?))'
      );
      expect(sql).toContain(
        'id IN (SELECT event_id FROM event_tags WHERE tag_name = ? AND tag_value IN (?))'
      );
      expect(params).toEqual(['e', 'event1', 'event2', 'p', 'pubkey1', 500]);
    });

    it('should handle empty tag array by matching nothing', () => {
      const filter: NostrFilter = { '#e': [] };
      const { sql, params } = compileFilterToSql(filter);

      expect(sql).toContain('WHERE 1 = 0');
      expect(params).toEqual([500]);
    });

    it('should cap limit to maximum configured limit', () => {
      const filter: NostrFilter = { limit: 10000 };
      const { params } = compileFilterToSql(filter, { maxLimit: 200 });

      expect(params[params.length - 1]).toBe(200);
    });

    it('should combine multiple conditions with AND logic', () => {
      const exactAuthor = 'a'.repeat(64);
      const filter: NostrFilter = {
        authors: [exactAuthor],
        kinds: [1],
        since: 1700000000,
        '#t': ['nostr'],
        limit: 25,
      };
      const { sql, params } = compileFilterToSql(filter);

      expect(sql).toBe(
        'SELECT id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded FROM events WHERE pubkey IN (?) AND kind IN (?) AND created_at >= ? AND id IN (SELECT event_id FROM event_tags WHERE tag_name = ? AND tag_value IN (?)) ORDER BY created_at DESC LIMIT ?'
      );
      expect(params).toEqual([exactAuthor, 1, 1700000000, 't', 'nostr', 25]);
    });
  });

  describe('compileCountToSql', () => {
    it('should compile a valid SELECT COUNT query', () => {
      const filter: NostrFilter = { kinds: [1], since: 1000 };
      const { sql, params } = compileCountToSql(filter);

      expect(sql).toBe(
        'SELECT COUNT(*) as count FROM events WHERE kind IN (?) AND created_at >= ?'
      );
      expect(params).toEqual([1, 1000]);
    });
  });

  describe('compileDeletionQueries', () => {
    it('should generate parameterized deletion SQL for referenced e and a tags', () => {
      const authorPubkey = 'a'.repeat(64);
      const targetId1 = '1'.repeat(64);
      const targetId2 = '2'.repeat(64);

      const deletionEvent: NostrEvent = {
        id: '9'.repeat(64),
        pubkey: authorPubkey,
        created_at: 1700000000,
        kind: 5,
        tags: [
          ['e', targetId1],
          ['e', targetId2],
          ['a', `30023:${authorPubkey}:my-article`],
          ['a', `30023:otherpubkey:should-be-ignored`], // other author, ignored!
        ],
        content: 'deleting old posts',
        sig: 'f'.repeat(128),
      };

      const queries = compileDeletionQueries(deletionEvent);
      expect(queries).toHaveLength(2);

      // 1. Parameterized replaceable deletion for author's own a tag
      expect(queries[0]).toEqual({
        sql: 'DELETE FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ?',
        params: [authorPubkey, 30023, 'my-article'],
      });

      // 2. ID-based deletion for referenced e tags constrained to author pubkey
      expect(queries[1]).toEqual({
        sql: 'DELETE FROM events WHERE id IN (?, ?) AND pubkey = ?',
        params: [targetId1, targetId2, authorPubkey],
      });
    });
  });
});
