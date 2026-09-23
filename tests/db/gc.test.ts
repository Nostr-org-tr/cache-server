import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GC_TIERS,
  pruneEntireCache,
  pruneTierBatch,
  runGarbageCollection,
  scanAndPurgeModeratedEvents,
  type GCTierConfig,
} from '../../src/db/gc';
import { saveEvent } from '../../src/db/repository';
import type { NostrEvent } from '../../src/types/nostr';
import { MockD1Database } from '../mocks/mock-d1';

const MOCK_PUBKEY_1 = '46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a';
const MOCK_PUBKEY_2 = '1111111111111111111111111111111111111111111111111111111111111111';

function createMockEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const id = overrides.id ?? 'a'.repeat(64);
  return {
    id,
    pubkey: overrides.pubkey ?? MOCK_PUBKEY_1,
    created_at: overrides.created_at ?? 1700000000,
    kind: overrides.kind ?? 1,
    tags: overrides.tags ?? [['t', 'nostr']],
    content: overrides.content ?? 'test content',
    sig: overrides.sig ?? 's'.repeat(128),
  };
}

describe('Rolling Expiration Garbage Collection Engine', () => {
  it('prunes feed events older than 7 days while preserving recent ones', async () => {
    const db = new MockD1Database();
    const now = 1710000000;
    const eightDaysAgo = now - 8 * 86400;
    const threeDaysAgo = now - 3 * 86400;

    // Insert old feed note (kind 1)
    const oldFeedEvent = createMockEvent({
      id: '0'.repeat(64),
      kind: 1,
      created_at: eightDaysAgo,
      tags: [['t', 'old_tag']],
    });
    await saveEvent(db, oldFeedEvent);
    // Overwrite created_at_recorded to simulate historical recorded time
    db.events.get(oldFeedEvent.id)!.created_at_recorded = eightDaysAgo;

    // Insert recent feed note (kind 1)
    const recentFeedEvent = createMockEvent({
      id: '1'.repeat(64),
      kind: 1,
      created_at: threeDaysAgo,
      tags: [['t', 'recent_tag']],
    });
    await saveEvent(db, recentFeedEvent);
    db.events.get(recentFeedEvent.id)!.created_at_recorded = threeDaysAgo;

    // Insert old profile metadata (kind 0)
    const profileEvent = createMockEvent({
      id: '2'.repeat(64),
      kind: 0,
      created_at: eightDaysAgo,
      tags: [],
      content: JSON.stringify({ name: 'alice' }),
    });
    await saveEvent(db, profileEvent);
    db.events.get(profileEvent.id)!.created_at_recorded = eightDaysAgo;

    expect(db.events.size).toBe(3);
    expect(db.eventTags.length).toBe(2);

    const feedTier: GCTierConfig = {
      name: 'feed_events',
      kinds: [1, 6, 7, 9735],
      ttlSeconds: 7 * 86400,
    };

    const cutoff = now - feedTier.ttlSeconds;
    const pruned = await pruneTierBatch(db, feedTier, cutoff, 100);

    expect(pruned).toBe(1);
    expect(db.events.has(oldFeedEvent.id)).toBe(false);
    expect(db.events.has(recentFeedEvent.id)).toBe(true);
    expect(db.events.has(profileEvent.id)).toBe(true);

    // Verify cascaded event_tags deletion
    const remainingTags = db.eventTags.map((t) => t.tag_value);
    expect(remainingTags).toContain('recent_tag');
    expect(remainingTags).not.toContain('old_tag');
  });

  it('runs full multi-tiered garbage collection cycle correctly', async () => {
    const db = new MockD1Database();
    const now = 1720000000;

    // 1. Old Feed Note (kind 1, recorded 10 days ago) -> MUST BE PRUNED
    const ev1 = createMockEvent({ id: 'a'.repeat(64), kind: 1 });
    await saveEvent(db, ev1);
    db.events.get(ev1.id)!.created_at_recorded = now - 10 * 86400;

    // 2. Recent Feed Note (kind 1, recorded 2 days ago) -> MUST BE PRESERVED
    const ev2 = createMockEvent({ id: 'b'.repeat(64), kind: 1 });
    await saveEvent(db, ev2);
    db.events.get(ev2.id)!.created_at_recorded = now - 2 * 86400;

    // 3. Old Article (kind 30023, recorded 40 days ago) -> MUST BE PRUNED (30d TTL)
    const ev3 = createMockEvent({
      id: 'c'.repeat(64),
      kind: 30023,
      tags: [['d', 'article-1']],
    });
    await saveEvent(db, ev3);
    db.events.get(ev3.id)!.created_at_recorded = now - 40 * 86400;

    // 4. Active Article (kind 30023, recorded 15 days ago) -> MUST BE PRESERVED (30d TTL)
    const ev4 = createMockEvent({
      id: 'd'.repeat(64),
      kind: 30023,
      tags: [['d', 'article-2']],
    });
    await saveEvent(db, ev4);
    db.events.get(ev4.id)!.created_at_recorded = now - 15 * 86400;

    // 5. Active Profile (kind 0, recorded 60 days ago) -> MUST BE PRESERVED (180d TTL)
    const ev5 = createMockEvent({ id: 'e'.repeat(64), kind: 0 });
    await saveEvent(db, ev5);
    db.events.get(ev5.id)!.created_at_recorded = now - 60 * 86400;

    // 6. Stale Profile (kind 0, recorded 200 days ago) -> MUST BE PRUNED (180d TTL)
    const ev6 = createMockEvent({
      id: 'f'.repeat(64),
      pubkey: MOCK_PUBKEY_2,
      kind: 0,
    });
    await saveEvent(db, ev6);
    db.events.get(ev6.id)!.created_at_recorded = now - 200 * 86400;

    expect(db.events.size).toBe(6);

    const result = await runGarbageCollection(db, { nowSeconds: now });

    expect(result.totalPruned).toBe(3); // ev1, ev3, ev6
    expect(result.breakdown.feed_events).toBe(1);
    expect(result.breakdown.parameterized_replaceable).toBe(1);
    expect(result.breakdown.user_state_and_lists).toBe(1);

    expect(db.events.has(ev1.id)).toBe(false);
    expect(db.events.has(ev2.id)).toBe(true);
    expect(db.events.has(ev3.id)).toBe(false);
    expect(db.events.has(ev4.id)).toBe(true);
    expect(db.events.has(ev5.id)).toBe(true);
    expect(db.events.has(ev6.id)).toBe(false);
  });

  it('handles multi-batch iterations when prunable events exceed single batchSize', async () => {
    const db = new MockD1Database();
    const now = 1710000000;
    const oldTimestamp = now - 10 * 86400;

    // Insert 15 old feed events
    for (let i = 0; i < 15; i++) {
      const hexIndex = i.toString(16).padStart(2, '0');
      const id = hexIndex.repeat(32);
      const ev = createMockEvent({ id, kind: 1 });
      await saveEvent(db, ev);
      db.events.get(id)!.created_at_recorded = oldTimestamp;
    }

    expect(db.events.size).toBe(15);

    // Run GC with batchSize = 5 and maxBatchesPerTier = 5
    const result = await runGarbageCollection(db, {
      nowSeconds: now,
      batchSize: 5,
      maxBatchesPerTier: 5,
      customTiers: [
        {
          name: 'feed_events',
          kinds: [1],
          ttlSeconds: 7 * 86400,
        },
      ],
    });

    expect(result.totalPruned).toBe(15);
    expect(result.breakdown.feed_events).toBe(15);
    expect(db.events.size).toBe(0);
  });

  it('exports valid default GC tier configuration', () => {
    expect(DEFAULT_GC_TIERS.length).toBeGreaterThan(0);
    for (const tier of DEFAULT_GC_TIERS) {
      expect(tier.name).toBeDefined();
      expect(tier.ttlSeconds).toBeGreaterThan(0);
    }
  });

  describe('pruneEntireCache()', () => {
    it('purges all cache while preserving operator events when preserveOperator is true', async () => {
      const db = new MockD1Database();

      const operatorEvent = createMockEvent({
        id: 'op1'.padEnd(64, '0'),
        pubkey: MOCK_PUBKEY_1,
        kind: 0,
        content: JSON.stringify({ name: 'operator' }),
      });
      await saveEvent(db, operatorEvent);

      const userEvent1 = createMockEvent({
        id: 'user1'.padEnd(64, '0'),
        pubkey: MOCK_PUBKEY_2,
        kind: 1,
        content: 'User feed note',
      });
      await saveEvent(db, userEvent1);

      const userEvent2 = createMockEvent({
        id: 'user2'.padEnd(64, '0'),
        pubkey: MOCK_PUBKEY_2,
        kind: 1,
        content: 'User second note',
      });
      await saveEvent(db, userEvent2);

      expect(db.events.size).toBe(3);

      const result = await pruneEntireCache(db, undefined, undefined, {
        preserveOperator: true,
        operatorPubkey: MOCK_PUBKEY_1,
      });

      expect(result.purgedEvents).toBe(2);
      expect(result.preservedOperatorEvents).toBe(1);
      expect(db.events.has(operatorEvent.id)).toBe(true);
      expect(db.events.has(userEvent1.id)).toBe(false);
      expect(db.events.has(userEvent2.id)).toBe(false);
    });

    it('performs full blank-slate wipe when preserveOperator is false', async () => {
      const db = new MockD1Database();

      const ev1 = createMockEvent({ id: '11'.repeat(32), pubkey: MOCK_PUBKEY_1 });
      const ev2 = createMockEvent({ id: '22'.repeat(32), pubkey: MOCK_PUBKEY_2 });
      await saveEvent(db, ev1);
      await saveEvent(db, ev2);

      expect(db.events.size).toBe(2);

      const result = await pruneEntireCache(db, undefined, undefined, {
        preserveOperator: false,
      });

      expect(result.purgedEvents).toBe(2);
      expect(db.events.size).toBe(0);
      expect(db.eventTags.length).toBe(0);
    });
  });

  describe('scanAndPurgeModeratedEvents()', () => {
    it('retroactively removes existing sensitive and muted events from database', async () => {
      const db = new MockD1Database();

      const cleanEvent = createMockEvent({
        id: 'clean'.padEnd(64, '0'),
        pubkey: MOCK_PUBKEY_2,
        kind: 1,
        content: 'Clean post',
        tags: [],
      });
      await saveEvent(db, cleanEvent);

      // Force insert an older sensitive event with content-warning tag
      const sensitiveEvent = createMockEvent({
        id: 'sensitive'.padEnd(64, '0'),
        pubkey: MOCK_PUBKEY_2,
        kind: 1,
        content: 'NSFW post',
        tags: [['content-warning', 'nsfw']],
      });
      db.events.set(sensitiveEvent.id, {
        id: sensitiveEvent.id,
        pubkey: sensitiveEvent.pubkey,
        created_at: sensitiveEvent.created_at,
        kind: sensitiveEvent.kind,
        d_tag: null,
        raw_event: JSON.stringify(sensitiveEvent),
        created_at_recorded: 1700000000,
      });

      expect(db.events.size).toBe(2);

      const result = await scanAndPurgeModeratedEvents(db, undefined, undefined, MOCK_PUBKEY_1);

      expect(result.scannedCount).toBe(2);
      expect(result.purgedCount).toBe(1);
      expect(db.events.has(cleanEvent.id)).toBe(true);
      expect(db.events.has(sensitiveEvent.id)).toBe(false);
    });
  });
});
