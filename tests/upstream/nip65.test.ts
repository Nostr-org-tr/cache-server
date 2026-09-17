import { describe, expect, it } from 'vitest';
import {
  extractRelayHintsFromFilters,
  extractRelaysFromKind10002,
  resolveAuthorRelaysFromD1,
} from '../../src/upstream/nip65';
import type { NostrEvent } from '../../src/types/nostr';
import { MockD1Database } from '../mocks/mock-d1';

describe('NIP-65 & Tag Relay Resolver', () => {
  const dummyPubkey = 'a'.repeat(64);

  describe('extractRelaysFromKind10002', () => {
    it('extracts write relays correctly from kind 10002 event', () => {
      const event: NostrEvent = {
        id: '1'.repeat(64),
        pubkey: dummyPubkey,
        created_at: 1000,
        kind: 10002,
        tags: [
          ['r', 'wss://relay.damus.io', 'write'],
          ['r', 'wss://nos.lol', 'read'],
          ['r', 'wss://relay.nostr.band'], // unconstrained -> write and read
          ['r', 'wss://127.0.0.1', 'write'], // SSRF private IP
          ['invalid_tag'],
        ],
        content: '',
        sig: 's'.repeat(128),
      };

      const writeRelays = extractRelaysFromKind10002(event, 'write');
      expect(writeRelays).toEqual([
        'wss://relay.damus.io',
        'wss://relay.nostr.band',
      ]);

      const readRelays = extractRelaysFromKind10002(event, 'read');
      expect(readRelays).toEqual([
        'wss://nos.lol',
        'wss://relay.nostr.band',
      ]);

      const allRelays = extractRelaysFromKind10002(event, 'all');
      expect(allRelays).toEqual([
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.nostr.band',
      ]);
    });

    it('returns empty array if kind is not 10002', () => {
      const event: NostrEvent = {
        id: '1'.repeat(64),
        pubkey: dummyPubkey,
        created_at: 1000,
        kind: 1,
        tags: [['r', 'wss://relay.damus.io']],
        content: 'test',
        sig: 's'.repeat(128),
      };

      expect(extractRelaysFromKind10002(event)).toEqual([]);
    });
  });

  describe('resolveAuthorRelaysFromD1', () => {
    it('returns author write relays from cached kind 10002 events in D1', async () => {
      const mockDb = new MockD1Database();

      const authorEvent: NostrEvent = {
        id: '1'.repeat(64),
        pubkey: dummyPubkey,
        created_at: 1000,
        kind: 10002,
        tags: [
          ['r', 'wss://author.relay.one', 'write'],
          ['r', 'wss://author.relay.two'],
        ],
        content: '',
        sig: 's'.repeat(128),
      };

      mockDb.events.set(authorEvent.id, {
        id: authorEvent.id,
        pubkey: authorEvent.pubkey,
        created_at: authorEvent.created_at,
        kind: authorEvent.kind,
        d_tag: null,
        raw_event: JSON.stringify(authorEvent),
        created_at_recorded: 1000,
      });

      const relays = await resolveAuthorRelaysFromD1(
        mockDb as unknown as D1Database,
        [dummyPubkey]
      );

      expect(relays).toEqual([
        'wss://author.relay.one',
        'wss://author.relay.two',
      ]);
    });

    it('returns empty array if author has no cached kind 10002 event', async () => {
      const mockDb = new MockD1Database();
      const relays = await resolveAuthorRelaysFromD1(
        mockDb as unknown as D1Database,
        [dummyPubkey]
      );
      expect(relays).toEqual([]);
    });

    it('safely chunks queries when provided with >50 author pubkeys', async () => {
      const mockDb = new MockD1Database();
      const targetPubkey = 'f'.repeat(64);
      const manyAuthors = Array.from({ length: 120 }, (_, i) => `${i.toString(16).padStart(2, '0')}${'a'.repeat(62)}`);
      manyAuthors.push(targetPubkey);

      const authorEvent: NostrEvent = {
        id: '2'.repeat(64),
        pubkey: targetPubkey,
        created_at: 1000,
        kind: 10002,
        tags: [['r', 'wss://relay.chunked.test', 'write']],
        content: '',
        sig: 's'.repeat(128),
      };

      mockDb.events.set(authorEvent.id, {
        id: authorEvent.id,
        pubkey: authorEvent.pubkey,
        created_at: authorEvent.created_at,
        kind: authorEvent.kind,
        d_tag: null,
        raw_event: JSON.stringify(authorEvent),
        created_at_recorded: 1000,
      });

      const relays = await resolveAuthorRelaysFromD1(
        mockDb as unknown as D1Database,
        manyAuthors
      );

      expect(relays).toContain('wss://relay.chunked.test');
    });
  });

  describe('extractRelayHintsFromFilters', () => {
    it('extracts relay hints from #r filter tags', () => {
      const filters = [
        { kinds: [1], '#r': ['wss://relay.damus.io', 'wss://127.0.0.1'] },
        { kinds: [0] },
      ];

      const hints = extractRelayHintsFromFilters(filters);
      expect(hints).toEqual(['wss://relay.damus.io']);
    });
  });
});
