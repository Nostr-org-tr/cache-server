import { describe, expect, it, beforeEach } from 'vitest';
import {
  getEventByIdFromKv,
  getReplaceableEventFromKv,
  metadataWriteDedupCache,
  putEventToKv,
} from '../../src/cache';
import {
  memoryEventIdCache,
  memoryReplaceableCache,
  queryEventsHybrid,
  saveEventsBatch,
} from '../../src/db';
import type { NostrEvent } from '../../src/types/nostr';
import { authorRelaysMemoryCache, resolveAuthorRelaysFromD1 } from '../../src/upstream/nip65';
import { MockD1Database } from '../mocks/mock-d1';
import { MockKVNamespace } from '../mocks/mock-kv';

describe('Repository Batching & Hybrid Query Optimization', () => {
  let mockDb: MockD1Database;
  let mockKv: KVNamespace;

  const author1 = '1111111111111111111111111111111111111111111111111111111111111111';
  const author2 = '2222222222222222222222222222222222222222222222222222222222222222';

  beforeEach(() => {
    mockDb = new MockD1Database();
    mockKv = new MockKVNamespace() as unknown as KVNamespace;
    memoryEventIdCache.clear();
    memoryReplaceableCache.clear();
    metadataWriteDedupCache.clear();
    authorRelaysMemoryCache.clear();
  });

  it('saves batch of events to D1, in-memory cache, and warms KV metadata', async () => {
    const event1: NostrEvent = {
      id: 'event-id-1',
      pubkey: author1,
      created_at: 1700000001,
      kind: 1,
      tags: [['t', 'nostr']],
      content: 'Event 1',
      sig: 'sig1',
    };

    const event2: NostrEvent = {
      id: 'event-id-2',
      pubkey: author2,
      created_at: 1700000002,
      kind: 0,
      tags: [],
      content: JSON.stringify({ name: 'Bob' }),
      sig: 'sig2',
    };

    const ephemeral: NostrEvent = {
      id: 'event-id-eph',
      pubkey: author1,
      created_at: 1700000003,
      kind: 20001,
      tags: [],
      content: 'Typing...',
      sig: 'sigeph',
    };

    const results = await saveEventsBatch(
      mockDb as unknown as D1Database,
      [event1, event2, ephemeral],
      mockKv
    );

    expect(results).toHaveLength(3);
    expect(results[0]?.action).toBe('inserted');
    expect(results[1]?.action).toBe('inserted');
    expect(results[2]?.action).toBe('ignored');

    // Verify D1 records
    expect(mockDb.events.size).toBe(2);

    // Verify in-memory L0 cache
    expect(memoryEventIdCache.get('event-id-1')?.id).toBe('event-id-1');

    // Verify KV metadata cache warming for Kind 0 profile
    const kvProfile = await getReplaceableEventFromKv(mockKv, author2, 0);
    expect(kvProfile).not.toBeNull();
    expect(kvProfile?.content).toContain('Bob');
  });

  it('serves point lookups by ID from L1 KV without hitting D1', async () => {
    const eventInKv: NostrEvent = {
      id: 'event-fast-id',
      pubkey: author1,
      created_at: 1700000050,
      kind: 1,
      tags: [],
      content: 'Fast edge cached',
      sig: 'sigfast',
    };

    await putEventToKv(mockKv, eventInKv);

    // Query via queryEventsHybrid
    const results = await queryEventsHybrid(
      mockDb as unknown as D1Database,
      mockKv,
      [{ ids: ['event-fast-id'] }]
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('event-fast-id');
    expect(results[0]?.content).toBe('Fast edge cached');
  });

  it('falls back to D1 on cache miss and warms in-memory L0 cache', async () => {
    const eventInD1: NostrEvent = {
      id: 'event-in-d1',
      pubkey: author1,
      created_at: 1700000060,
      kind: 1,
      tags: [],
      content: 'From D1 store',
      sig: 'sigd1',
    };

    // Save directly to D1 only
    await saveEventsBatch(mockDb as unknown as D1Database, [eventInD1]);

    // Clear caches to simulate cold start
    memoryEventIdCache.clear();
    (mockKv as unknown as MockKVNamespace).clear();
    expect(await getEventByIdFromKv(mockKv, 'event-in-d1')).toBeNull();

    // Query via queryEventsHybrid
    const results = await queryEventsHybrid(
      mockDb as unknown as D1Database,
      mockKv,
      [{ ids: ['event-in-d1'] }]
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('event-in-d1');

    // Verify in-memory cache is now warmed
    expect(memoryEventIdCache.get('event-in-d1')?.id).toBe('event-in-d1');
  });

  it('serves Kind 0 profile lookups from KV and falls back to D1', async () => {
    const profileEvent: NostrEvent = {
      id: 'profile-pubkey1',
      pubkey: author1,
      created_at: 1700000070,
      kind: 0,
      tags: [],
      content: JSON.stringify({ name: 'Charlie' }),
      sig: 'sigprofile',
    };

    await saveEventsBatch(mockDb as unknown as D1Database, [profileEvent]);
    memoryEventIdCache.clear();
    memoryReplaceableCache.clear();
    (mockKv as unknown as MockKVNamespace).clear();

    const results = await queryEventsHybrid(
      mockDb as unknown as D1Database,
      mockKv,
      [{ authors: [author1], kinds: [0] }]
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('profile-pubkey1');
  });

  it('resolves author relays from KV and populates KV from D1', async () => {
    const relayEvent: NostrEvent = {
      id: 'relay-event-1',
      pubkey: author1,
      created_at: 1700000080,
      kind: 10002,
      tags: [['r', 'wss://relay.nostr.org.tr', 'write']],
      content: '',
      sig: 'sigrelay',
    };

    await saveEventsBatch(mockDb as unknown as D1Database, [relayEvent]);
    authorRelaysMemoryCache.clear();
    (mockKv as unknown as MockKVNamespace).clear();

    // First resolution: reads D1 and warms KV
    const relaysFirst = await resolveAuthorRelaysFromD1(
      mockDb as unknown as D1Database,
      [author1],
      undefined,
      mockKv
    );

    expect(relaysFirst).toEqual(['wss://relay.nostr.org.tr']);

    // Second resolution: should hit in-memory / KV directly
    const relaysSecond = await resolveAuthorRelaysFromD1(
      mockDb as unknown as D1Database,
      [author1],
      undefined,
      mockKv
    );

    expect(relaysSecond).toEqual(['wss://relay.nostr.org.tr']);
  });
});
