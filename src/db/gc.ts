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
