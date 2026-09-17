import { describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { computeEventId } from '../../src/crypto/canonical';
import { verifyEventCrypto } from '../../src/crypto/validator';
import type { NostrEvent } from '../../src/types/nostr';

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

describe('Cryptographic Verification Edge Cases (BIP-340 & SHA-256)', () => {
  const privKeyA = secp256k1.utils.randomPrivateKey();
  const privKeyB = secp256k1.utils.randomPrivateKey();

  it('verifies a genuine, perfectly signed event across multiple kinds', () => {
    const kinds = [0, 1, 3, 5, 10002, 20000, 30000];
    for (const kind of kinds) {
      const event = createSignedEvent(privKeyA, {
        kind,
        created_at: 1700000000 + kind,
        tags: [['p', '0000000000000000000000000000000000000000000000000000000000000001']],
        content: `testing genuine crypto for kind ${kind}`,
      });

      const res = verifyEventCrypto(event);
      expect(res.valid).toBe(true);
    }
  });

  it('rejects an event when even a single bit in the event id is tampered', () => {
    const event = createSignedEvent(privKeyA, {
      kind: 1,
      created_at: 1700000000,
      content: 'genuine payload',
    });

    // Flip last hex character
    const lastChar = event.id.slice(-1);
    const flippedChar = lastChar === 'a' ? 'b' : 'a';
    const tamperedId = event.id.slice(0, -1) + flippedChar;

    const tamperedEvent: NostrEvent = {
      ...event,
      id: tamperedId,
    };

    const res = verifyEventCrypto(tamperedEvent);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toContain('does not match provided id');
    }
  });

  it('rejects an event when content is mutated after ID computation', () => {
    const event = createSignedEvent(privKeyA, {
      kind: 1,
      created_at: 1700000000,
      content: 'original message',
    });

    const mutatedEvent: NostrEvent = {
      ...event,
      content: 'tampered message',
    };

    const res = verifyEventCrypto(mutatedEvent);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toContain('does not match provided id');
    }
  });

  it('rejects an event when tags are mutated after ID computation', () => {
    const event = createSignedEvent(privKeyA, {
      kind: 1,
      created_at: 1700000000,
      tags: [['e', '1111111111111111111111111111111111111111111111111111111111111111']],
      content: 'hello',
    });

    const mutatedEvent: NostrEvent = {
      ...event,
      tags: [['e', '2222222222222222222222222222222222222222222222222222222222222222']],
    };

    const res = verifyEventCrypto(mutatedEvent);
    expect(res.valid).toBe(false);
  });

  it('rejects an event signed with a different private key than the advertised pubkey', () => {
    const pubkeyA = bytesToHex(schnorr.getPublicKey(privKeyA));
    const now = 1700000000;
    const content = 'spoofed pubkey event';

    const eventIdHex = computeEventId({
      pubkey: pubkeyA,
      created_at: now,
      kind: 1,
      tags: [],
      content,
    });

    // Signed by privKeyB, but advertises pubkeyA
    const sigByB = bytesToHex(schnorr.sign(eventIdHex, privKeyB));

    const spoofedEvent: NostrEvent = {
      id: eventIdHex,
      pubkey: pubkeyA,
      created_at: now,
      kind: 1,
      tags: [],
      content,
      sig: sigByB,
    };

    const res = verifyEventCrypto(spoofedEvent);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toContain('Invalid BIP-340 Schnorr signature');
    }
  });

  it('rejects an event with a corrupted signature', () => {
    const event = createSignedEvent(privKeyA, {
      kind: 1,
      created_at: 1700000000,
      content: 'corrupted sig test',
    });

    const lastSigChar = event.sig.slice(-1);
    const corruptedSig = event.sig.slice(0, -1) + (lastSigChar === '0' ? '1' : '0');

    const corruptedEvent: NostrEvent = {
      ...event,
      sig: corruptedSig,
    };

    const res = verifyEventCrypto(corruptedEvent);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toContain('Invalid BIP-340 Schnorr signature');
    }
  });

  it('rejects non-hex or malformed pubkey strings gracefully', () => {
    const event = createSignedEvent(privKeyA, {
      kind: 1,
      created_at: 1700000000,
      content: 'malformed pubkey',
    });

    const malformedPubkeyEvent: NostrEvent = {
      ...event,
      pubkey: 'z'.repeat(64), // Invalid hex character
    };

    const res = verifyEventCrypto(malformedPubkeyEvent);
    expect(res.valid).toBe(false);
  });

  it('rejects zero or all-FF signatures gracefully without crashing', () => {
    const event = createSignedEvent(privKeyA, {
      kind: 1,
      created_at: 1700000000,
      content: 'all FF signature',
    });

    const allFFEvent: NostrEvent = {
      ...event,
      sig: 'f'.repeat(128),
    };

    const res = verifyEventCrypto(allFFEvent);
    expect(res.valid).toBe(false);
  });
});
