import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillUnindexedVectors, countEvents, queryEvents, saveEvent, saveEventsBatch } from '../../src/db/repository';
import type { NostrEvent } from '../../src/types/nostr';
import type { Env } from '../../src/types/env';
import { MockD1Database } from '../mocks/mock-d1';

describe('D1 Event Repository', () => {
  let db: MockD1Database;

  beforeEach(() => {
    db = new MockD1Database();
  });

  describe('saveEvent - Ephemeral Events (20000..29999)', () => {
    it('should ignore ephemeral events without saving to D1', async () => {
      const ephemeralEvent: NostrEvent = {
        id: '1'.repeat(64),
        pubkey: 'a'.repeat(64),
        created_at: 1000,
        kind: 20001,
        tags: [],
        content: 'typing...',
        sig: 'f'.repeat(128),
      };

      const result = await saveEvent(db, ephemeralEvent);
      expect(result.action).toBe('ignored');
      expect(result.reason).toBe('ephemeral');
      expect(db.events.size).toBe(0);
    });
  });

  describe('saveEvent - Regular Events (Kinds 1, 2, 4..9999)', () => {
    it('should insert a regular event and index its tags', async () => {
      const event: NostrEvent = {
        id: '1'.repeat(64),
        pubkey: 'a'.repeat(64),
        created_at: 1000,
        kind: 1,
        tags: [
          ['e', 'root-id'],
          ['p', 'pubkey-target'],
        ],
        content: 'Hello Nostr',
        sig: 'f'.repeat(128),
      };

      const result = await saveEvent(db, event);
      expect(result.action).toBe('inserted');
      expect(db.events.size).toBe(1);
      expect(db.events.get(event.id)?.id).toBe(event.id);
      expect(db.eventTags).toHaveLength(2);
    });

    it('should ignore duplicate regular event insertions', async () => {
      const event: NostrEvent = {
        id: '1'.repeat(64),
        pubkey: 'a'.repeat(64),
        created_at: 1000,
        kind: 1,
        tags: [],
        content: 'Hello Nostr',
        sig: 'f'.repeat(128),
      };

      const first = await saveEvent(db, event);
      expect(first.action).toBe('inserted');

      const second = await saveEvent(db, event);
      expect(second.action).toBe('ignored');
      expect(second.reason).toBe('duplicate');
      expect(db.events.size).toBe(1);
    });
  });

  describe('saveEvent - Replaceable Events (0, 3, 10000..19999)', () => {
    const pubkey = 'a'.repeat(64);

    it('should overwrite older replaceable event with newer created_at', async () => {
      const olderEvent: NostrEvent = {
        id: '1'.repeat(64),
        pubkey,
        created_at: 1000,
        kind: 0,
        tags: [],
        content: '{"name":"old_name"}',
        sig: 'f'.repeat(128),
      };

      const newerEvent: NostrEvent = {
        id: '2'.repeat(64),
        pubkey,
        created_at: 2000,
        kind: 0,
        tags: [],
        content: '{"name":"new_name"}',
        sig: 'f'.repeat(128),
      };

      await saveEvent(db, olderEvent);
      expect(db.events.has(olderEvent.id)).toBe(true);

      const res = await saveEvent(db, newerEvent);
      expect(res.action).toBe('inserted');
      expect(db.events.has(olderEvent.id)).toBe(false);
      expect(db.events.has(newerEvent.id)).toBe(true);
      expect(db.events.size).toBe(1);
    });

    it('should reject incoming replaceable event if older than existing', async () => {
      const existingNewer: NostrEvent = {
        id: '2'.repeat(64),
        pubkey,
        created_at: 2000,
        kind: 0,
        tags: [],
        content: '{"name":"new_name"}',
        sig: 'f'.repeat(128),
      };

      const incomingOlder: NostrEvent = {
        id: '1'.repeat(64),
        pubkey,
        created_at: 1000,
        kind: 0,
        tags: [],
        content: '{"name":"old_name"}',
        sig: 'f'.repeat(128),
      };

      await saveEvent(db, existingNewer);
      const res = await saveEvent(db, incomingOlder);

      expect(res.action).toBe('superseded');
      expect(res.reason).toBe('older_timestamp');
      expect(db.events.has(existingNewer.id)).toBe(true);
      expect(db.events.has(incomingOlder.id)).toBe(false);
    });

    it('should break ties on equal created_at by keeping the lowest lexicographical ID', async () => {
      const lowIdEvent: NostrEvent = {
        id: '1'.repeat(64),
        pubkey,
        created_at: 1500,
        kind: 3,
        tags: [],
        content: 'contact list A',
        sig: 'f'.repeat(128),
      };

      const highIdEvent: NostrEvent = {
        id: '9'.repeat(64),
        pubkey,
        created_at: 1500,
        kind: 3,
        tags: [],
        content: 'contact list B',
        sig: 'f'.repeat(128),
      };

      // Case A: lowId exists, highId arrives -> rejected
      await saveEvent(db, lowIdEvent);
      const resA = await saveEvent(db, highIdEvent);
      expect(resA.action).toBe('superseded');
      expect(resA.reason).toBe('tie_break_id');
      expect(db.events.has(lowIdEvent.id)).toBe(true);

      // Case B: Reset, highId exists, lowId arrives -> replaces
      db = new MockD1Database();
      await saveEvent(db, highIdEvent);
      const resB = await saveEvent(db, lowIdEvent);
      expect(resB.action).toBe('inserted');
      expect(db.events.has(lowIdEvent.id)).toBe(true);
      expect(db.events.has(highIdEvent.id)).toBe(false);
    });
  });

  describe('saveEvent - Parameterized Replaceable Events (30000..39999)', () => {
    const pubkey = 'b'.repeat(64);

    it('should maintain independent entries for different d_tags and replace matching d_tag', async () => {
      const article1: NostrEvent = {
        id: '1'.repeat(64),
        pubkey,
        created_at: 1000,
        kind: 30023,
        tags: [['d', 'article-1']],
        content: 'Draft 1',
        sig: 'f'.repeat(128),
      };

      const article2: NostrEvent = {
        id: '2'.repeat(64),
        pubkey,
        created_at: 1000,
        kind: 30023,
        tags: [['d', 'article-2']],
        content: 'Article 2',
        sig: 'f'.repeat(128),
      };

      const article1Update: NostrEvent = {
        id: '3'.repeat(64),
        pubkey,
        created_at: 2000,
        kind: 30023,
        tags: [['d', 'article-1']],
        content: 'Draft 1 updated',
        sig: 'f'.repeat(128),
      };

      await saveEvent(db, article1);
      await saveEvent(db, article2);
      expect(db.events.size).toBe(2);

      const res = await saveEvent(db, article1Update);
      expect(res.action).toBe('inserted');
      expect(db.events.size).toBe(2);
      expect(db.events.has(article1.id)).toBe(false);
      expect(db.events.has(article1Update.id)).toBe(true);
      expect(db.events.has(article2.id)).toBe(true);
    });
  });

  describe('saveEvent - Deletion Events (Kind 5 - NIP-09)', () => {
    it('should delete author owned events referenced in e tags', async () => {
      const authorPubkey = 'c'.repeat(64);
      const otherPubkey = 'd'.repeat(64);

      const authorEvent: NostrEvent = {
        id: '11'.repeat(32),
        pubkey: authorPubkey,
        created_at: 1000,
        kind: 1,
        tags: [],
        content: 'Delete me',
        sig: 'f'.repeat(128),
      };

      const otherEvent: NostrEvent = {
        id: '22'.repeat(32),
        pubkey: otherPubkey,
        created_at: 1000,
        kind: 1,
        tags: [],
        content: 'Keep me',
        sig: 'f'.repeat(128),
      };

      await saveEvent(db, authorEvent);
      await saveEvent(db, otherEvent);
      expect(db.events.size).toBe(2);

      const deletionEvent: NostrEvent = {
        id: '99'.repeat(32),
        pubkey: authorPubkey,
        created_at: 2000,
        kind: 5,
        tags: [
          ['e', authorEvent.id],
          ['e', otherEvent.id], // trying to delete someone else's event
        ],
        content: 'deleting',
        sig: 'f'.repeat(128),
      };

      const res = await saveEvent(db, deletionEvent);
      expect(res.action).toBe('deleted');

      // authorEvent must be deleted
      expect(db.events.has(authorEvent.id)).toBe(false);
      // otherEvent must be preserved
      expect(db.events.has(otherEvent.id)).toBe(true);
      // deletion event itself is recorded
      expect(db.events.has(deletionEvent.id)).toBe(true);
    });
  });

  describe('saveEventsBatch', () => {
    it('should process a batch of events', async () => {
      const events: NostrEvent[] = [
        {
          id: '1'.repeat(64),
          pubkey: 'a'.repeat(64),
          created_at: 1000,
          kind: 1,
          tags: [],
          content: 'Event 1',
          sig: 'f'.repeat(128),
        },
        {
          id: '2'.repeat(64),
          pubkey: 'a'.repeat(64),
          created_at: 1001,
          kind: 1,
          tags: [],
          content: 'Event 2',
          sig: 'f'.repeat(128),
        },
      ];

      const results = await saveEventsBatch(db, events);
      expect(results).toHaveLength(2);
      const [res1, res2] = results;
      expect(res1?.action).toBe('inserted');
      expect(res2?.action).toBe('inserted');
      expect(db.events.size).toBe(2);
    });
  });

  describe('queryEvents and countEvents', () => {
    it('should query matching events and deduplicate results across filters', async () => {
      const event1: NostrEvent = {
        id: '1'.repeat(64),
        pubkey: 'a'.repeat(64),
        created_at: 1000,
        kind: 1,
        tags: [['t', 'nostr']],
        content: 'First post',
        sig: 'f'.repeat(128),
      };

      const event2: NostrEvent = {
        id: '2'.repeat(64),
        pubkey: 'a'.repeat(64),
        created_at: 2000,
        kind: 1,
        tags: [['t', 'bitcoin']],
        content: 'Second post',
        sig: 'f'.repeat(128),
      };

      await saveEvent(db, event1);
      await saveEvent(db, event2);

      // Query with 2 filters that both match event2
      const filters = [{ kinds: [1], '#t': ['bitcoin'] }, { kinds: [1] }];

      const results = await queryEvents(db, filters);
      expect(results).toHaveLength(2);
      // Sorted by created_at DESC
      const [firstResult, secondResult] = results;
      expect(firstResult?.id).toBe(event2.id);
      expect(secondResult?.id).toBe(event1.id);

      const count = await countEvents(db, [{ kinds: [1] }]);
      expect(count).toBe(2);
    });

    it('should split filters with large authors arrays (>50 items) into safe chunks and return matching events', async () => {
      const targetAuthor = 'a'.repeat(64);
      const otherAuthors = Array.from({ length: 150 }, (_, i) => `${i.toString(16).padStart(2, '0')}${'b'.repeat(62)}`);

      const event: NostrEvent = {
        id: '1'.repeat(64),
        pubkey: targetAuthor,
        created_at: 1000,
        kind: 1,
        tags: [],
        content: 'Note from target author',
        sig: 'f'.repeat(128),
      };
      await saveEvent(db, event);

      // Query with 151 authors
      const allAuthors = [targetAuthor, ...otherAuthors];
      const results = await queryEvents(db, [{ kinds: [1], authors: allAuthors }]);

      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(event.id);

      const count = await countEvents(db, [{ kinds: [1], authors: allAuthors }]);
      expect(count).toBe(1);
    });
  });

  describe('backfillUnindexedVectors', () => {
    it('should backfill unindexed events in safe chunks when batch exceeds 50 items', async () => {
      // Create 75 unindexed kind 1 events
      for (let i = 0; i < 75; i++) {
        const id = i.toString(16).padStart(64, '0');
        const event: NostrEvent = {
          id,
          pubkey: 'a'.repeat(64),
          created_at: 1000 + i,
          kind: 1,
          tags: [],
          content: `Substantive test note number ${i} for vector indexing`,
          sig: 'f'.repeat(128),
        };
        await saveEvent(db, event);
      }

      const mockAi = {
        run: vi.fn().mockImplementation(async (_model: string, { text }: { text: string[] }) => {
          return { data: text.map(() => [0.1, 0.2, 0.3]) };
        }),
      } as unknown as Ai;

      const mockVectorIndex = {
        upsert: vi.fn().mockResolvedValue({ count: 50 }),
      } as unknown as VectorizeIndex;

      const mockEnv = {
        DB: db,
        AI: mockAi,
        VECTOR_INDEX: mockVectorIndex,
        VECTOR_SEARCH_ENABLED: 'true',
      } as unknown as Env;

      const count = await backfillUnindexedVectors(db, mockEnv, 75);
      expect(count).toBe(75);
      expect(mockVectorIndex.upsert).toHaveBeenCalled();

      // Verify that all 75 events have vector_indexed = 1 in db
      const indexedCount = Array.from(db.events.values()).filter(
        (e) => (e as any).vector_indexed === 1
      ).length;
      expect(indexedCount).toBe(75);
    });

    it('should return 0 when vector search is disabled', async () => {
      const mockEnv = {
        DB: db,
        VECTOR_SEARCH_ENABLED: 'false',
      } as unknown as Env;

      const count = await backfillUnindexedVectors(db, mockEnv);
      expect(count).toBe(0);
    });
  });
});
