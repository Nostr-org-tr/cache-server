import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_KV_TTL_SECONDS,
  MAX_KV_TTL_SECONDS,
  MIN_KV_TTL_SECONDS,
  deleteEventFromKv,
  getAuthorRelaysFromKv,
  getEventByIdFromKv,
  getEventsByIdsFromKv,
  getReplaceableEventFromKv,
  putAuthorRelaysToKv,
  putEventToKv,
  sanitizeKvTtl,
} from '../../src/cache';
import type { NostrEvent } from '../../src/types/nostr';
import { MockKVNamespace } from '../mocks/mock-kv';

describe('KV Cache Module (L1 Cache)', () => {
  let mockKv: KVNamespace;

  const samplePubkey = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  const sampleEventId = '1111111111111111111111111111111111111111111111111111111111111111';

  beforeEach(() => {
    mockKv = new MockKVNamespace() as unknown as KVNamespace;
  });

  describe('TTL Enforcement', () => {
    it('defaults to 7200 seconds (2 hours)', () => {
      expect(DEFAULT_KV_TTL_SECONDS).toBe(7200);
      expect(MAX_KV_TTL_SECONDS).toBe(7200);
      expect(MIN_KV_TTL_SECONDS).toBe(60);
      expect(sanitizeKvTtl()).toBe(7200);
    });

    it('caps TTL at MAX_KV_TTL_SECONDS (7200s)', () => {
      expect(sanitizeKvTtl(100000)).toBe(7200);
      expect(sanitizeKvTtl(8000)).toBe(7200);
    });

    it('floors TTL at MIN_KV_TTL_SECONDS (60s)', () => {
      expect(sanitizeKvTtl(10)).toBe(60);
      expect(sanitizeKvTtl(-5)).toBe(60);
    });

    it('handles NaN/undefined safely', () => {
      expect(sanitizeKvTtl(Number.NaN)).toBe(7200);
      expect(sanitizeKvTtl(undefined)).toBe(7200);
    });
  });

  describe('Event Storage & Retrieval by ID', () => {
    const regularEvent: NostrEvent = {
      id: sampleEventId,
      pubkey: samplePubkey,
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: 'Hello Nostr cache via KV!',
      sig: 'abcdef123456',
    };

    it('saves and retrieves event by ID', async () => {
      await putEventToKv(mockKv, regularEvent);
      const retrieved = await getEventByIdFromKv(mockKv, sampleEventId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(sampleEventId);
      expect(retrieved?.content).toBe('Hello Nostr cache via KV!');
    });

    it('returns null for missing event ID', async () => {
      const retrieved = await getEventByIdFromKv(mockKv, 'nonexistent');
      expect(retrieved).toBeNull();
    });

    it('fetches multiple events by IDs returning hits and misses', async () => {
      await putEventToKv(mockKv, regularEvent);

      const result = await getEventsByIdsFromKv(mockKv, [
        sampleEventId,
        '2222222222222222222222222222222222222222222222222222222222222222',
      ]);

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.id).toBe(sampleEventId);
      expect(result.misses).toHaveLength(1);
      expect(result.misses[0]).toBe('2222222222222222222222222222222222222222222222222222222222222222');
    });

    it('never stores ephemeral events (kinds 20000..29999) into KV', async () => {
      const ephemeralEvent: NostrEvent = {
        id: 'ephemeral111',
        pubkey: samplePubkey,
        created_at: 1700000000,
        kind: 20001,
        tags: [],
        content: 'Ephemeral typing notification',
        sig: 'sig',
      };

      await putEventToKv(mockKv, ephemeralEvent);
      const retrieved = await getEventByIdFromKv(mockKv, 'ephemeral111');
      expect(retrieved).toBeNull();
      expect((mockKv as unknown as MockKVNamespace).size()).toBe(0);
    });
  });

  describe('Replaceable Events (Kind 0 Profile, Kind 10002 Relays)', () => {
    it('caches and retrieves Kind 0 metadata profile', async () => {
      const profileEvent: NostrEvent = {
        id: 'profile-id-1',
        pubkey: samplePubkey,
        created_at: 1700000000,
        kind: 0,
        tags: [],
        content: JSON.stringify({ name: 'alice', about: 'Nostr enthusiast' }),
        sig: 'sig',
      };

      await putEventToKv(mockKv, profileEvent);

      const retrieved = await getReplaceableEventFromKv(mockKv, samplePubkey, 0);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe('profile-id-1');
      expect(retrieved?.content).toContain('alice');
    });

    it('caches and retrieves Kind 10002 relay lists', async () => {
      const relayEvent: NostrEvent = {
        id: 'relay-id-1',
        pubkey: samplePubkey,
        created_at: 1700000000,
        kind: 10002,
        tags: [
          ['r', 'wss://relay.damus.io', 'write'],
          ['r', 'wss://nos.lol', 'read'],
          ['r', 'wss://relay.primal.net'],
        ],
        content: '',
        sig: 'sig',
      };

      await putEventToKv(mockKv, relayEvent);

      const relays = await getAuthorRelaysFromKv(mockKv, samplePubkey);
      expect(relays).not.toBeNull();
      // Should contain write and unconstrained relays
      expect(relays).toContain('wss://relay.damus.io');
      expect(relays).toContain('wss://relay.primal.net');
      expect(relays).not.toContain('wss://nos.lol');
    });

    it('allows direct writing and retrieval of author relays', async () => {
      await putAuthorRelaysToKv(mockKv, samplePubkey, ['wss://relay.nostr.org.tr']);
      const relays = await getAuthorRelaysFromKv(mockKv, samplePubkey);
      expect(relays).toEqual(['wss://relay.nostr.org.tr']);
    });

    it('caches and retrieves parameterized replaceable event (Kind 30023)', async () => {
      const paramEvent: NostrEvent = {
        id: 'param-id-1',
        pubkey: samplePubkey,
        created_at: 1700000000,
        kind: 30023,
        tags: [['d', 'article-1']],
        content: 'Long form article',
        sig: 'sig',
      };

      await putEventToKv(mockKv, paramEvent);

      const retrieved = await getReplaceableEventFromKv(mockKv, samplePubkey, 30023, 'article-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe('param-id-1');
    });
  });

  describe('Deletion Handling (NIP-09)', () => {
    it('deletes event by ID and replaceable keys', async () => {
      const profileEvent: NostrEvent = {
        id: 'profile-id-del',
        pubkey: samplePubkey,
        created_at: 1700000000,
        kind: 0,
        tags: [],
        content: 'profile',
        sig: 'sig',
      };

      await putEventToKv(mockKv, profileEvent);
      expect(await getEventByIdFromKv(mockKv, 'profile-id-del')).not.toBeNull();
      expect(await getReplaceableEventFromKv(mockKv, samplePubkey, 0)).not.toBeNull();

      await deleteEventFromKv(mockKv, 'profile-id-del', samplePubkey, 0);

      expect(await getEventByIdFromKv(mockKv, 'profile-id-del')).toBeNull();
      expect(await getReplaceableEventFromKv(mockKv, samplePubkey, 0)).toBeNull();
    });
  });
});
