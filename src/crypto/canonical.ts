import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { NostrEvent, UnsignedNostrEvent } from '../types/nostr';

/**
 * Serializes a Nostr event into canonical NIP-01 JSON string for ID calculation.
 * 
 * Serialization format:
 * [0, <pubkey: string>, <created_at: number>, <kind: number>, <tags: string[][]>, <content: string>]
 */
export function serializeEventForId(event: NostrEvent | UnsignedNostrEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

/**
 * Computes the SHA-256 hash ID of a Nostr event per NIP-01.
 * 
 * Returns the lowercase 64-character hex string representing the event ID.
 */
export function computeEventId(event: NostrEvent | UnsignedNostrEvent): string {
  const serialized = serializeEventForId(event);
  const hashBytes = sha256(new TextEncoder().encode(serialized));
  return bytesToHex(hashBytes);
}
