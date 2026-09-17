import { describe, it, expect } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { computeEventId } from '../../src/crypto/canonical';
import { isHex, verifyEventCrypto, verifyEventSignature } from '../../src/crypto/validator';
import type { NostrEvent } from '../../src/types/nostr';

describe('Cryptographic Validation (BIP-340 Schnorr & SHA-256)', () => {
  function createSignedEvent(privKey: Uint8Array, overrides: Partial<NostrEvent> = {}): NostrEvent {
    const pubKeyHex = bytesToHex(schnorr.getPublicKey(privKey));
    const baseEvent = {
      pubkey: pubKeyHex,
      created_at: 1700000000,
      kind: 1,
      tags: [['t', 'nostr']],
      content: 'Production grade Nostr cache',
      ...overrides,
    };

    const id = computeEventId(baseEvent);
    const sigBytes = schnorr.sign(id, privKey);
    const sig = bytesToHex(sigBytes);

    return {
      ...baseEvent,
      id,
      sig,
    };
  }

  it('validates a properly signed Nostr event', () => {
    const privKey = secp256k1.utils.randomPrivateKey();
    const event = createSignedEvent(privKey);

    expect(verifyEventSignature(event)).toBe(true);

    const result = verifyEventCrypto(event);
    expect(result.valid).toBe(true);
  });

  it('fails verification when event content is tampered', () => {
    const privKey = secp256k1.utils.randomPrivateKey();
    const event = createSignedEvent(privKey);

    const tamperedEvent: NostrEvent = {
      ...event,
      content: 'Tampered content',
    };

    const result = verifyEventCrypto(tamperedEvent);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('Computed event id');
    }
  });

  it('fails verification when signature is forged', () => {
    const privKey1 = secp256k1.utils.randomPrivateKey();
    const privKey2 = secp256k1.utils.randomPrivateKey();

    const event = createSignedEvent(privKey1);
    // Sign with different private key
    const forgedSig = bytesToHex(schnorr.sign(event.id, privKey2));

    const forgedEvent: NostrEvent = {
      ...event,
      sig: forgedSig,
    };

    const sigResult = verifyEventSignature(forgedEvent);
    expect(sigResult).toBe(false);

    const cryptoResult = verifyEventCrypto(forgedEvent);
    expect(cryptoResult.valid).toBe(false);
    if (!cryptoResult.valid) {
      expect(cryptoResult.reason).toContain('Invalid BIP-340 Schnorr signature');
    }
  });

  it('fails verification on invalid hex strings', () => {
    const invalidEvent: NostrEvent = {
      id: 'invalid-hex'.padEnd(64, '0'),
      pubkey: 'non-hex-pubkey'.padEnd(64, '0'),
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: 'test',
      sig: 'short-sig',
    };

    const result = verifyEventCrypto(invalidEvent);
    expect(result.valid).toBe(false);
  });

  it('validates isHex helper correctly', () => {
    expect(isHex('0123456789abcdef', 16)).toBe(true);
    expect(isHex('0123456789ABCDEF', 16)).toBe(true);
    expect(isHex('0123456789abcdefg', 17)).toBe(false); // 'g' is not hex
    expect(isHex('0123456789abcdef', 10)).toBe(false); // length mismatch
    expect(isHex(12345 as unknown as string)).toBe(false);
    expect(isHex(null as unknown as string)).toBe(false);
  });
});
