import {
  deleteEventFromKv,
  getEventsByIdsFromKv,
  getReplaceableEventFromKv,
  getReplaceableKey,
  MemoryLruCache,
  putMetadataToKv,
} from '../cache';
import {
  createEmptyModerationRuleset,
  extractModerationRulesFromEvents,
  inspectEventModeration,
  type ModerationRuleset,
} from '../security';
import { deleteEventVectors, executeSearch, indexEventsBatchVector } from '../search';
import type { Env } from '../types/env';
import type { NostrEvent, NostrFilter } from '../types/nostr';
import {
  classifyEventKind,
  eventToEventRow,
  extractDTag,
  extractIndexableTags,
  rowToNostrEvent,
} from './classifier';
import { compileCountToSql, compileDeletionQueries, compileFilterToSql } from './compiler';
import type { EventFilterQueryOptions, EventRow, SaveResult } from './types';

export const MAX_SQL_PARAM_ARRAY_SIZE = 50;
export const MAX_D1_BATCH_STATEMENTS = 50;

/**
 * In-memory L0 cache for fast point lookups by event ID (capacity 5,000, 10 min TTL).
 */
export const memoryEventIdCache = new MemoryLruCache<string, NostrEvent>({
  maxSize: 5000,
  defaultTtlMs: 10 * 60 * 1000,
});

/**
 * In-memory L0 cache for replaceable and metadata events (capacity 2,000, 30 min TTL).
 */
export const memoryReplaceableCache = new MemoryLruCache<string, NostrEvent>({
  maxSize: 2000,
  defaultTtlMs: 30 * 60 * 1000,
});

/**
 * Helper to cache an event in the in-memory L0 caches.
 */
export function cacheEventInMemory(event: NostrEvent): void {
  const category = classifyEventKind(event.kind);
  if (category === 'EPHEMERAL') {
    return;
  }

  // Cache point lookup
  memoryEventIdCache.set(event.id, event);

  // Cache replaceable / metadata keys
  if (category === 'REPLACEABLE' || event.kind === 0 || event.kind === 3 || event.kind === 10002) {
    const key = getReplaceableKey(event.pubkey, event.kind);
    const existing = memoryReplaceableCache.get(key);
    if (!existing || event.created_at > existing.created_at || (event.created_at === existing.created_at && event.id < existing.id)) {
      memoryReplaceableCache.set(key, event);
    }
  } else if (category === 'PARAMETERIZED_REPLACEABLE') {
    const dTag = extractDTag(event.tags);
    const key = getReplaceableKey(event.pubkey, event.kind, dTag);
    const existing = memoryReplaceableCache.get(key);
    if (!existing || event.created_at > existing.created_at || (event.created_at === existing.created_at && event.id < existing.id)) {
      memoryReplaceableCache.set(key, event);
    }
  }
}

/**
 * Invalidate an event from the in-memory L0 caches.
 */
export function invalidateEventInMemory(
  id: string,
  pubkey?: string,
  kind?: number,
  dTag?: string
): void {
  memoryEventIdCache.delete(id);
  if (pubkey && typeof kind === 'number') {
    const key = getReplaceableKey(pubkey, kind, dTag);
    memoryReplaceableCache.delete(key);
  }
}

/**
 * Safely executes D1 batch statements in chunks of at most MAX_D1_BATCH_STATEMENTS
 * to prevent exceeding Cloudflare D1 batch transaction bounds.
 */
export async function executeBatchSafe(
  db: D1Database,
  statements: D1PreparedStatement[]
): Promise<void> {
  if (statements.length === 0) {
    return;
  }
  if (statements.length <= MAX_D1_BATCH_STATEMENTS) {
    await db.batch(statements);
    return;
  }
  for (let i = 0; i < statements.length; i += MAX_D1_BATCH_STATEMENTS) {
    const chunk = statements.slice(i, i + MAX_D1_BATCH_STATEMENTS);
    await db.batch(chunk);
  }
}

/**
 * Splits a NostrFilter containing large arrays (ids, authors, #tag filters)
 * into smaller sub-filters (max 50 items each) to prevent SQLite/D1 "too many SQL variables" errors.
 */
export function splitFilterForSafeQuery(
  filter: NostrFilter,
  chunkSize = MAX_SQL_PARAM_ARRAY_SIZE
): NostrFilter[] {
  let hasLargeArray = false;
  if (filter.ids && filter.ids.length > chunkSize) hasLargeArray = true;
  if (filter.authors && filter.authors.length > chunkSize) hasLargeArray = true;

  for (const [key, val] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(val) && val.length > chunkSize) {
      hasLargeArray = true;
      break;
    }
  }

  if (!hasLargeArray) {
    return [filter];
  }

  // Split authors array if large
  if (filter.authors && filter.authors.length > chunkSize) {
    const subFilters: NostrFilter[] = [];
    for (let i = 0; i < filter.authors.length; i += chunkSize) {
      const chunk = filter.authors.slice(i, i + chunkSize);
      const subFilter: NostrFilter = { ...filter, authors: chunk };
      subFilters.push(...splitFilterForSafeQuery(subFilter, chunkSize));
    }
    return subFilters;
  }

  // Split ids array if large
  if (filter.ids && filter.ids.length > chunkSize) {
    const subFilters: NostrFilter[] = [];
    for (let i = 0; i < filter.ids.length; i += chunkSize) {
      const chunk = filter.ids.slice(i, i + chunkSize);
      const subFilter: NostrFilter = { ...filter, ids: chunk };
      subFilters.push(...splitFilterForSafeQuery(subFilter, chunkSize));
    }
    return subFilters;
  }

  // Split generic #tag arrays if large
  for (const [key, val] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(val) && val.length > chunkSize) {
      const subFilters: NostrFilter[] = [];
      for (let i = 0; i < val.length; i += chunkSize) {
        const chunk = val.slice(i, i + chunkSize);
        const subFilter: NostrFilter = { ...filter, [key]: chunk };
        subFilters.push(...splitFilterForSafeQuery(subFilter, chunkSize));
      }
      return subFilters;
    }
  }

  return [filter];
}

/**
 * Saves a single Nostr event into Cloudflare D1 adhering to NIP-01, NIP-09, NIP-16, and NIP-33 semantics.
 */
export async function saveEvent(db: D1Database, event: NostrEvent): Promise<SaveResult> {
  // Moderation check: drop NSFW, content-warning, and prohibited content
  const moderation = inspectEventModeration(event);
  if (!moderation.allowed) {
    return { action: 'ignored', id: event.id, reason: 'moderated_sensitive_or_blocked' };
  }

  const category = classifyEventKind(event.kind);

  // 1. Ephemeral events (kinds 20000..29999) must NEVER be saved to D1
  if (category === 'EPHEMERAL') {
    return { action: 'ignored', id: event.id, reason: 'ephemeral' };
  }

  // 2. Deletion events (kind 5) - NIP-09
  if (category === 'DELETION') {
    const deleteQueries = compileDeletionQueries(event);
    const statements: D1PreparedStatement[] = [];

    for (const q of deleteQueries) {
      statements.push(db.prepare(q.sql).bind(...q.params));
    }

    // Also persist the kind 5 event itself for audit/relay synchronization
    const row = eventToEventRow(event);
    statements.push(
      db
        .prepare(
          'INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          row.id,
          row.pubkey,
          row.created_at,
          row.kind,
          row.d_tag,
          row.raw_event,
          row.created_at_recorded
        )
    );

    const tags = extractIndexableTags(event);
    for (const tag of tags) {
      statements.push(
        db
          .prepare(
            'INSERT OR IGNORE INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)'
          )
          .bind(event.id, tag.tagName, tag.tagValue)
      );
    }

    if (statements.length > 0) {
      await executeBatchSafe(db, statements);
    }

    // Invalidate in memory
    if (Array.isArray(event.tags)) {
      for (const tag of event.tags) {
        if (Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string') {
          invalidateEventInMemory(tag[1]);
        }
      }
    }

    return { action: 'deleted', id: event.id };
  }

  // 3. Replaceable events (kinds 0, 3, 10000..19999) - NIP-16
  if (category === 'REPLACEABLE') {
    const existing = await db
      .prepare('SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? LIMIT 1')
      .bind(event.pubkey, event.kind)
      .first<{ id: string; created_at: number }>();

    if (existing) {
      if (existing.created_at > event.created_at) {
        return { action: 'superseded', id: event.id, reason: 'older_timestamp' };
      }
      if (existing.created_at === event.created_at && existing.id < event.id) {
        return { action: 'superseded', id: event.id, reason: 'tie_break_id' };
      }
      if (existing.id === event.id) {
        return { action: 'ignored', id: event.id, reason: 'duplicate' };
      }

      // Overwrite older record: delete existing and insert new
      const row = eventToEventRow(event);
      const statements: D1PreparedStatement[] = [
        db.prepare('DELETE FROM events WHERE id = ?').bind(existing.id),
        db
          .prepare(
            'INSERT INTO events (id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(
            row.id,
            row.pubkey,
            row.created_at,
            row.kind,
            row.d_tag,
            row.raw_event,
            row.created_at_recorded
          ),
      ];

      const tags = extractIndexableTags(event);
      for (const tag of tags) {
        statements.push(
          db
            .prepare(
              'INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)'
            )
            .bind(event.id, tag.tagName, tag.tagValue)
        );
      }

      await executeBatchSafe(db, statements);
      cacheEventInMemory(event);
      return { action: 'inserted', id: event.id };
    }

    // No prior event found, insert fresh
    const row = eventToEventRow(event);
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          'INSERT INTO events (id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          row.id,
          row.pubkey,
          row.created_at,
          row.kind,
          row.d_tag,
          row.raw_event,
          row.created_at_recorded
        ),
    ];

    const tags = extractIndexableTags(event);
    for (const tag of tags) {
      statements.push(
        db
          .prepare(
            'INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)'
          )
          .bind(event.id, tag.tagName, tag.tagValue)
      );
    }

    await executeBatchSafe(db, statements);
    cacheEventInMemory(event);
    return { action: 'inserted', id: event.id };
  }

  // 4. Parameterized Replaceable events (kinds 30000..39999) - NIP-33
  if (category === 'PARAMETERIZED_REPLACEABLE') {
    const dTag = extractDTag(event.tags);
    const existing = await db
      .prepare(
        'SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ? LIMIT 1'
      )
      .bind(event.pubkey, event.kind, dTag)
      .first<{ id: string; created_at: number }>();

    if (existing) {
      if (existing.created_at > event.created_at) {
        return { action: 'superseded', id: event.id, reason: 'older_timestamp' };
      }
      if (existing.created_at === event.created_at && existing.id < event.id) {
        return { action: 'superseded', id: event.id, reason: 'tie_break_id' };
      }
      if (existing.id === event.id) {
        return { action: 'ignored', id: event.id, reason: 'duplicate' };
      }

      // Overwrite older record: delete existing and insert new
      const row = eventToEventRow(event);
      const statements: D1PreparedStatement[] = [
        db.prepare('DELETE FROM events WHERE id = ?').bind(existing.id),
        db
          .prepare(
            'INSERT INTO events (id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(
            row.id,
            row.pubkey,
            row.created_at,
            row.kind,
            row.d_tag,
            row.raw_event,
            row.created_at_recorded
          ),
      ];

      const tags = extractIndexableTags(event);
      for (const tag of tags) {
        statements.push(
          db
            .prepare(
              'INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)'
            )
            .bind(event.id, tag.tagName, tag.tagValue)
        );
      }

      await executeBatchSafe(db, statements);
      cacheEventInMemory(event);
      return { action: 'inserted', id: event.id };
    }

    // No prior parameterized event found, insert fresh
    const row = eventToEventRow(event);
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          'INSERT INTO events (id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          row.id,
          row.pubkey,
          row.created_at,
          row.kind,
          row.d_tag,
          row.raw_event,
          row.created_at_recorded
        ),
    ];

    const tags = extractIndexableTags(event);
    for (const tag of tags) {
      statements.push(
        db
          .prepare(
            'INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)'
          )
          .bind(event.id, tag.tagName, tag.tagValue)
      );
    }

    await executeBatchSafe(db, statements);
    cacheEventInMemory(event);
    return { action: 'inserted', id: event.id };
  }

  // 5. Regular persistent events (kinds 1, 2, 4..9999, etc.) - NIP-01
  const existing = await db
    .prepare('SELECT id FROM events WHERE id = ? LIMIT 1')
    .bind(event.id)
    .first<{ id: string }>();

  if (existing) {
    return { action: 'ignored', id: event.id, reason: 'duplicate' };
  }

  const row = eventToEventRow(event);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        'INSERT INTO events (id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        row.id,
        row.pubkey,
        row.created_at,
        row.kind,
        row.d_tag,
        row.raw_event,
        row.created_at_recorded
      ),
  ];

  const tags = extractIndexableTags(event);
  for (const tag of tags) {
    statements.push(
      db
        .prepare(
          'INSERT OR IGNORE INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)'
        )
        .bind(event.id, tag.tagName, tag.tagValue)
    );
  }

  await executeBatchSafe(db, statements);
  cacheEventInMemory(event);
  return { action: 'inserted', id: event.id };
}

/**
 * Checks if a filter contains any Nostr tag filter fields (e.g. #e, #p, #t).
 */
export function hasTagFilters(filter: NostrFilter): boolean {
  for (const key of Object.keys(filter)) {
    if (key.startsWith('#')) {
      return true;
    }
  }
  return false;
}

/**
 * Saves a batch of Nostr events efficiently into Cloudflare D1.
 * Caches events in the zero-cost in-memory L0 cache tier and selectively warms
 * high-value metadata into KV (Kind 0, 3, 10002) while eliminating bulk event write storms.
 */
export async function saveEventsBatch(
  db: D1Database,
  events: NostrEvent[],
  kv?: KVNamespace
): Promise<SaveResult[]> {
  if (events.length === 0) {
    return [];
  }

  const results: SaveResult[] = [];
  const statements: D1PreparedStatement[] = [];
  const metadataToWarmInKv: NostrEvent[] = [];

  for (const event of events) {
    // Moderation check: drop NSFW, content-warning, and prohibited content
    const moderation = inspectEventModeration(event);
    if (!moderation.allowed) {
      results.push({ action: 'ignored', id: event.id, reason: 'moderated_sensitive_or_blocked' });
      continue;
    }

    const category = classifyEventKind(event.kind);

    // 1. Ephemeral: ignore
    if (category === 'EPHEMERAL') {
      results.push({ action: 'ignored', id: event.id, reason: 'ephemeral' });
      continue;
    }

    // 2. Deletion (Kind 5)
    if (category === 'DELETION') {
      const deleteQueries = compileDeletionQueries(event);
      for (const q of deleteQueries) {
        statements.push(db.prepare(q.sql).bind(...q.params));
      }

      const row = eventToEventRow(event);
      statements.push(
        db
          .prepare(
            'INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(
            row.id,
            row.pubkey,
            row.created_at,
            row.kind,
            row.d_tag,
            row.raw_event,
            row.created_at_recorded
          )
      );

      const tags = extractIndexableTags(event);
      for (const tag of tags) {
        statements.push(
          db
            .prepare(
              'INSERT OR IGNORE INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)'
            )
            .bind(event.id, tag.tagName, tag.tagValue)
        );
      }

      results.push({ action: 'deleted', id: event.id });

      // Invalidate from in-memory cache & KV if target event IDs are referenced
      if (Array.isArray(event.tags)) {
        for (const tag of event.tags) {
          if (Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string') {
            invalidateEventInMemory(tag[1]);
            if (kv) {
              void deleteEventFromKv(kv, tag[1]);
            }
          }
        }
      }
      continue;
    }

    // 3. Replaceable (Kinds 0, 3, 10000..19999)
    if (category === 'REPLACEABLE') {
      const existing = await db
        .prepare('SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? LIMIT 1')
        .bind(event.pubkey, event.kind)
        .first<{ id: string; created_at: number }>();

      if (existing) {
        if (existing.created_at > event.created_at) {
          results.push({ action: 'superseded', id: event.id, reason: 'older_timestamp' });
          continue;
        }
        if (existing.created_at === event.created_at && existing.id < event.id) {
          results.push({ action: 'superseded', id: event.id, reason: 'tie_break_id' });
          continue;
        }
        if (existing.id === event.id) {
          results.push({ action: 'ignored', id: event.id, reason: 'duplicate' });
          continue;
        }

        statements.push(db.prepare('DELETE FROM events WHERE id = ?').bind(existing.id));
      }

      const row = eventToEventRow(event);
      statements.push(
        db
          .prepare(
            'INSERT INTO events (id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(
            row.id,
            row.pubkey,
            row.created_at,
            row.kind,
            row.d_tag,
            row.raw_event,
            row.created_at_recorded
          )
      );

      const tags = extractIndexableTags(event);
      for (const tag of tags) {
        statements.push(
          db
            .prepare('INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)')
            .bind(event.id, tag.tagName, tag.tagValue)
        );
      }

      results.push({ action: 'inserted', id: event.id });
      cacheEventInMemory(event);
      metadataToWarmInKv.push(event);
      continue;
    }

    // 4. Parameterized Replaceable (Kinds 30000..39999)
    if (category === 'PARAMETERIZED_REPLACEABLE') {
      const dTag = extractDTag(event.tags);
      const existing = await db
        .prepare(
          'SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ? LIMIT 1'
        )
        .bind(event.pubkey, event.kind, dTag)
        .first<{ id: string; created_at: number }>();

      if (existing) {
        if (existing.created_at > event.created_at) {
          results.push({ action: 'superseded', id: event.id, reason: 'older_timestamp' });
          continue;
        }
        if (existing.created_at === event.created_at && existing.id < event.id) {
          results.push({ action: 'superseded', id: event.id, reason: 'tie_break_id' });
          continue;
        }
        if (existing.id === event.id) {
          results.push({ action: 'ignored', id: event.id, reason: 'duplicate' });
          continue;
        }

        statements.push(db.prepare('DELETE FROM events WHERE id = ?').bind(existing.id));
      }

      const row = eventToEventRow(event);
      statements.push(
        db
          .prepare(
            'INSERT INTO events (id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(
            row.id,
            row.pubkey,
            row.created_at,
            row.kind,
            row.d_tag,
            row.raw_event,
            row.created_at_recorded
          )
      );

      const tags = extractIndexableTags(event);
      for (const tag of tags) {
        statements.push(
          db
            .prepare('INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)')
            .bind(event.id, tag.tagName, tag.tagValue)
        );
      }

      results.push({ action: 'inserted', id: event.id });
      cacheEventInMemory(event);
      metadataToWarmInKv.push(event);
      continue;
    }

    // 5. Regular persistent events (Kinds 1, 2, 4..9999, etc.)
    const row = eventToEventRow(event);
    statements.push(
      db
        .prepare(
          'INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          row.id,
          row.pubkey,
          row.created_at,
          row.kind,
          row.d_tag,
          row.raw_event,
          row.created_at_recorded
        )
    );

    const tags = extractIndexableTags(event);
    for (const tag of tags) {
      statements.push(
        db
          .prepare(
            'INSERT OR IGNORE INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)'
          )
          .bind(event.id, tag.tagName, tag.tagValue)
      );
    }

    results.push({ action: 'inserted', id: event.id });
    cacheEventInMemory(event);
  }

  // Execute all aggregated D1 statements in safe batches
  if (statements.length > 0) {
    await executeBatchSafe(db, statements);
  }

  // Selectively warm only high-value metadata in KV (never regular feed events)
  if (kv && metadataToWarmInKv.length > 0) {
    await Promise.allSettled(metadataToWarmInKv.map((e) => putMetadataToKv(kv, e)));
  }

  return results;
}

/**
 * Executes one or more NIP-01 filters against D1, returning deduplicated matching events sorted by created_at DESC.
 * Automatically chunks large filter parameter arrays to prevent SQLite/D1 parameter limit errors.
 */
export async function queryEvents(
  db: D1Database,
  filters: NostrFilter[],
  options?: EventFilterQueryOptions
): Promise<NostrEvent[]> {
  if (filters.length === 0) {
    return [];
  }

  // Expand any filters containing arrays exceeding safe parameter limits (50 items max)
  const expandedFilters: NostrFilter[] = [];
  for (const filter of filters) {
    expandedFilters.push(...splitFilterForSafeQuery(filter));
  }

  const eventMap = new Map<string, NostrEvent>();
  let overallMaxLimit = options?.maxLimit ?? 500;

  for (const filter of expandedFilters) {
    const compiled = compileFilterToSql(filter, options);
    const result = await db
      .prepare(compiled.sql)
      .bind(...compiled.params)
      .all<EventRow>();

    if (result.results && Array.isArray(result.results)) {
      for (const row of result.results) {
        if (!eventMap.has(row.id)) {
          const event = rowToNostrEvent(row);
          eventMap.set(row.id, event);
          cacheEventInMemory(event);
        }
      }
    }

    if (filter.limit !== undefined) {
      overallMaxLimit = Math.max(overallMaxLimit, filter.limit);
    }
  }

  const sortedEvents = Array.from(eventMap.values()).sort(
    (a, b) => b.created_at - a.created_at
  );

  return sortedEvents.slice(0, overallMaxLimit);
}

/**
 * Multi-tier query resolver:
 * 1. Layer 0: High-speed In-Memory LRU Cache ($0 cost, 0ms latency).
 * 2. Layer 1: KV Namespace for point ID / metadata lookups if bound.
 * 3. Layer 2: Cloudflare D1 indexed SQLite for complex multi-filter and missed queries.
 *
 * Eliminates all write-back storms against KV.
 */
export async function queryEventsHybrid(
  db: D1Database,
  kv: KVNamespace | undefined,
  filters: NostrFilter[],
  options?: EventFilterQueryOptions
): Promise<NostrEvent[]> {
  if (filters.length === 0) {
    return [];
  }

  const eventMap = new Map<string, NostrEvent>();
  let overallMaxLimit = options?.maxLimit ?? 500;
  const d1FallbackFilters: NostrFilter[] = [];

  for (const filter of filters) {
    if (filter.limit !== undefined) {
      overallMaxLimit = Math.max(overallMaxLimit, filter.limit);
    }

    const hasTags = hasTagFilters(filter);
    const isPureIdLookup =
      Array.isArray(filter.ids) &&
      filter.ids.length > 0 &&
      !filter.authors &&
      !filter.kinds &&
      !filter.since &&
      !filter.until &&
      !hasTags;

    if (isPureIdLookup && filter.ids) {
      const memoryMisses: string[] = [];

      // 1. Check In-Memory L0 cache
      for (const id of filter.ids) {
        const memHit = memoryEventIdCache.get(id);
        if (memHit) {
          eventMap.set(memHit.id, memHit);
        } else {
          memoryMisses.push(id);
        }
      }

      if (memoryMisses.length === 0) {
        continue;
      }

      // 2. Check KV if available
      if (kv) {
        const { hits, misses } = await getEventsByIdsFromKv(kv, memoryMisses);
        for (const hit of hits) {
          eventMap.set(hit.id, hit);
          cacheEventInMemory(hit);
        }
        if (misses.length > 0) {
          d1FallbackFilters.push({ ...filter, ids: misses });
        }
      } else {
        d1FallbackFilters.push({ ...filter, ids: memoryMisses });
      }
      continue;
    }

    const isPureReplaceableLookup =
      Array.isArray(filter.authors) &&
      filter.authors.length > 0 &&
      Array.isArray(filter.kinds) &&
      filter.kinds.length === 1 &&
      typeof filter.kinds[0] === 'number' &&
      (filter.kinds[0] === 0 || filter.kinds[0] === 3 || filter.kinds[0] === 10002) &&
      !filter.ids &&
      !filter.since &&
      !filter.until &&
      !hasTags;

    if (isPureReplaceableLookup && filter.authors && filter.kinds) {
      const kind = filter.kinds[0];
      if (typeof kind !== 'number') {
        continue;
      }
      const missingAuthors: string[] = [];

      for (const author of filter.authors) {
        const replKey = getReplaceableKey(author, kind);
        const memHit = memoryReplaceableCache.get(replKey);
        if (memHit) {
          eventMap.set(memHit.id, memHit);
          continue;
        }

        if (kv) {
          const cached = await getReplaceableEventFromKv(kv, author, kind);
          if (cached) {
            eventMap.set(cached.id, cached);
            cacheEventInMemory(cached);
            continue;
          }
        }

        missingAuthors.push(author);
      }

      if (missingAuthors.length > 0) {
        d1FallbackFilters.push({ ...filter, authors: missingAuthors });
      }
      continue;
    }

    // Complex query: delegate directly to D1 indexed engine
    d1FallbackFilters.push(filter);
  }

  // If there are any misses or complex queries, fetch from D1
  if (d1FallbackFilters.length > 0) {
    const d1Events = await queryEvents(db, d1FallbackFilters, options);
    for (const evt of d1Events) {
      eventMap.set(evt.id, evt);
      cacheEventInMemory(evt);
    }

    // Selectively warm only high-value metadata in KV (never feed events)
    if (kv) {
      const metadataOnly = d1Events.filter(
        (e) => e.kind === 0 || e.kind === 3 || e.kind === 10002
      );
      if (metadataOnly.length > 0) {
        void Promise.allSettled(metadataOnly.map((e) => putMetadataToKv(kv, e)));
      }
    }
  }

  const sortedEvents = Array.from(eventMap.values()).sort(
    (a, b) => b.created_at - a.created_at
  );

  return sortedEvents.slice(0, overallMaxLimit);
}

/**
 * Counts matching events across NIP-01 filters for NIP-45 COUNT support.
 * Automatically chunks large filter parameter arrays to prevent SQLite/D1 parameter limit errors.
 */
export async function countEvents(
  db: D1Database,
  filters: NostrFilter[]
): Promise<number> {
  if (filters.length === 0) {
    return 0;
  }

  const expandedFilters: NostrFilter[] = [];
  for (const filter of filters) {
    expandedFilters.push(...splitFilterForSafeQuery(filter));
  }

  let totalCount = 0;
  for (const filter of expandedFilters) {
    const compiled = compileCountToSql(filter);
    const result = await db
      .prepare(compiled.sql)
      .bind(...compiled.params)
      .first<{ count: number }>();

    if (result && typeof result.count === 'number') {
      totalCount += result.count;
    }
  }

  return totalCount;
}

/**
 * Executes a search query (NIP-50 or Vector Search) returning NostrEvents ranked in descending similarity score order.
 */
export async function querySearchEvents(
  db: D1Database,
  env: Env,
  filter: NostrFilter,
  options?: EventFilterQueryOptions
): Promise<NostrEvent[]> {
  const limit = options?.maxLimit ?? 50;
  const searchResults = await executeSearch(db, env, filter, limit);
  return searchResults.map((r) => r.event);
}

/**
 * Scans D1 for any unindexed events and generates/upserts vector embeddings into Vectorize.
 * Called by scheduled cron jobs to reconcile vector store.
 */
export async function backfillUnindexedVectors(
  db: D1Database,
  env: Env,
  batchLimit = 150
): Promise<number> {
  if (!env.AI || !env.VECTOR_INDEX || env.VECTOR_SEARCH_ENABLED === 'false') {
    return 0;
  }

  // Find unindexed events (Kinds 0, 1, 30023, 9802)
  const rows = await db
    .prepare(
      'SELECT id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded FROM events WHERE (vector_indexed = 0 OR vector_indexed IS NULL) AND kind IN (0, 1, 30023, 9802) ORDER BY created_at DESC LIMIT ?'
    )
    .bind(batchLimit)
    .all<EventRow>();

  if (!rows.results || rows.results.length === 0) {
    return 0;
  }

  const events: NostrEvent[] = [];
  for (const row of rows.results) {
    events.push(rowToNostrEvent(row));
  }

  const indexedCount = await indexEventsBatchVector(
    env.AI,
    env.VECTOR_INDEX,
    events,
    env.VECTOR_EMBEDDING_MODEL
  );

  if (events.length > 0) {
    const placeholders = events.map(() => '?').join(', ');
    const eventIds = events.map((e) => e.id);
    await db
      .prepare(`UPDATE events SET vector_indexed = 1 WHERE id IN (${placeholders})`)
      .bind(...eventIds)
      .run();
  }

  return indexedCount;
}

/**
 * Loads operator moderation rules from D1 (NIP-51 kind 10000 and NIP-56 kind 1984).
 */
export async function loadOperatorModerationRules(
  db: D1Database,
  operatorPubkey: string
): Promise<ModerationRuleset> {
  const normPubkey = operatorPubkey.trim().toLowerCase();
  if (!normPubkey) {
    return createEmptyModerationRuleset();
  }

  const rows = await db
    .prepare(
      'SELECT raw_event FROM events WHERE pubkey = ? AND kind IN (?, ?) ORDER BY created_at DESC LIMIT 50'
    )
    .bind(normPubkey, 10000, 1984)
    .all<{ raw_event: string }>();

  if (!rows.results || rows.results.length === 0) {
    return createEmptyModerationRuleset();
  }

  const events: NostrEvent[] = [];
  for (const r of rows.results) {
    try {
      const parsed = JSON.parse(r.raw_event) as NostrEvent;
      events.push(parsed);
    } catch {
      // Ignore malformed raw events
    }
  }

  return extractModerationRulesFromEvents(events, normPubkey);
}

/**
 * Retroactively purges all events matching operator moderation rules from D1, KV, and Vectorize.
 */
export async function purgeModeratedEntities(
  db: D1Database,
  kv: KVNamespace | undefined,
  vectorIndex: VectorizeIndex | undefined,
  ruleset: ModerationRuleset
): Promise<{ purgedCount: number }> {
  let purgedCount = 0;
  const eventIdsToPurge = new Set<string>(ruleset.blockedEventIds);

  // 1. Find all event IDs authored by blocked pubkeys
  if (ruleset.blockedPubkeys.size > 0) {
    const pubkeys = Array.from(ruleset.blockedPubkeys);
    for (let i = 0; i < pubkeys.length; i += MAX_SQL_PARAM_ARRAY_SIZE) {
      const chunk = pubkeys.slice(i, i + MAX_SQL_PARAM_ARRAY_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await db
        .prepare(`SELECT id FROM events WHERE pubkey IN (${placeholders})`)
        .bind(...chunk)
        .all<{ id: string }>();

      if (rows.results && Array.isArray(rows.results)) {
        for (const row of rows.results) {
          eventIdsToPurge.add(row.id);
        }
      }
    }
  }

  if (eventIdsToPurge.size === 0) {
    return { purgedCount: 0 };
  }

  const allIds = Array.from(eventIdsToPurge);
  for (let i = 0; i < allIds.length; i += MAX_SQL_PARAM_ARRAY_SIZE) {
    const chunk = allIds.slice(i, i + MAX_SQL_PARAM_ARRAY_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');

    const deleteTagsStmt = db
      .prepare(`DELETE FROM event_tags WHERE event_id IN (${placeholders})`)
      .bind(...chunk);
    const deleteEventsStmt = db
      .prepare(`DELETE FROM events WHERE id IN (${placeholders})`)
      .bind(...chunk);

    await executeBatchSafe(db, [deleteTagsStmt, deleteEventsStmt]);
    purgedCount += chunk.length;

    // Invalidate L0 in-memory cache and L1 KV cache
    for (const id of chunk) {
      invalidateEventInMemory(id);
      if (kv) {
        void deleteEventFromKv(kv, id).catch(() => {});
      }
    }
  }

  // Delete from Vectorize index if provisioned
  if (vectorIndex && allIds.length > 0) {
    await deleteEventVectors(vectorIndex, allIds);
  }

  return { purgedCount };
}


