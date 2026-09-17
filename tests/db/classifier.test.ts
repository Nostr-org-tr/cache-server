import { describe, expect, it } from 'vitest';
import {
  classifyEventKind,
  eventToEventRow,
  extractDTag,
  extractIndexableTags,
  rowToNostrEvent,
} from '../../src/db/classifier';
import type { NostrEvent } from '../../src/types/nostr';

describe('Event Classifier & Utilities', () => {
  describe('classifyEventKind', () => {
    it('should classify kind 5 as DELETION', () => {
      expect(classifyEventKind(5)).toBe('DELETION');
    });

    it('should classify kinds 20000..29999 as EPHEMERAL', () => {
      expect(classifyEventKind(20000)).toBe('EPHEMERAL');
      expect(classifyEventKind(25000)).toBe('EPHEMERAL');
      expect(classifyEventKind(29999)).toBe('EPHEMERAL');
    });

    it('should classify kinds 0, 3, and 10000..19999 as REPLACEABLE', () => {
      expect(classifyEventKind(0)).toBe('REPLACEABLE');
      expect(classifyEventKind(3)).toBe('REPLACEABLE');
      expect(classifyEventKind(10000)).toBe('REPLACEABLE');
      expect(classifyEventKind(10002)).toBe('REPLACEABLE');
      expect(classifyEventKind(19999)).toBe('REPLACEABLE');
    });

    it('should classify kinds 30000..39999 as PARAMETERIZED_REPLACEABLE', () => {
      expect(classifyEventKind(30000)).toBe('PARAMETERIZED_REPLACEABLE');
      expect(classifyEventKind(30023)).toBe('PARAMETERIZED_REPLACEABLE');
      expect(classifyEventKind(39999)).toBe('PARAMETERIZED_REPLACEABLE');
    });

    it('should classify kinds 1, 2, 4..9999 as REGULAR', () => {
      expect(classifyEventKind(1)).toBe('REGULAR');
      expect(classifyEventKind(2)).toBe('REGULAR');
      expect(classifyEventKind(4)).toBe('REGULAR');
      expect(classifyEventKind(6)).toBe('REGULAR');
      expect(classifyEventKind(9999)).toBe('REGULAR');
    });
  });

  describe('extractDTag', () => {
    it('should extract value from ["d", "my-identifier"]', () => {
      const tags = [
        ['e', 'some-event-id'],
        ['d', 'article-slug-123'],
        ['t', 'nostr'],
      ];
      expect(extractDTag(tags)).toBe('article-slug-123');
    });

    it('should return empty string if d tag has no value or is empty', () => {
      expect(extractDTag([['d']])).toBe('');
      expect(extractDTag([['d', '']])).toBe('');
    });

    it('should return empty string if no d tag is present', () => {
      const tags = [
        ['e', 'some-event-id'],
        ['p', 'some-pubkey'],
      ];
      expect(extractDTag(tags)).toBe('');
    });

    it('should return the first d tag if multiple are present', () => {
      const tags = [
        ['d', 'first-val'],
        ['d', 'second-val'],
      ];
      expect(extractDTag(tags)).toBe('first-val');
    });
  });

  describe('extractIndexableTags', () => {
    it('should extract indexable tags and deduplicate identical pairs', () => {
      const event: NostrEvent = {
        id: 'a'.repeat(64),
        pubkey: 'b'.repeat(64),
        created_at: 1000,
        kind: 1,
        tags: [
          ['e', 'event1', 'wss://relay.damus.io', 'root'],
          ['e', 'event2'],
          ['p', 'pubkey1'],
          ['e', 'event1'], // duplicate (e, event1)
          ['invalid'], // too short
        ],
        content: 'test',
        sig: 'c'.repeat(128),
      };

      const extracted = extractIndexableTags(event);
      expect(extracted).toEqual([
        { tagName: 'e', tagValue: 'event1' },
        { tagName: 'e', tagValue: 'event2' },
        { tagName: 'p', tagValue: 'pubkey1' },
      ]);
    });
  });

  describe('eventToEventRow and rowToNostrEvent', () => {
    it('should correctly convert NostrEvent to EventRow and back', () => {
      const original: NostrEvent = {
        id: '11'.repeat(32),
        pubkey: '22'.repeat(32),
        created_at: 1700000000,
        kind: 30023,
        tags: [['d', 'my-post'], ['t', 'bitcoin']],
        content: 'Hello World',
        sig: '33'.repeat(64),
      };

      const row = eventToEventRow(original, 1700000005);
      expect(row.id).toBe(original.id);
      expect(row.pubkey).toBe(original.pubkey);
      expect(row.created_at).toBe(original.created_at);
      expect(row.kind).toBe(30023);
      expect(row.d_tag).toBe('my-post');
      expect(row.created_at_recorded).toBe(1700000005);
      expect(JSON.parse(row.raw_event)).toEqual(original);

      const hydrated = rowToNostrEvent(row);
      expect(hydrated).toEqual(original);
    });

    it('should set d_tag to null for non-parameterized events', () => {
      const event: NostrEvent = {
        id: '11'.repeat(32),
        pubkey: '22'.repeat(32),
        created_at: 1700000000,
        kind: 1,
        tags: [['d', 'ignored-for-regular']],
        content: 'Hello',
        sig: '33'.repeat(64),
      };

      const row = eventToEventRow(event);
      expect(row.d_tag).toBeNull();
    });
  });
});
