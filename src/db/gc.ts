import { deleteEventVectors } from '../search';
import { inspectEventModeration, type ModerationRuleset } from '../security';
import { rowToNostrEvent } from './classifier';
import {
  executeBatchSafe,
  loadOperatorModerationRules,
  MAX_SQL_PARAM_ARRAY_SIZE,
  memoryEventIdCache,
  memoryReplaceableCache,
} from './repository';
import type { EventRow } from './types';

/**
 * Rolling Expiration Garbage Collection Engine
 * 
 * Performs scheduled, classification-aware pruning of events in Cloudflare D1
 * based on ingestion timestamp (`created_at_recorded`) and Nostr event semantics.
 */

export interface GCTierConfig {
  readonly name: string;
  readonly kinds?: readonly number[];
  readonly kindRange?: readonly [number, number];
  readonly excludeKinds?: readonly number[];
  readonly excludeKindRanges?: readonly (readonly [number, number])[];
  readonly ttlSeconds: number;
}

export interface GCResult {
  readonly totalPruned: number;
  readonly breakdown: Record<string, number>;
  readonly durationMs: number;
  readonly timestamp: number;
}

export interface GCOptions {
  readonly batchSize?: number;
  readonly maxBatchesPerTier?: number;
  readonly customTiers?: readonly GCTierConfig[];
  readonly nowSeconds?: number;
}

export interface PruneAllOptions {
  readonly preserveOperator?: boolean;
  readonly operatorPubkey?: string;
  readonly batchSize?: number;
}

export interface PruneAllResult {
  readonly purgedEvents: number;
  readonly purgedTags: number;
  readonly durationMs: number;
  readonly preservedOperatorEvents: number;
}

export interface ModerationScanResult {
  readonly scannedCount: number;
  readonly purgedCount: number;
  readonly durationMs: number;
}

/**
 * Standard default rolling retention schedule by event classification:
 * - Feed events (kinds 1, 6, 7, 9735): 7 days
 * - Parameterized Replaceable (kinds 30000..39999): 30 days
 * - Deletion tombstones (kind 5): 90 days
 * - User state & profiles (kinds 0, 3, 10002): 180 days
 * - Standard replaceable events (kinds 10000..19999): 180 days
 * - General persistent fallback (all other persistent kinds): 14 days
 */
export const DEFAULT_GC_TIERS: readonly GCTierConfig[] = [
  {
    name: 'feed_events',
    kinds: [1, 6, 7, 9735],
    ttlSeconds: 7 * 86400, // 7 days
  },
  {
    name: 'parameterized_replaceable',
    kindRange: [30000, 39999],
    ttlSeconds: 30 * 86400, // 30 days
  },
  {
    name: 'deletion_tombstones',
    kinds: [5],
    ttlSeconds: 90 * 86400, // 90 days
  },
  {
    name: 'user_state_and_lists',
    kinds: [0, 3, 10002],
    ttlSeconds: 180 * 86400, // 180 days
  },
  {
    name: 'standard_replaceable',
    kindRange: [10000, 19999],
    ttlSeconds: 180 * 86400, // 180 days
  },
  {
    name: 'general_persistent_fallback',
    excludeKinds: [0, 1, 3, 5, 6, 7, 9735, 10002],
    excludeKindRanges: [
      [10000, 19999],
      [30000, 39999],
    ],
    ttlSeconds: 14 * 86400, // 14 days
  },
] as const;

export const DEFAULT_GC_BATCH_SIZE = 500;
export const DEFAULT_MAX_BATCHES_PER_TIER = 10;

/**
 * Prunes a single batch of events for a specific tier configuration.
 * Uses parameterized SQLite subqueries to safely bound the deletion size.
 */
export async function pruneTierBatch(
  db: D1Database,
  tier: GCTierConfig,
  cutoffTimestamp: number,
  batchSize: number
): Promise<number> {
  const whereClauses: string[] = [];
  const params: (number | string)[] = [];

  if (tier.kinds && tier.kinds.length > 0) {
    const placeholders = tier.kinds.map(() => '?').join(', ');
    whereClauses.push(`kind IN (${placeholders})`);
    params.push(...tier.kinds);
  } else if (tier.kindRange) {
    whereClauses.push('kind >= ? AND kind <= ?');
    params.push(tier.kindRange[0], tier.kindRange[1]);
  }

  if (tier.excludeKinds && tier.excludeKinds.length > 0) {
    const placeholders = tier.excludeKinds.map(() => '?').join(', ');
    whereClauses.push(`kind NOT IN (${placeholders})`);
    params.push(...tier.excludeKinds);
  }

  if (tier.excludeKindRanges && tier.excludeKindRanges.length > 0) {
    for (const [minK, maxK] of tier.excludeKindRanges) {
      whereClauses.push('NOT (kind >= ? AND kind <= ?)');
      params.push(minK, maxK);
    }
  }

  whereClauses.push('created_at_recorded < ?');
  params.push(cutoffTimestamp);

  const subquerySql = `SELECT id FROM events WHERE ${whereClauses.join(' AND ')} LIMIT ?`;
  params.push(batchSize);

  // Execute subquery to find target IDs
  const targetRows = await db
    .prepare(subquerySql)
    .bind(...params)
    .all<{ id: string }>();

  if (!targetRows.results || targetRows.results.length === 0) {
    return 0;
  }

  const idsToDelete = targetRows.results.map((r) => r.id);
  const inPlaceholders = idsToDelete.map(() => '?').join(', ');

  // Delete from events and event_tags
  const deleteEventsStmt = db
    .prepare(`DELETE FROM events WHERE id IN (${inPlaceholders})`)
    .bind(...idsToDelete);

  const deleteTagsStmt = db
    .prepare(`DELETE FROM event_tags WHERE event_id IN (${inPlaceholders})`)
    .bind(...idsToDelete);

  // Batch delete events and their corresponding tags
  await db.batch([deleteTagsStmt, deleteEventsStmt]);

  return idsToDelete.length;
}

/**
 * Runs a complete garbage collection cycle across all configured tiers.
 */
export async function runGarbageCollection(
  db: D1Database,
  options?: GCOptions
): Promise<GCResult> {
  const startTime = Date.now();
  const nowSeconds = options?.nowSeconds ?? Math.floor(startTime / 1000);
  const batchSize = options?.batchSize ?? DEFAULT_GC_BATCH_SIZE;
  const maxBatchesPerTier = options?.maxBatchesPerTier ?? DEFAULT_MAX_BATCHES_PER_TIER;
  const tiers = options?.customTiers ?? DEFAULT_GC_TIERS;

  let totalPruned = 0;
  const breakdown: Record<string, number> = {};

  for (const tier of tiers) {
    let tierPruned = 0;
    const cutoffTimestamp = nowSeconds - tier.ttlSeconds;

    for (let batchIndex = 0; batchIndex < maxBatchesPerTier; batchIndex++) {
      const deletedCount = await pruneTierBatch(db, tier, cutoffTimestamp, batchSize);
      tierPruned += deletedCount;
      totalPruned += deletedCount;

      // If we deleted fewer than the batch size, this tier is exhausted
      if (deletedCount < batchSize) {
        break;
      }
    }

    breakdown[tier.name] = tierPruned;
  }

  const durationMs = Date.now() - startTime;

  return {
    totalPruned,
    breakdown,
    durationMs,
    timestamp: nowSeconds,
  };
}

/**
 * Completely purges all cached events from D1, KV, Vectorize, and in-memory caches.
 * When `preserveOperator: true` (default when operatorPubkey is provided), events authored by `operatorPubkey` are retained.
 */
export async function pruneEntireCache(
  db: D1Database,
  _kv?: KVNamespace,
  vectorIndex?: VectorizeIndex,
  options?: PruneAllOptions
): Promise<PruneAllResult> {
  const startTime = Date.now();
  const preserveOperator = options?.preserveOperator ?? Boolean(options?.operatorPubkey);
  const operatorPubkey = options?.operatorPubkey?.trim().toLowerCase();
  const batchSize = options?.batchSize ?? 500;

  let purgedEvents = 0;
  let purgedTags = 0;
  let preservedOperatorEvents = 0;

  if (preserveOperator && operatorPubkey) {
    // Count preserved operator events
    const countRow = await db
      .prepare('SELECT COUNT(*) AS count FROM events WHERE LOWER(pubkey) = ?')
      .bind(operatorPubkey)
      .first<{ count: number }>();
    preservedOperatorEvents = countRow?.count ?? 0;

    // Iteratively delete all non-operator events in batches
    while (true) {
      const rows = await db
        .prepare('SELECT id FROM events WHERE LOWER(pubkey) != ? LIMIT ?')
        .bind(operatorPubkey, batchSize)
        .all<{ id: string }>();

      if (!rows.results || rows.results.length === 0) {
        break;
      }

      const ids = rows.results.map((r) => r.id);
      for (let i = 0; i < ids.length; i += MAX_SQL_PARAM_ARRAY_SIZE) {
        const chunk = ids.slice(i, i + MAX_SQL_PARAM_ARRAY_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');

        const delTags = db.prepare(`DELETE FROM event_tags WHERE event_id IN (${placeholders})`).bind(...chunk);
        const delEvents = db.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).bind(...chunk);

        await executeBatchSafe(db, [delTags, delEvents]);
        purgedEvents += chunk.length;
      }

      // Delete from Vectorize
      if (vectorIndex) {
        await deleteEventVectors(vectorIndex, ids);
      }
    }
  } else {
    // Full blank-slate wipe
    const countTagsRow = await db.prepare('SELECT COUNT(*) AS count FROM event_tags').first<{ count: number }>();
    const countEventsRow = await db.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>();
    purgedTags = countTagsRow?.count ?? 0;
    purgedEvents = countEventsRow?.count ?? 0;

    await executeBatchSafe(db, [
      db.prepare('DELETE FROM event_tags'),
      db.prepare('DELETE FROM events'),
    ]);
  }

  // Clear L0 in-memory caches
  memoryEventIdCache.clear();
  memoryReplaceableCache.clear();

  const durationMs = Date.now() - startTime;

  return {
    purgedEvents,
    purgedTags,
    durationMs,
    preservedOperatorEvents,
  };
}

/**
 * Scans all existing D1 events and retroactively removes any violating NIP-36, NIP-32, or operator moderation rules.
 */
export async function scanAndPurgeModeratedEvents(
  db: D1Database,
  _kv?: KVNamespace,
  vectorIndex?: VectorizeIndex,
  operatorPubkey?: string,
  options?: { batchSize?: number }
): Promise<ModerationScanResult> {
  const startTime = Date.now();
  const batchSize = options?.batchSize ?? 250;

  let ruleset: ModerationRuleset | undefined;
  if (operatorPubkey) {
    ruleset = await loadOperatorModerationRules(db, operatorPubkey);
  }

  let scannedCount = 0;
  let purgedCount = 0;
  let offset = 0;

  while (true) {
    const rows = await db
      .prepare('SELECT id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded FROM events ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .bind(batchSize, offset)
      .all<EventRow>();

    if (!rows.results || rows.results.length === 0) {
      break;
    }

    scannedCount += rows.results.length;
    const idsToPurge: string[] = [];

    for (const row of rows.results) {
      try {
        const event = rowToNostrEvent(row);
        const moderation = inspectEventModeration(event, ruleset);
        if (!moderation.allowed) {
          idsToPurge.push(event.id);
        }
      } catch {
        // Corrupt row, flag for purge
        idsToPurge.push(row.id);
      }
    }

    if (idsToPurge.length > 0) {
      for (let i = 0; i < idsToPurge.length; i += MAX_SQL_PARAM_ARRAY_SIZE) {
        const chunk = idsToPurge.slice(i, i + MAX_SQL_PARAM_ARRAY_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');

        const delTags = db.prepare(`DELETE FROM event_tags WHERE event_id IN (${placeholders})`).bind(...chunk);
        const delEvents = db.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).bind(...chunk);

        await executeBatchSafe(db, [delTags, delEvents]);
        purgedCount += chunk.length;
      }

      if (vectorIndex) {
        await deleteEventVectors(vectorIndex, idsToPurge);
      }
    }

    // Advance offset by number of retained (non-deleted) rows in this page
    offset += (rows.results.length - idsToPurge.length);
  }

  const durationMs = Date.now() - startTime;

  return {
    scannedCount,
    purgedCount,
    durationMs,
  };
}

