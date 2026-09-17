import { beforeEach, describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { computeEventId } from '../../src/crypto/canonical';
import { classifyEventKind } from '../../src/db/classifier';
import { queryEvents, saveEvent } from '../../src/db/repository';
import type { NostrEvent } from '../../src/types/nostr';
import { MockD1Database } from '../mocks/mock-d1';

function createSignedEvent(
  privKey: Uint8Array,
  params: {
    kind: number;
    created_at: number;
    tags?: string[][];
    content: string;
  }
): NostrEvent {
  const pubkeyHex = bytesToHex(schnorr.getPublicKey(privKey));
  const tags = params.tags ?? [];
  const eventIdHex = computeEventId({
    pubkey: pubkeyHex,
    created_at: params.created_at,
    kind: params.kind,
    tags,
    content: params.content,
  });

  const sigHex = bytesToHex(schnorr.sign(eventIdHex, privKey));

  return {
    id: eventIdHex,
    pubkey: pubkeyHex,
    created_at: params.created_at,
    kind: params.kind,
    tags,
    content: params.content,
    sig: sigHex,
  };
}

describe('Event Storage, Replacement Precedence & Deletion Matrix', () => {
  let mockDb: MockD1Database;
  let db: D1Database;
  let privKeyA: Uint8Array;
  let pubkeyA: string;
  let privKeyB: Uint8Array;
  let pubkeyB: string;

  beforeEach(() => {
    mockDb = new MockD1Database();
    db = mockDb as unknown as D1Database;

    privKeyA = secp256k1.utils.randomPrivateKey();
    pubkeyA = bytesToHex(schnorr.getPublicKey(privKeyA));

    privKeyB = secp256k1.utils.randomPrivateKey();
    pubkeyB = bytesToHex(schnorr.getPublicKey(privKeyB));
  });

  describe('Classification Matrix', () => {
    it('accurately classifies event types per NIP-01, NIP-16, NIP-33', () => {
      expect(classifyEventKind(1)).toBe('REGULAR');
      expect(classifyEventKind(7)).toBe('REGULAR');

      expect(classifyEventKind(0)).toBe('REPLACEABLE');
      expect(classifyEventKind(3)).toBe('REPLACEABLE');
      expect(classifyEventKind(10002)).toBe('REPLACEABLE');

      expect(classifyEventKind(20000)).toBe('EPHEMERAL');
      expect(classifyEventKind(29999)).toBe('EPHEMERAL');

      expect(classifyEventKind(30000)).toBe('PARAMETERIZED_REPLACEABLE');
      expect(classifyEventKind(30023)).toBe('PARAMETERIZED_REPLACEABLE');

      expect(classifyEventKind(5)).toBe('DELETION');
    });
  });

  describe('Replaceable Events Precedence (Kind 0, 3, 10000-19999)', () => {
    it('replaces an older event with a newer timestamp', async () => {
      const oldEvent = createSignedEvent(privKeyA, {
        kind: 0,
        created_at: 1700000000,
        content: JSON.stringify({ name: 'Old Profile' }),
      });

      const newEvent = createSignedEvent(privKeyA, {
        kind: 0,
        created_at: 1700001000,
        content: JSON.stringify({ name: 'New Profile' }),
      });

      await saveEvent(db, oldEvent);
      let results = await queryEvents(db, [{ kinds: [0], authors: [pubkeyA] }]);
      expect(results.length).toBe(1);
      expect(results[0]?.content).toContain('Old Profile');

      // Ingest newer event
      await saveEvent(db, newEvent);
      results = await queryEvents(db, [{ kinds: [0], authors: [pubkeyA] }]);
      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe(newEvent.id);
      expect(results[0]?.content).toContain('New Profile');
    });

    it('ignores an older event when a newer event is already stored', async () => {
      const newerEvent = createSignedEvent(privKeyA, {
        kind: 3,
        created_at: 1700002000,
        tags: [['p', pubkeyB]],
        content: '',
      });

      const olderEvent = createSignedEvent(privKeyA, {
        kind: 3,
        created_at: 1700001000,
        tags: [],
        content: '',
      });

      await saveEvent(db, newerEvent);
      // Attempt to save older event
      await saveEvent(db, olderEvent);

      const results = await queryEvents(db, [{ kinds: [3], authors: [pubkeyA] }]);
      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe(newerEvent.id);
      expect(results[0]?.created_at).toBe(1700002000);
    });

    it('breaks ties on identical timestamps by retaining lowest lexicographical SHA-256 ID', async () => {
      // Create two events with exact same created_at
      const timestamp = 1700000000;
      const event1 = createSignedEvent(privKeyA, {
        kind: 10002,
        created_at: timestamp,
        content: 'relay list A',
      });
      const event2 = createSignedEvent(privKeyA, {
        kind: 10002,
        created_at: timestamp,
        content: 'relay list B',
      });

      const [winner, loser] =
        event1.id < event2.id ? [event1, event2] : [event2, event1];

      // Save loser first, then winner -> winner should replace
      await saveEvent(db, loser);
      await saveEvent(db, winner);

      let results = await queryEvents(db, [{ kinds: [10002], authors: [pubkeyA] }]);
      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe(winner.id);

      // Try saving loser again -> winner must remain
      await saveEvent(db, loser);
      results = await queryEvents(db, [{ kinds: [10002], authors: [pubkeyA] }]);
      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe(winner.id);
    });
  });

  describe('Parameterized Replaceable Events Precedence (Kinds 30000-39999)', () => {
    it('isolates different d_tag values under the same author and kind', async () => {
      const article1 = createSignedEvent(privKeyA, {
        kind: 30023,
        created_at: 1700001000,
        tags: [['d', 'article-1'], ['title', 'Article 1']],
        content: 'Content 1',
      });

      const article2 = createSignedEvent(privKeyA, {
        kind: 30023,
        created_at: 1700001000,
        tags: [['d', 'article-2'], ['title', 'Article 2']],
        content: 'Content 2',
      });

      await saveEvent(db, article1);
      await saveEvent(db, article2);

      const results = await queryEvents(db, [{ kinds: [30023], authors: [pubkeyA] }]);
      expect(results.length).toBe(2);

      const queriedArticle1 = await queryEvents(db, [
        { kinds: [30023], authors: [pubkeyA], '#d': ['article-1'] },
      ]);
      expect(queriedArticle1.length).toBe(1);
      expect(queriedArticle1[0]?.id).toBe(article1.id);
    });

    it('defaults d_tag to empty string if missing and replaces correctly', async () => {
      const noDTag1 = createSignedEvent(privKeyA, {
        kind: 30000,
        created_at: 1700001000,
        tags: [],
        content: 'first version',
      });

      const noDTag2 = createSignedEvent(privKeyA, {
        kind: 30000,
        created_at: 1700002000,
        tags: [],
        content: 'second version',
      });

      await saveEvent(db, noDTag1);
      await saveEvent(db, noDTag2);

      const results = await queryEvents(db, [{ kinds: [30000], authors: [pubkeyA] }]);
      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe(noDTag2.id);
      expect(results[0]?.content).toBe('second version');
    });
  });

  describe('NIP-09 Event Deletion (Kind 5)', () => {
    it('author can delete their own previously published events', async () => {
      const note = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1700000000,
        content: 'note to be deleted',
      });

      await saveEvent(db, note);
      expect((await queryEvents(db, [{ ids: [note.id] }])).length).toBe(1);

      // Author publishes kind 5 deletion referencing the note ID
      const deletionEvent = createSignedEvent(privKeyA, {
        kind: 5,
        created_at: 1700000500,
        tags: [['e', note.id]],
        content: 'deleted by author',
      });

      await saveEvent(db, deletionEvent);

      // Note should now be deleted from D1
      const queried = await queryEvents(db, [{ ids: [note.id] }]);
      expect(queried.length).toBe(0);
    });

    it('unauthorized user cannot delete another author events', async () => {
      const noteByA = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1700000000,
        content: 'author A note',
      });

      await saveEvent(db, noteByA);

      // User B attempts to delete author A's note
      const maliciousDeletion = createSignedEvent(privKeyB, {
        kind: 5,
        created_at: 1700000500,
        tags: [['e', noteByA.id]],
        content: 'unauthorized delete attempt',
      });

      await saveEvent(db, maliciousDeletion);

      // Note by A must remain intact
      const queried = await queryEvents(db, [{ ids: [noteByA.id] }]);
      expect(queried.length).toBe(1);
      expect(queried[0]?.id).toBe(noteByA.id);
    });
  });
});
