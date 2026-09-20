import { classifyEventKind, extractDTag } from '../db/classifier';
import type { NostrEvent } from '../types/nostr';
import { extractRelaysFromKind10002 } from '../upstream/nip65';
import { MemoryLruCache } from './lru-cache';

/**
 * KV Cache configuration constants
 * Max TTL is strictly capped at 2 hours (7200 seconds) per user specification.
 */
export const DEFAULT_KV_TTL_SECONDS = 7200;
export const MAX_KV_TTL_SECONDS = 7200;
export const MIN_KV_TTL_SECONDS = 60;

/**
 * In-memory deduplication cache to prevent re-writing identical metadata events to KV repeatedly.
 * Capacity of 5,000 recent metadata keys with 30-minute TTL.
 */
export const metadataWriteDedupCache = new MemoryLruCache<string, number>({
  maxSize: 5000,
  defaultTtlMs: 30 * 60 * 1000,
});

/**
 * Sanitizes and bounds TTL seconds between MIN (60s) and MAX (7200s).
 */
export function sanitizeKvTtl(ttlSeconds?: number): number {
  if (ttlSeconds === undefined || Number.isNaN(ttlSeconds)) {
    return DEFAULT_KV_TTL_SECONDS;
  }
  return Math.min(Math.max(ttlSeconds, MIN_KV_TTL_SECONDS), MAX_KV_TTL_SECONDS);
}

/**
 * Cache Key Generators
 */
export function getEventIdKey(id: string): string {
  return `evt:${id}`;
}

export function getProfileKey(pubkey: string): string {
  return `profile:${pubkey}`;
}

export function getRelaysKey(pubkey: string): string {
  return `relays:${pubkey}`;
}

export function getContactsKey(pubkey: string): string {
  return `contacts:${pubkey}`;
}

export function getReplaceableKey(pubkey: string, kind: number, dTag?: string): string {
  if (kind >= 30000 && kind < 40000) {
    return `param:${pubkey}:${kind}:${dTag ?? ''}`;
  }
  return `replaceable:${pubkey}:${kind}`;
}

/**
 * Retrieves a single event by ID from KV.
 */
export async function getEventByIdFromKv(
  kv: KVNamespace,
  id: string
): Promise<NostrEvent | null> {
  if (!id || typeof id !== 'string') {
    return null;
  }
  try {
    const raw = await kv.get(getEventIdKey(id));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as NostrEvent;
  } catch {
    return null;
  }
}

/**
 * Retrieves multiple events by their IDs in parallel from KV.
 */
export async function getEventsByIdsFromKv(
  kv: KVNamespace,
  ids: string[]
): Promise<{ hits: NostrEvent[]; misses: string[] }> {
  if (!ids || ids.length === 0) {
    return { hits: [], misses: [] };
  }

  const hits: NostrEvent[] = [];
  const misses: string[] = [];

  const results = await Promise.all(
    ids.map(async (id) => {
      const event = await getEventByIdFromKv(kv, id);
      return { id, event };
    })
  );

  for (const { id, event } of results) {
    if (event) {
      hits.push(event);
    } else {
      misses.push(id);
    }
  }

  return { hits, misses };
}

/**
 * Retrieves a replaceable or parameterized replaceable event from KV.
 */
export async function getReplaceableEventFromKv(
  kv: KVNamespace,
  pubkey: string,
  kind: number,
  dTag?: string
): Promise<NostrEvent | null> {
  if (!pubkey || typeof pubkey !== 'string') {
    return null;
  }
  const key = getReplaceableKey(pubkey, kind, dTag);
  try {
    const raw = await kv.get(key);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as NostrEvent;
  } catch {
    return null;
  }
}

/**
 * Retrieves NIP-65 write relays for an author from KV.
 */
export async function getAuthorRelaysFromKv(
  kv: KVNamespace,
  pubkey: string
): Promise<string[] | null> {
  if (!pubkey || typeof pubkey !== 'string') {
    return null;
  }
  try {
    const raw = await kv.get(getRelaysKey(pubkey));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as string[];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Writes an author's resolved relays into KV with bounded TTL and in-memory deduplication.
 */
export async function putAuthorRelaysToKv(
  kv: KVNamespace,
  pubkey: string,
  relays: string[],
  ttlSeconds?: number
): Promise<void> {
  if (!pubkey || !relays || relays.length === 0) {
    return;
  }

  // Deduplicate using in-memory signature
  const key = getRelaysKey(pubkey);
  const fingerprint = relays.join('|').length;
  if (metadataWriteDedupCache.get(key) === fingerprint) {
    return;
  }

  const expirationTtl = sanitizeKvTtl(ttlSeconds);
  try {
    await kv.put(key, JSON.stringify(relays), {
      expirationTtl,
    });
    metadataWriteDedupCache.set(key, fingerprint);
  } catch {
    // Fail silently on non-critical cache write errors
  }
}

/**
 * Stores a Nostr event into KV with appropriate secondary keys and bounded TTL.
 * Ephemeral events (kinds 20000..29999) are never saved to KV.
 */
export async function putEventToKv(
  kv: KVNamespace,
  event: NostrEvent,
  ttlSeconds?: number
): Promise<void> {
  const category = classifyEventKind(event.kind);
  if (category === 'EPHEMERAL') {
    return;
  }

  const expirationTtl = sanitizeKvTtl(ttlSeconds);
  const rawJson = JSON.stringify(event);
  const writes: Promise<void>[] = [];

  // 1. Point lookup by event ID
  writes.push(
    kv.put(getEventIdKey(event.id), rawJson, { expirationTtl })
  );

  // 2. Kind 0 (User Metadata Profile)
  if (event.kind === 0) {
    writes.push(
      kv.put(getProfileKey(event.pubkey), rawJson, { expirationTtl })
    );
  }

  // 3. Kind 3 (Contact List)
  if (event.kind === 3) {
    writes.push(
      kv.put(getContactsKey(event.pubkey), rawJson, { expirationTtl })
    );
  }

  // 4. Kind 10002 (NIP-65 Relay List)
  if (event.kind === 10002) {
    const writeRelays = extractRelaysFromKind10002(event, 'write');
    if (writeRelays.length > 0) {
      writes.push(
        kv.put(getRelaysKey(event.pubkey), JSON.stringify(writeRelays), { expirationTtl })
      );
    }
  }

  // 5. Replaceable & Parameterized Replaceable keys
  if (category === 'REPLACEABLE') {
    const key = getReplaceableKey(event.pubkey, event.kind);
    writes.push(
      (async () => {
        const existing = await getReplaceableEventFromKv(kv, event.pubkey, event.kind);
        if (!existing || event.created_at > existing.created_at || (event.created_at === existing.created_at && event.id < existing.id)) {
          await kv.put(key, rawJson, { expirationTtl });
        }
      })()
    );
  } else if (category === 'PARAMETERIZED_REPLACEABLE') {
    const dTag = extractDTag(event.tags);
    const key = getReplaceableKey(event.pubkey, event.kind, dTag);
    writes.push(
      (async () => {
        const existing = await getReplaceableEventFromKv(kv, event.pubkey, event.kind, dTag);
        if (!existing || event.created_at > existing.created_at || (event.created_at === existing.created_at && event.id < existing.id)) {
          await kv.put(key, rawJson, { expirationTtl });
        }
      })()
    );
  }

  if (writes.length > 0) {
    try {
      await Promise.allSettled(writes);
    } catch {
      // Non-critical cache write errors are ignored
    }
  }
}

/**
 * Stores high-value metadata events into KV with in-memory deduplication.
 * Only writes Kind 0 (profile), Kind 3 (contacts), Kind 10002 (relays), and replaceable events.
 * Ephemeral events and regular feed events (Kind 1, 6, 7, etc.) are strictly excluded.
 */
export async function putMetadataToKv(
  kv: KVNamespace,
  event: NostrEvent,
  ttlSeconds?: number
): Promise<void> {
  const category = classifyEventKind(event.kind);
  if (category === 'EPHEMERAL' || category === 'REGULAR') {
    return;
  }

  const expirationTtl = sanitizeKvTtl(ttlSeconds);
  const rawJson = JSON.stringify(event);
  const writes: Promise<void>[] = [];

  // Kind 0 (User Metadata Profile)
  if (event.kind === 0) {
    const profileKey = getProfileKey(event.pubkey);
    const lastSeenTime = metadataWriteDedupCache.get(profileKey);
    if (lastSeenTime === undefined || event.created_at > lastSeenTime) {
      writes.push(
        kv.put(profileKey, rawJson, { expirationTtl }).then(() => {
          metadataWriteDedupCache.set(profileKey, event.created_at);
        })
      );
    }
  }

  // Kind 3 (Contact List)
  if (event.kind === 3) {
    const contactsKey = getContactsKey(event.pubkey);
    const lastSeenTime = metadataWriteDedupCache.get(contactsKey);
    if (lastSeenTime === undefined || event.created_at > lastSeenTime) {
      writes.push(
        kv.put(contactsKey, rawJson, { expirationTtl }).then(() => {
          metadataWriteDedupCache.set(contactsKey, event.created_at);
        })
      );
    }
  }

  // Kind 10002 (NIP-65 Relay List)
  if (event.kind === 10002) {
    const writeRelays = extractRelaysFromKind10002(event, 'write');
    if (writeRelays.length > 0) {
      const relaysKey = getRelaysKey(event.pubkey);
      const lastSeenTime = metadataWriteDedupCache.get(relaysKey);
      if (lastSeenTime === undefined || event.created_at > lastSeenTime) {
        writes.push(
          kv.put(relaysKey, JSON.stringify(writeRelays), { expirationTtl }).then(() => {
            metadataWriteDedupCache.set(relaysKey, event.created_at);
          })
        );
      }
    }
  }

  // Replaceable & Parameterized Replaceable keys
  if (category === 'REPLACEABLE') {
    const key = getReplaceableKey(event.pubkey, event.kind);
    const lastSeenTime = metadataWriteDedupCache.get(key);
    if (lastSeenTime === undefined || event.created_at > lastSeenTime) {
      writes.push(
        (async () => {
          const existing = await getReplaceableEventFromKv(kv, event.pubkey, event.kind);
          if (!existing || event.created_at > existing.created_at || (event.created_at === existing.created_at && event.id < existing.id)) {
            await kv.put(key, rawJson, { expirationTtl });
            metadataWriteDedupCache.set(key, event.created_at);
          }
        })()
      );
    }
  } else if (category === 'PARAMETERIZED_REPLACEABLE') {
    const dTag = extractDTag(event.tags);
    const key = getReplaceableKey(event.pubkey, event.kind, dTag);
    const lastSeenTime = metadataWriteDedupCache.get(key);
    if (lastSeenTime === undefined || event.created_at > lastSeenTime) {
      writes.push(
        (async () => {
          const existing = await getReplaceableEventFromKv(kv, event.pubkey, event.kind, dTag);
          if (!existing || event.created_at > existing.created_at || (event.created_at === existing.created_at && event.id < existing.id)) {
            await kv.put(key, rawJson, { expirationTtl });
            metadataWriteDedupCache.set(key, event.created_at);
          }
        })()
      );
    }
  }

  if (writes.length > 0) {
    try {
      await Promise.allSettled(writes);
    } catch {
      // Non-critical cache write errors are ignored
    }
  }
}

/**
 * Deletes an event from KV, including its ID and any replaceable keys.
 */
export async function deleteEventFromKv(
  kv: KVNamespace,
  id: string,
  pubkey?: string,
  kind?: number,
  dTag?: string
): Promise<void> {
  const deletes: Promise<void>[] = [kv.delete(getEventIdKey(id))];

  if (pubkey && typeof kind === 'number') {
    if (kind === 0) {
      const profileKey = getProfileKey(pubkey);
      metadataWriteDedupCache.delete(profileKey);
      deletes.push(kv.delete(profileKey));
    }
    if (kind === 3) {
      const contactsKey = getContactsKey(pubkey);
      metadataWriteDedupCache.delete(contactsKey);
      deletes.push(kv.delete(contactsKey));
    }
    if (kind === 10002) {
      const relaysKey = getRelaysKey(pubkey);
      metadataWriteDedupCache.delete(relaysKey);
      deletes.push(kv.delete(relaysKey));
    }
    const replKey = getReplaceableKey(pubkey, kind, dTag);
    metadataWriteDedupCache.delete(replKey);
    deletes.push(kv.delete(replKey));
  }

  try {
    await Promise.allSettled(deletes);
  } catch {
    // Non-critical cache deletion errors are ignored
  }
}
