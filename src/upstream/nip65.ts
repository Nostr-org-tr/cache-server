import { getAuthorRelaysFromKv, putAuthorRelaysToKv } from '../cache/kv-cache';
import { MemoryLruCache } from '../cache/lru-cache';
import type { NostrEvent, NostrFilter } from '../types/nostr';
import { filterValidRelayUrls, type UrlValidationOptions } from './url-validator';

/**
 * In-memory L0 cache for resolved NIP-65 author relays (capacity 2,000, 30 min TTL).
 */
export const authorRelaysMemoryCache = new MemoryLruCache<string, string[]>({
  maxSize: 2000,
  defaultTtlMs: 30 * 60 * 1000,
});

/**
 * Extracts relay URLs from a Kind 10002 (NIP-65 Relay List Metadata) event.
 * If mode is 'write', only write and unconstrained (read+write) relays are returned.
 * If mode is 'read', only read and unconstrained relays are returned.
 * If mode is 'all', all valid relay URLs are returned.
 */
export function extractRelaysFromKind10002(
  event: NostrEvent,
  mode: 'write' | 'read' | 'all' = 'write',
  options?: UrlValidationOptions
): string[] {
  if (event.kind !== 10002 || !Array.isArray(event.tags)) {
    return [];
  }

  const rawUrls: string[] = [];

  for (const tag of event.tags) {
    if (Array.isArray(tag) && tag[0] === 'r' && typeof tag[1] === 'string') {
      const url = tag[1].trim();
      const marker = typeof tag[2] === 'string' ? tag[2].toLowerCase() : '';

      if (mode === 'all') {
        rawUrls.push(url);
      } else if (mode === 'write') {
        // Unconstrained (no marker) or marked as 'write'
        if (!marker || marker === 'write') {
          rawUrls.push(url);
        }
      } else if (mode === 'read') {
        // Unconstrained (no marker) or marked as 'read'
        if (!marker || marker === 'read') {
          rawUrls.push(url);
        }
      }
    }
  }

  return filterValidRelayUrls(rawUrls, options);
}

/**
 * Resolves author write relays using a multi-tiered approach:
 * 1. In-Memory L0 Cache (0 cost, 0ms)
 * 2. KV Namespace (if bound)
 * 3. D1 Database (Indexed query against Kind 10002)
 */
export async function resolveAuthorRelaysFromD1(
  db: D1Database,
  authors: string[],
  options?: UrlValidationOptions,
  kv?: KVNamespace
): Promise<string[]> {
  if (!authors || authors.length === 0) {
    return [];
  }

  // Filter valid 64-char hex pubkeys to prevent malformed queries
  const validAuthors = authors.filter((a) => /^[0-9a-f]{64}$/i.test(a));
  if (validAuthors.length === 0) {
    return [];
  }

  const allUrls: string[] = [];
  const authorsToQueryNextTier: string[] = [];

  // 1. Check In-Memory L0 cache
  for (const author of validAuthors) {
    const memRelays = authorRelaysMemoryCache.get(author);
    if (memRelays && memRelays.length > 0) {
      allUrls.push(...memRelays);
    } else {
      authorsToQueryNextTier.push(author);
    }
  }

  if (authorsToQueryNextTier.length === 0) {
    return filterValidRelayUrls(allUrls, options);
  }

  const authorsToQueryD1: string[] = [];

  // 2. Check KV cache if available
  if (kv) {
    for (const author of authorsToQueryNextTier) {
      const cachedRelays = await getAuthorRelaysFromKv(kv, author);
      if (cachedRelays && cachedRelays.length > 0) {
        allUrls.push(...cachedRelays);
        authorRelaysMemoryCache.set(author, cachedRelays);
      } else {
        authorsToQueryD1.push(author);
      }
    }
  } else {
    authorsToQueryD1.push(...authorsToQueryNextTier);
  }

  if (authorsToQueryD1.length === 0) {
    return filterValidRelayUrls(allUrls, options);
  }

  // 3. Query D1 database in safe chunks
  const CHUNK_SIZE = 50;
  const authorChunks: string[][] = [];
  for (let i = 0; i < authorsToQueryD1.length; i += CHUNK_SIZE) {
    authorChunks.push(authorsToQueryD1.slice(i, i + CHUNK_SIZE));
  }

  for (const chunk of authorChunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const query = `SELECT pubkey, raw_event FROM events WHERE kind = 10002 AND pubkey IN (${placeholders})`;

    try {
      const result = await db
        .prepare(query)
        .bind(...chunk)
        .all<{ pubkey: string; raw_event: string }>();

      if (result.results && result.results.length > 0) {
        for (const row of result.results) {
          try {
            const event = JSON.parse(row.raw_event) as NostrEvent;
            const relays = extractRelaysFromKind10002(event, 'write', options);
            allUrls.push(...relays);

            // Cache in In-Memory L0 and optionally KV
            authorRelaysMemoryCache.set(row.pubkey, relays);
            if (kv && relays.length > 0) {
              void putAuthorRelaysToKv(kv, row.pubkey, relays);
            }
          } catch {
            // Skip malformed records
          }
        }
      }
    } catch {
      // Continue processing other chunks if one fails
    }
  }

  return filterValidRelayUrls(allUrls, options);
}

/**
 * Extracts relay hints embedded within NIP-01 filter tags (if any).
 */
export function extractRelayHintsFromFilters(
  filters: NostrFilter[],
  options?: UrlValidationOptions
): string[] {
  const rawUrls: string[] = [];

  for (const filter of filters) {
    // Check generic tag arrays in filter e.g. #r: ["wss://..."]
    if (Array.isArray(filter['#r'])) {
      for (const val of filter['#r']) {
        if (typeof val === 'string') {
          rawUrls.push(val);
        }
      }
    }
  }

  return filterValidRelayUrls(rawUrls, options);
}
