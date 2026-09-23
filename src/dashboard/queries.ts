/**
 * Dashboard SQL Query Functions
 *
 * Each function is a self-contained, typed query against Cloudflare D1.
 * All parameters are bound — zero string interpolation of runtime values.
 * Individual query failures return empty/zero data and never throw, so a
 * partial DB outage degrades the dashboard gracefully rather than crashing it.
 */

import { getKindDescription } from '../http/stats';
import type {
  AccountLeaderEntry,
  AgeBuckets,
  DashboardSummary,
  DayBucket,
  HourlyBucket,
  HourOfDay,
  KindEntry,
  TagEntry,
  TrendingAccount,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEVEN_DAYS_S = 7 * 24 * 3600; // 604800
const ONE_DAY_S = 86400;
const TWO_DAYS_S = 172800;
const FEED_KINDS = [1, 6, 7, 9735] as const;

// Minimum combined activity (last 48h) for a trending candidate
const TRENDING_MIN_ACTIVITY = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a parameterized IN clause placeholder string and returns the kinds array.
 */
function feedKindsSql(): { clause: string; values: readonly number[] } {
  return {
    clause: FEED_KINDS.map(() => '?').join(', '),
    values: FEED_KINDS,
  };
}

// ---------------------------------------------------------------------------
// Section A — Summary
// ---------------------------------------------------------------------------

export async function querySummary(db: D1Database): Promise<DashboardSummary> {
  try {
    const batchResults = await db.batch<
      { total: number } | { oldest: number | null; newest: number | null }
    >([
      db.prepare('SELECT COUNT(*) AS total FROM events'),
      db.prepare('SELECT COUNT(DISTINCT pubkey) AS total FROM events'),
      db.prepare('SELECT COUNT(*) AS total FROM event_tags'),
      db.prepare('SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM events'),
    ]);

    const events = batchResults[0]?.results?.[0] as { total: number } | undefined;
    const authors = batchResults[1]?.results?.[0] as { total: number } | undefined;
    const tags = batchResults[2]?.results?.[0] as { total: number } | undefined;
    const range = batchResults[3]?.results?.[0] as
      | { oldest: number | null; newest: number | null }
      | undefined;

    return {
      total_events: events?.total ?? 0,
      total_authors: authors?.total ?? 0,
      total_tags: tags?.total ?? 0,
      oldest_event_at: range?.oldest ?? null,
      newest_event_at: range?.newest ?? null,
    };
  } catch {
    return {
      total_events: 0,
      total_authors: 0,
      total_tags: 0,
      oldest_event_at: null,
      newest_event_at: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Section B1 — Hourly Activity Timeline (last 7 days, feed kinds)
// ---------------------------------------------------------------------------

export async function queryHourlyTimeline(
  db: D1Database,
  nowSeconds: number
): Promise<HourlyBucket[]> {
  const since = nowSeconds - SEVEN_DAYS_S;
  const { clause, values } = feedKindsSql();
  try {
    const result = await db
      .prepare(
        `SELECT (created_at / 3600) * 3600 AS hour_bucket, COUNT(*) AS count
         FROM events
         WHERE created_at >= ? AND kind IN (${clause})
         GROUP BY hour_bucket
         ORDER BY hour_bucket ASC`
      )
      .bind(since, ...values)
      .all<{ hour_bucket: number; count: number }>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section B2 — Hour-of-Day Pattern (full cache)
// ---------------------------------------------------------------------------

export async function queryHourOfDay(db: D1Database): Promise<HourOfDay[]> {
  try {
    const result = await db
      .prepare(
        `SELECT (created_at % 86400) / 3600 AS hour_of_day, COUNT(*) AS count
         FROM events
         GROUP BY hour_of_day
         ORDER BY hour_of_day ASC`
      )
      .all<{ hour_of_day: number; count: number }>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section B3 — Daily Event Volume (last 7 days, feed kinds)
// ---------------------------------------------------------------------------

export async function queryDailyVolume(
  db: D1Database,
  nowSeconds: number
): Promise<DayBucket[]> {
  const since = nowSeconds - SEVEN_DAYS_S;
  const { clause, values } = feedKindsSql();
  try {
    const result = await db
      .prepare(
        `SELECT (created_at / 86400) * 86400 AS day_bucket, COUNT(*) AS count
         FROM events
         WHERE created_at >= ? AND kind IN (${clause})
         GROUP BY day_bucket
         ORDER BY day_bucket ASC`
      )
      .bind(since, ...values)
      .all<{ day_bucket: number; count: number }>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section B4 — Kind Distribution (top 15, full cache)
// ---------------------------------------------------------------------------

export async function queryKindDistribution(db: D1Database): Promise<KindEntry[]> {
  try {
    const result = await db
      .prepare(
        `SELECT kind, COUNT(*) AS count
         FROM events
         GROUP BY kind
         ORDER BY count DESC
         LIMIT 15`
      )
      .all<{ kind: number; count: number }>();
    return (result.results ?? []).map((r) => ({
      kind: r.kind,
      name: getKindDescription(r.kind),
      count: r.count,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section B5 — Event Age Distribution (5 buckets, batched)
// ---------------------------------------------------------------------------

export async function queryAgeBuckets(
  db: D1Database,
  nowSeconds: number
): Promise<AgeBuckets> {
  const t1h = nowSeconds - 3600;
  const t6h = nowSeconds - 21600;
  const t24h = nowSeconds - ONE_DAY_S;
  const t3d = nowSeconds - 3 * ONE_DAY_S;
  const t7d = nowSeconds - SEVEN_DAYS_S;

  try {
    const ageBatch = await db.batch<{ count: number }>([
      db.prepare(`SELECT COUNT(*) AS count FROM events WHERE created_at >= ?`).bind(t1h),
      db
        .prepare(`SELECT COUNT(*) AS count FROM events WHERE created_at >= ? AND created_at < ?`)
        .bind(t6h, t1h),
      db
        .prepare(`SELECT COUNT(*) AS count FROM events WHERE created_at >= ? AND created_at < ?`)
        .bind(t24h, t6h),
      db
        .prepare(`SELECT COUNT(*) AS count FROM events WHERE created_at >= ? AND created_at < ?`)
        .bind(t3d, t24h),
      db
        .prepare(`SELECT COUNT(*) AS count FROM events WHERE created_at >= ? AND created_at < ?`)
        .bind(t7d, t3d),
    ]);

    return {
      lt1h: (ageBatch[0]?.results?.[0] as { count: number } | undefined)?.count ?? 0,
      h1to6: (ageBatch[1]?.results?.[0] as { count: number } | undefined)?.count ?? 0,
      h6to24: (ageBatch[2]?.results?.[0] as { count: number } | undefined)?.count ?? 0,
      d1to3: (ageBatch[3]?.results?.[0] as { count: number } | undefined)?.count ?? 0,
      d3to7: (ageBatch[4]?.results?.[0] as { count: number } | undefined)?.count ?? 0,
    };
  } catch {
    return { lt1h: 0, h1to6: 0, h6to24: 0, d1to3: 0, d3to7: 0 };
  }
}

// ---------------------------------------------------------------------------
// Section B6 — Top Tag Usage (top 20, full cache)
// ---------------------------------------------------------------------------

export async function queryTopTags(db: D1Database): Promise<TagEntry[]> {
  try {
    const result = await db
      .prepare(
        `SELECT tag_name, COUNT(*) AS count
         FROM event_tags
         GROUP BY tag_name
         ORDER BY count DESC
         LIMIT 20`
      )
      .all<{ tag_name: string; count: number }>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Shared leaderboard SQL helper
// ---------------------------------------------------------------------------

/**
 * Profile name resolution expression using SQLite json_extract.
 * Kind 0 raw_event has the structure: {"content":"{\"name\":\"...\"}"}
 * content is a JSON string inside the outer JSON, requiring double extraction.
 */
function profileNameExpr(pubkeyExpr: string, profileAlias: string): string {
  return `COALESCE(
    json_extract(json_extract(${profileAlias}.raw_event, '$.content'), '$.name'),
    json_extract(json_extract(${profileAlias}.raw_event, '$.content'), '$.display_name'),
    SUBSTR(${pubkeyExpr}, 1, 16) || '...'
  )`;
}

// ---------------------------------------------------------------------------
// Section C1 — Most Active Posters (kind 1, last 24h)
// ---------------------------------------------------------------------------

export async function queryTopPosters(
  db: D1Database,
  nowSeconds: number
): Promise<AccountLeaderEntry[]> {
  const since = nowSeconds - ONE_DAY_S;
  try {
    const result = await db
      .prepare(
        `SELECT
           e.pubkey,
           COUNT(*) AS count,
           ${profileNameExpr('e.pubkey', 'p')} AS display_name
         FROM events e
         LEFT JOIN events p ON p.pubkey = e.pubkey AND p.kind = 0
         WHERE e.kind = 1 AND e.created_at >= ?
         GROUP BY e.pubkey
         ORDER BY count DESC
         LIMIT 10`
      )
      .bind(since)
      .all<{ pubkey: string; count: number; display_name: string }>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section C2 — Most Active Article Sharers (kinds 6 & 16, last 7 days)
// ---------------------------------------------------------------------------

export async function queryTopSharers(
  db: D1Database,
  nowSeconds: number
): Promise<AccountLeaderEntry[]> {
  const since = nowSeconds - SEVEN_DAYS_S;
  try {
    const result = await db
      .prepare(
        `SELECT
           e.pubkey,
           COUNT(*) AS count,
           ${profileNameExpr('e.pubkey', 'p')} AS display_name
         FROM events e
         LEFT JOIN events p ON p.pubkey = e.pubkey AND p.kind = 0
         WHERE e.kind IN (6, 16) AND e.created_at >= ?
         GROUP BY e.pubkey
         ORDER BY count DESC
         LIMIT 10`
      )
      .bind(since)
      .all<{ pubkey: string; count: number; display_name: string }>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section C3 — Most Followed Accounts
// ---------------------------------------------------------------------------

export async function queryMostFollowed(db: D1Database): Promise<AccountLeaderEntry[]> {
  try {
    const result = await db
      .prepare(
        `SELECT
           t.tag_value AS pubkey,
           COUNT(DISTINCT e.pubkey) AS count,
           ${profileNameExpr('t.tag_value', 'p')} AS display_name
         FROM event_tags t
         JOIN events e ON t.event_id = e.id AND e.kind = 3
         LEFT JOIN events p ON p.pubkey = t.tag_value AND p.kind = 0
         WHERE t.tag_name = 'p'
         GROUP BY t.tag_value
         ORDER BY count DESC
         LIMIT 10`
      )
      .all<{ pubkey: string; count: number; display_name: string }>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section C4 — Most Following Accounts
// ---------------------------------------------------------------------------

export async function queryMostFollowing(db: D1Database): Promise<AccountLeaderEntry[]> {
  try {
    const result = await db
      .prepare(
        `SELECT
           e.pubkey,
           COUNT(t.tag_value) AS count,
           ${profileNameExpr('e.pubkey', 'p')} AS display_name
         FROM events e
         JOIN event_tags t ON t.event_id = e.id AND t.tag_name = 'p'
         LEFT JOIN events p ON p.pubkey = e.pubkey AND p.kind = 0
         WHERE e.kind = 3
         GROUP BY e.pubkey
         ORDER BY count DESC
         LIMIT 10`
      )
      .all<{ pubkey: string; count: number; display_name: string }>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section D — Hot 5 Trending Accounts
// ---------------------------------------------------------------------------

interface TrendWindowRow {
  readonly pubkey: string;
  readonly count: number;
}

interface MentionWindowRow {
  readonly pubkey: string;
  readonly count: number;
}

/**
 * Computes the top 5 trending accounts using post velocity and mention velocity.
 *
 * - Post velocity: kind 1 posts in last 24h vs prior 24–48h window
 * - Mention velocity: #p tag appearances in last 24h vs prior 24–48h window
 * - Combined trend_score = (post_ratio * 0.4) + (mention_ratio * 0.6)
 * - Minimum gate: total activity in 48h window >= TRENDING_MIN_ACTIVITY
 *
 * Also attaches per-pubkey sparkline data from the hourly timeline query result.
 */
export async function queryHot5(
  db: D1Database,
  nowSeconds: number,
  _hourlyTimeline?: readonly { hour_bucket: number; count: number }[]
): Promise<TrendingAccount[]> {
  const t24h = nowSeconds - ONE_DAY_S;
  const t48h = nowSeconds - TWO_DAYS_S;

  try {
    // 4 batch queries: post_24h, post_prev, mention_24h, mention_prev
    const batchRes = await db.batch<
      TrendWindowRow | MentionWindowRow
    >([
      // Posts in last 24h
      db
        .prepare(
          `SELECT pubkey, COUNT(*) AS count
           FROM events
           WHERE kind = 1 AND created_at >= ?
           GROUP BY pubkey`
        )
        .bind(t24h),
      // Posts in prior 24–48h
      db
        .prepare(
          `SELECT pubkey, COUNT(*) AS count
           FROM events
           WHERE kind = 1 AND created_at >= ? AND created_at < ?
           GROUP BY pubkey`
        )
        .bind(t48h, t24h),
      // Mentions in last 24h (#p tags in kinds 1,6,7)
      db
        .prepare(
          `SELECT t.tag_value AS pubkey, COUNT(*) AS count
           FROM event_tags t
           JOIN events e ON t.event_id = e.id AND e.kind IN (1, 6, 7)
           WHERE t.tag_name = 'p' AND e.created_at >= ?
           GROUP BY t.tag_value`
        )
        .bind(t24h),
      // Mentions in prior 24–48h
      db
        .prepare(
          `SELECT t.tag_value AS pubkey, COUNT(*) AS count
           FROM event_tags t
           JOIN events e ON t.event_id = e.id AND e.kind IN (1, 6, 7)
           WHERE t.tag_name = 'p' AND e.created_at >= ? AND e.created_at < ?
           GROUP BY t.tag_value`
        )
        .bind(t48h, t24h),
    ]);

    // Build lookup maps
    const postsNowMap = new Map<string, number>();
    const postsPrevMap = new Map<string, number>();
    const mentionsNowMap = new Map<string, number>();
    const mentionsPrevMap = new Map<string, number>();

    const postsNowRows = (batchRes[0]?.results ?? []) as TrendWindowRow[];
    for (const r of postsNowRows) {
      postsNowMap.set(r.pubkey, r.count);
    }
    const postsPrevRows = (batchRes[1]?.results ?? []) as TrendWindowRow[];
    for (const r of postsPrevRows) {
      postsPrevMap.set(r.pubkey, r.count);
    }
    const mentionsNowRows = (batchRes[2]?.results ?? []) as MentionWindowRow[];
    for (const r of mentionsNowRows) {
      mentionsNowMap.set(r.pubkey, r.count);
    }
    const mentionsPrevRows = (batchRes[3]?.results ?? []) as MentionWindowRow[];
    for (const r of mentionsPrevRows) {
      mentionsPrevMap.set(r.pubkey, r.count);
    }

    // Union all candidate pubkeys from both post and mention windows
    const candidates = new Set<string>([
      ...postsNowMap.keys(),
      ...postsPrevMap.keys(),
      ...mentionsNowMap.keys(),
      ...mentionsPrevMap.keys(),
    ]);

    type ScoredCandidate = {
      pubkey: string;
      posts_24h: number;
      mentions_24h: number;
      trend_score: number;
    };

    const scored: ScoredCandidate[] = [];

    for (const pubkey of candidates) {
      const postsNowCount = postsNowMap.get(pubkey) ?? 0;
      const postsPrevCount = postsPrevMap.get(pubkey) ?? 0;
      const mentionsNowCount = mentionsNowMap.get(pubkey) ?? 0;
      const mentionsPrevCount = mentionsPrevMap.get(pubkey) ?? 0;

      const total48h = postsNowCount + postsPrevCount + mentionsNowCount + mentionsPrevCount;
      if (total48h < TRENDING_MIN_ACTIVITY) {
        continue;
      }

      const postRatio = postsNowCount / Math.max(postsPrevCount, 1);
      const mentionRatio = mentionsNowCount / Math.max(mentionsPrevCount, 1);
      const trend_score = postRatio * 0.4 + mentionRatio * 0.6;

      scored.push({ pubkey, posts_24h: postsNowCount, mentions_24h: mentionsNowCount, trend_score });
    }

    // Sort descending by trend_score, take top 5
    scored.sort((a, b) => b.trend_score - a.trend_score);
    const top5 = scored.slice(0, 5);

    if (top5.length === 0) {
      return [];
    }

    // Resolve display names for top 5 in a single batch
    const nameStmts = top5.map((c) =>
      db
        .prepare(
          `SELECT
             ${profileNameExpr('e.pubkey', 'e')} AS display_name
           FROM events e
           WHERE e.pubkey = ? AND e.kind = 0
           LIMIT 1`
        )
        .bind(c.pubkey)
    );

    let nameResults: Array<{ display_name: string } | undefined> = [];
    try {
      const nameBatch = await db.batch<{ display_name: string }>(nameStmts);
      nameResults = nameBatch.map((r) => r.results[0] as { display_name: string } | undefined);
    } catch {
      // Non-fatal — fall back to pubkey abbreviation
    }

    // Build sparklines from the already-fetched hourlyTimeline for these pubkeys.
    // The hourlyTimeline is an aggregated view (all pubkeys combined), so we run
    // per-pubkey sparkline queries only for the 5 winners to keep query count low.
    const sparklineStmts = top5.map((c) =>
      db
        .prepare(
          `SELECT (created_at / 3600) * 3600 AS hour_bucket, COUNT(*) AS count
           FROM events
           WHERE pubkey = ? AND kind = 1 AND created_at >= ?
           GROUP BY hour_bucket
           ORDER BY hour_bucket ASC`
        )
        .bind(c.pubkey, nowSeconds - SEVEN_DAYS_S)
    );

    let sparklineResults: Array<{ results: Array<{ hour_bucket: number; count: number }> }> = [];
    try {
      sparklineResults = await db.batch<{ hour_bucket: number; count: number }>(sparklineStmts);
    } catch {
      // Non-fatal
    }

    // Build a complete 168-slot hour array (last 7 days) for consistent sparkline width
    const baseHour = Math.floor((nowSeconds - SEVEN_DAYS_S) / 3600) * 3600;
    const totalHours = 168;

    return top5.map((c, i) => {
      const nameRow = nameResults[i];
      const display_name =
        nameRow?.display_name ?? `${c.pubkey.slice(0, 16)}...`;

      const sparklineRows: Array<{ hour_bucket: number; count: number }> =
        sparklineResults[i]?.results ?? [];
      const sparkMap = new Map<number, number>(
        sparklineRows.map((r) => [r.hour_bucket, r.count])
      );
      const sparkline: number[] = [];
      for (let h = 0; h < totalHours; h++) {
        sparkline.push(sparkMap.get(baseHour + h * 3600) ?? 0);
      }

      const trend_score = c.trend_score;
      const trend_label: TrendingAccount['trend_label'] =
        trend_score >= 3 ? 'surging' : trend_score >= 1.5 ? 'rising' : 'stable';

      return {
        pubkey: c.pubkey,
        display_name,
        posts_24h: c.posts_24h,
        mentions_24h: c.mentions_24h,
        trend_score,
        trend_label,
        sparkline,
      };
    });
  } catch {
    return [];
  }
}
