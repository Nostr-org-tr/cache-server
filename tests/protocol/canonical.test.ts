import { describe, it, expect } from 'vitest';
import { serializeEventForId, computeEventId } from '../../src/crypto/canonical';
import type { NostrEvent } from '../../src/types/nostr';

describe('NIP-01 Canonical Event Serialization and SHA-256 Event ID', () => {
  it('correctly serializes a Nostr event to canonical JSON array string', () => {
    const event: NostrEvent = {
      id: '',
      pubkey: 'd7dd5eb3ab747e16f8d0212d53032ea2a7cadef53837e5a6c6614284da0717ec',
      created_at: 1617932115,
      kind: 1,
      tags: [],
      content: 'Hello world',
      sig: '',
    };

    const serialized = serializeEventForId(event);
    expect(serialized).toBe(
      '[0,"d7dd5eb3ab747e16f8d0212d53032ea2a7cadef53837e5a6c6614284da0717ec",1617932115,1,[],"Hello world"]'
    );
  });

  it('computes expected SHA-256 hash ID for event', () => {
    const event: NostrEvent = {
      id: '',
      pubkey: 'd7dd5eb3ab747e16f8d0212d53032ea2a7cadef53837e5a6c6614284da0717ec',
      created_at: 1617932115,
      kind: 1,
      tags: [['e', 'a647d6e7a2b3780d0d4638d3ca233a7893a741362095f3a0937a0701048b26f5']],
      content: 'reply message',
      sig: '',
    };

    const computedId = computeEventId(event);
    expect(computedId).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(computedId)).toBe(true);
  });

  it('preserves UTF-8 and unicode characters in serialization', () => {
    const event: NostrEvent = {
      id: '',
      pubkey: 'a'.repeat(64),
      created_at: 1700000000,
      kind: 1,
      tags: [['t', 'nostr_türkiye']],
      content: 'Nostr Türkiye topluluğu ⚡️',
      sig: '',
    };

    const serialized = serializeEventForId(event);
    expect(serialized).toContain('Nostr Türkiye topluluğu ⚡️');
    const computedId = computeEventId(event);
    expect(computedId).toHaveLength(64);
  });
});
