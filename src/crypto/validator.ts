import { schnorr } from '@noble/curves/secp256k1';
import type { NostrEvent, ValidationResult } from '../types/nostr';
import { computeEventId } from './canonical';

const HEX_REGEX = /^[0-9a-fA-F]+$/;

/**
 * Validates if a string is a valid hexadecimal string of the expected length.
 */
export function isHex(str: unknown, expectedLength?: number): str is string {
  if (typeof str !== 'string') {
    return false;
  }
  if (expectedLength !== undefined && str.length !== expectedLength) {
    return false;
  }
  return HEX_REGEX.test(str);
}

/**
 * Verifies the BIP-340 Schnorr signature of a Nostr event against its ID and public key.
 */
export function verifyEventSignature(event: NostrEvent): boolean {
  if (!isHex(event.sig, 128) || !isHex(event.id, 64) || !isHex(event.pubkey, 64)) {
    return false;
  }

  try {
    return schnorr.verify(event.sig.toLowerCase(), event.id.toLowerCase(), event.pubkey.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Cryptographically validates a Nostr event:
 * 1. Checks hex formatting of id, pubkey, and sig.
 * 2. Recalculates SHA-256 event ID and compares with event.id.
 * 3. Verifies BIP-340 Schnorr signature.
 */
export function verifyEventCrypto(event: NostrEvent): ValidationResult {
  if (!isHex(event.id, 64)) {
    return { valid: false, reason: 'Invalid event id: must be 64-character lowercase hex string' };
  }

  if (!isHex(event.pubkey, 64)) {
    return { valid: false, reason: 'Invalid event pubkey: must be 64-character lowercase hex string' };
  }

  if (!isHex(event.sig, 128)) {
    return { valid: false, reason: 'Invalid event signature: must be 128-character lowercase hex string' };
  }

  const expectedId = computeEventId(event);
  if (expectedId !== event.id.toLowerCase()) {
    return { valid: false, reason: `Computed event id (${expectedId}) does not match provided id (${event.id})` };
  }

  const isSignatureValid = verifyEventSignature(event);
  if (!isSignatureValid) {
    return { valid: false, reason: 'Invalid BIP-340 Schnorr signature' };
  }

  return { valid: true };
}
