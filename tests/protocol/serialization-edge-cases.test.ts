import { describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { computeEventId, serializeEventForId } from '../../src/crypto/canonical';

import {
  parseClientMessage,
  parseRelayMessage,
  MAX_MESSAGE_PAYLOAD_SIZE,
} from '../../src/protocol/parser';
import {
  validateEventStructure,
  validateFilter,
} from '../../src/protocol/validator';
import type { NostrEvent, NostrFilter } from '../../src/types/nostr';

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

describe('Protocol & Serialization Hardening Edge Cases', () => {
  const privKey = secp256k1.utils.randomPrivateKey();

  describe('Payload Size & Frame Limits', () => {
    it('rejects client raw message exceeding MAX_MESSAGE_PAYLOAD_SIZE (64KB)', () => {
      const hugeContent = 'a'.repeat(MAX_MESSAGE_PAYLOAD_SIZE + 100);
      const hugeMessage = JSON.stringify(['REQ', 'sub_1', { search: hugeContent }]);

      const result = parseClientMessage(hugeMessage);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('exceeds maximum allowed size');
      }
    });

    it('rejects relay raw message exceeding MAX_MESSAGE_PAYLOAD_SIZE (64KB)', () => {
      const hugeData = 'x'.repeat(MAX_MESSAGE_PAYLOAD_SIZE + 50);
      const result = parseRelayMessage(hugeData);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('exceeds maximum allowed size');
      }
    });

    it('accepts messages right at or below the 64KB boundary', () => {
      const allowedString = 'b'.repeat(1000);
      const msg = JSON.stringify(['REQ', 'sub_1', { search: allowedString }]);
      const result = parseClientMessage(msg);
      expect(result.ok).toBe(true);
    });
  });

  describe('Event Structure Limits (Tags, Content, Timestamp)', () => {
    const now = Math.floor(Date.now() / 1000);

    it('rejects events with tag count exceeding maxEventTags (100)', () => {
      const tags: string[][] = [];
      for (let i = 0; i < 105; i++) {
        tags.push(['t', `tag_${i}`]);
      }

      const event = createSignedEvent(privKey, {
        kind: 1,
        created_at: now,
        tags,
        content: 'test tags limit',
      });

      const result = validateEventStructure(event);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('exceeds maximum allowed tags count');
      }
    });

    it('rejects events with individual tag element length exceeding maxTagItemLength (1024)', () => {
      const hugeTagValue = 'v'.repeat(1050);
      const event = createSignedEvent(privKey, {
        kind: 1,
        created_at: now,
        tags: [['p', hugeTagValue]],
        content: 'test tag item length limit',
      });

      const result = validateEventStructure(event);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('exceeds maximum length of 1024');
      }
    });

    it('rejects events with content length exceeding maxContentLength (65536)', () => {
      const hugeContent = 'c'.repeat(70000);
      const event = createSignedEvent(privKey, {
        kind: 1,
        created_at: now,
        content: hugeContent,
      });

      const result = validateEventStructure(event);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('exceeds maximum allowed length');
      }
    });

    it('rejects events with created_at timestamp too far in the future (> +900s)', () => {
      const futureTimestamp = now + 1200; // 20 minutes in the future
      const event = createSignedEvent(privKey, {
        kind: 1,
        created_at: futureTimestamp,
        content: 'time traveler note',
      });

      const result = validateEventStructure(event, undefined, now);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain('too far in the future');
      }
    });

    it('accepts events with created_at within acceptable future skew (+300s)', () => {
      const acceptableFuture = now + 300;
      const event = createSignedEvent(privKey, {
        kind: 1,
        created_at: acceptableFuture,
        content: 'acceptable future note',
      });

      const result = validateEventStructure(event, undefined, now);
      expect(result.valid).toBe(true);
    });
  });

  describe('Malformed & Malicious Payloads', () => {
    it('handles null, numbers, booleans, and non-array payloads gracefully', () => {
      expect(parseClientMessage('null').ok).toBe(false);
      expect(parseClientMessage('12345').ok).toBe(false);
      expect(parseClientMessage('true').ok).toBe(false);
      expect(parseClientMessage('{"not":"an array"}').ok).toBe(false);
    });

    it('rejects prototype pollution attempts in filter parsing', () => {
      const maliciousFilterPayload = JSON.stringify([
        'REQ',
        'sub_malicious',
        { __proto__: { admin: true }, kinds: [1] },
      ]);

      const parsed = parseClientMessage(maliciousFilterPayload);
      expect(parsed.ok).toBe(true);
      if (parsed.ok && parsed.value[0] === 'REQ') {
        const filter = parsed.value[2] as NostrFilter;
        expect((Object.prototype as { admin?: boolean }).admin).toBeUndefined();
        expect(filter?.kinds).toEqual([1]);
      }
    });

    it('handles unicode characters and emojis correctly in canonical serialization', () => {
      const unicodeContent = 'Merhaba Nostr! 🚀 🇹🇷 ⚡ Üöçşığ';
      const event = createSignedEvent(privKey, {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        content: unicodeContent,
      });

      const canonical = serializeEventForId(event);
      expect(canonical).toContain('Merhaba Nostr! 🚀 🇹🇷 ⚡ Üöçşığ');

      const recomputedId = computeEventId(event);
      expect(recomputedId).toBe(event.id);
    });

    it('rejects invalid filter tag query structures', () => {
      expect(validateFilter({ '#e': 'not-an-array' }).valid).toBe(false);
      expect(validateFilter({ '#p': [123] }).valid).toBe(false);
      expect(validateFilter({ kinds: [-1] }).valid).toBe(false);
      expect(validateFilter({ since: -10 }).valid).toBe(false);
      expect(validateFilter({ limit: -5 }).valid).toBe(false);
    });
  });
});
