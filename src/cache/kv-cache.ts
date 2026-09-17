import { classifyEventKind, extractDTag } from '../db/classifier';
import type { NostrEvent } from '../types/nostr';
import { extractRelaysFromKind10002 } from '../upstream/nip65';

/**
 * KV Cache configuration constants
 * Max TTL is strictly capped at 2 hours (7200 seconds) per user specification.
 */
export const DEFAULT_KV_TTL_SECONDS = 7200;
export const MAX_KV_TTL_SECONDS = 7200;
export const MIN_KV_TTL_SECONDS = 60;

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
 * Writes an author's resolved relays into KV with bounded TTL.
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
  const expirationTtl = sanitizeKvTtl(ttlSeconds);
  try {
    await kv.put(getRelaysKey(pubkey), JSON.stringify(relays), {
      expirationTtl,
    });
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

  try {
    await Promise.allSettled(writes);
  } catch {
    // Non-critical cache write errors are ignored
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
      deletes.push(kv.delete(getProfileKey(pubkey)));
    }
    if (kind === 3) {
      deletes.push(kv.delete(getContactsKey(pubkey)));
    }
    if (kind === 10002) {
      deletes.push(kv.delete(getRelaysKey(pubkey)));
    }
    deletes.push(kv.delete(getReplaceableKey(pubkey, kind, dTag)));
  }

  try {
    await Promise.allSettled(deletes);
  } catch {
    // Non-critical cache deletion errors are ignored
  }
}
