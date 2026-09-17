import {
  deleteEventFromKv,
  getEventsByIdsFromKv,
  getReplaceableEventFromKv,
  putEventToKv,
} from '../cache';
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
 * Saves a batch of Nostr events efficiently into Cloudflare D1 and warms L1 KV cache.
 * Uses atomic statements batching to minimize D1 round-trips.
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
  const eventsToWarmInKv: NostrEvent[] = [];

  for (const event of events) {
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
      eventsToWarmInKv.push(event);

      // Invalidate target event IDs in KV if kv is bound
      if (kv && Array.isArray(event.tags)) {
        for (const tag of event.tags) {
          if (Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string') {
            void deleteEventFromKv(kv, tag[1]);
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
      eventsToWarmInKv.push(event);
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
      eventsToWarmInKv.push(event);
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
    eventsToWarmInKv.push(event);
  }

  // Execute all aggregated D1 statements in safe batches
  if (statements.length > 0) {
    await executeBatchSafe(db, statements);
  }

  // Warm L1 KV cache concurrently (capped at 2 hours max TTL)
  if (kv && eventsToWarmInKv.length > 0) {
    void Promise.allSettled(eventsToWarmInKv.map((e) => putEventToKv(kv, e)));
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
          eventMap.set(row.id, rowToNostrEvent(row));
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
 * Hybrid query resolver:
 * Routes point lookups (ids, single author profiles, relay lists) to L1 KV first.
 * Falls back to D1 for cache misses or complex queries, warming KV upon D1 response.
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

  // If KV is not bound, query D1 directly
  if (!kv) {
    return queryEvents(db, filters, options);
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
      const { hits, misses } = await getEventsByIdsFromKv(kv, filter.ids);
      for (const hit of hits) {
        eventMap.set(hit.id, hit);
      }
      if (misses.length > 0) {
        d1FallbackFilters.push({ ...filter, ids: misses });
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
        const cached = await getReplaceableEventFromKv(kv, author, kind);
        if (cached) {
          eventMap.set(cached.id, cached);
        } else {
          missingAuthors.push(author);
        }
      }

      if (missingAuthors.length > 0) {
        d1FallbackFilters.push({ ...filter, authors: missingAuthors });
      }
      continue;
    }

    // Complex query: delegate to D1
    d1FallbackFilters.push(filter);
  }

  // If there are any misses or complex queries, fetch from D1
  if (d1FallbackFilters.length > 0) {
    const d1Events = await queryEvents(db, d1FallbackFilters, options);
    for (const evt of d1Events) {
      eventMap.set(evt.id, evt);
    }
    // Warm KV in background with retrieved D1 events
    void Promise.allSettled(d1Events.map((e) => putEventToKv(kv, e)));
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
