/**
 * Dashboard SQL Query Functions
 *
 * Each function is a self-contained, typed query against Cloudflare D1.
 * All parameters are bound — zero string interpolation of runtime values.
 * Individual query failures return empty/zero data and never throw, so a
 * partial DB outage degrades the dashboard gracefully rather than crashing it.
 */

import { getKindDescription } from '../http/stats';
import { shortenNpub } from '../protocol/nip19';
import type {
  AccountLeaderEntry,
  AgeBuckets,
  ClientEntry,
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
      db.prepare('SELECT COUNT(*) AS total FROM events WHERE vector_indexed = 1'),
      db.prepare(
        `SELECT
           (SELECT created_at FROM events ORDER BY created_at ASC LIMIT 1) AS oldest,
           (SELECT created_at FROM events ORDER BY created_at DESC LIMIT 1) AS newest`
      ),
    ]);

    const events = batchResults[0]?.results?.[0] as { total: number } | undefined;
    const authors = batchResults[1]?.results?.[0] as { total: number } | undefined;
    const tags = batchResults[2]?.results?.[0] as { total: number } | undefined;
    const vectors = batchResults[3]?.results?.[0] as { total: number } | undefined;
    const range = batchResults[4]?.results?.[0] as
      | { oldest: number | null; newest: number | null }
      | undefined;

    return {
      total_events: events?.total ?? 0,
      total_authors: authors?.total ?? 0,
      total_tags: tags?.total ?? 0,
      indexed_vectors: vectors?.total ?? 0,
      oldest_event_at: range?.oldest ?? null,
      newest_event_at: range?.newest ?? null,
    };
  } catch (err) {
    console.warn('[Dashboard] querySummary failed:', err);
    return {
      total_events: 0,
      total_authors: 0,
      total_tags: 0,
      indexed_vectors: 0,
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
  } catch (err) {
    console.warn('[Dashboard] queryHourlyTimeline failed:', err);
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
  } catch (err) {
    console.warn('[Dashboard] queryHourOfDay failed:', err);
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
  } catch (err) {
    console.warn('[Dashboard] queryDailyVolume failed:', err);
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
  } catch (err) {
    console.warn('[Dashboard] queryKindDistribution failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section B5 — Event Age Distribution (Single-Pass Conditional Aggregation)
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
    const row = await db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS lt1h,
           COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END), 0) AS h1to6,
           COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END), 0) AS h6to24,
           COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END), 0) AS d1to3,
           COALESCE(SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END), 0) AS d3to7
         FROM events
         WHERE created_at >= ?`
      )
      .bind(t1h, t6h, t1h, t24h, t6h, t3d, t24h, t7d, t3d, t7d)
      .first<{
        lt1h: number;
        h1to6: number;
        h6to24: number;
        d1to3: number;
        d3to7: number;
      }>();

    return {
      lt1h: row?.lt1h ?? 0,
      h1to6: row?.h1to6 ?? 0,
      h6to24: row?.h6to24 ?? 0,
      d1to3: row?.d1to3 ?? 0,
      d3to7: row?.d3to7 ?? 0,
    };
  } catch (err) {
    console.warn('[Dashboard] queryAgeBuckets failed:', err);
    return { lt1h: 0, h1to6: 0, h6to24: 0, d1to3: 0, d3to7: 0 };
  }
}

// ---------------------------------------------------------------------------
// Section B6 — Top Tag Usage (top 20 hashtags, full cache)
// ---------------------------------------------------------------------------

export async function queryTopTags(db: D1Database): Promise<TagEntry[]> {
  try {
    const result = await db
      .prepare(
        `SELECT LOWER(tag_value) AS tag_name, COUNT(*) AS count
         FROM event_tags
         WHERE tag_name = 't' AND tag_value != '' AND tag_value NOT IN ('d', 't', 'p', 'e', 'a', 'k', 'q', 'g', 'r')
         GROUP BY LOWER(tag_value)
         ORDER BY count DESC
         LIMIT 20`
      )
      .all<{ tag_name: string; count: number }>();
    return result.results ?? [];
  } catch (err) {
    console.warn('[Dashboard] queryTopTags failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Section B7 — Most Used Clients (top 15, full cache)
// ---------------------------------------------------------------------------

const KNOWN_CLIENT_NAMES: Record<string, string> = {
  damus: 'Damus',
  amethyst: 'Amethyst',
  coracle: 'Coracle',
  primal: 'Primal',
  'primal-web': 'Primal Web',
  'primal web': 'Primal Web',
  snort: 'Snort',
  yakihonne: 'Yakihonne',
  'nostr band': 'Nostr Band',
  'nostr-band': 'Nostr Band',
  iris: 'Iris',
  gossip: 'Gossip',
  lume: 'Lume',
  ditto: 'Ditto',
  nos: 'Nos',
  nostrudel: 'Nostrudel',
  habla: 'Habla',
  wikifreedia: 'Wikifreedia',
  zapstream: 'ZapStream',
  blowater: 'Blowater',
  satellite: 'Satellite',
  nostrchat: 'NostrChat',
  flock: 'Flock',
  nozzle: 'Nozzle',
  current: 'Current',
  simplex: 'SimpleX',
  futfut: 'FutFut',
  gleasonator: 'Gleasonator',
  'nostr-tools': 'nostr-tools',
};

/**
 * Normalizes client name strings into clean, human-readable display names.
 */
export function formatClientName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Unknown';
  const lower = trimmed.toLowerCase();
  if (KNOWN_CLIENT_NAMES[lower]) {
    return KNOWN_CLIENT_NAMES[lower];
  }
  // If it's a NIP-89 31990 address or similar identifier (31990:<pubkey>:<d_tag>)
  if (lower.startsWith('31990:')) {
    const parts = trimmed.split(':');
    return parts[2] ? `App: ${parts[2]}` : trimmed;
  }
  // Title-case single/multi-word client names
  return trimmed
    .split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export async function queryTopClients(db: D1Database): Promise<ClientEntry[]> {
  try {
    const result = await db
      .prepare(
        `SELECT tag_value AS client, COUNT(*) AS count
         FROM event_tags
         WHERE tag_name = 'client' AND tag_value != ''
         GROUP BY tag_value
         ORDER BY count DESC
         LIMIT 30`
      )
      .all<{ client: string; count: number }>();

    // Normalize and aggregate in memory to prevent expensive SQL functions
    const clientMap = new Map<string, number>();
    for (const r of result.results ?? []) {
      const formatted = formatClientName(r.client);
      clientMap.set(formatted, (clientMap.get(formatted) || 0) + r.count);
    }

    return Array.from(clientMap.entries())
      .map(([client, count]) => ({ client, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
  } catch (err) {
    console.warn('[Dashboard] queryTopClients failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Shared Profile Resolver Helper (Decoupled Batch Lookup)
// ---------------------------------------------------------------------------

export interface ProfileInfo {
  display_name: string | null;
  avatar_url: string | null;
}

/**
 * Batch resolves kind 0 display names and avatars for a list of pubkeys.
 * Avoids expensive SQLite table joins and runtime json_extract over millions of rows.
 */
export async function resolveProfiles(
  db: D1Database,
  pubkeys: readonly string[]
): Promise<Map<string, ProfileInfo>> {
  const profileMap = new Map<string, ProfileInfo>();
  const uniquePubkeys = Array.from(new Set(pubkeys.filter(Boolean)));
  if (uniquePubkeys.length === 0) return profileMap;

  const placeholders = uniquePubkeys.map(() => '?').join(', ');
  try {
    const result = await db
      .prepare(
        `SELECT pubkey, raw_event
         FROM events
         WHERE kind = 0 AND pubkey IN (${placeholders})`
      )
      .bind(...uniquePubkeys)
      .all<{ pubkey: string; raw_event: string }>();

    for (const row of result.results ?? []) {
      try {
        const raw = typeof row.raw_event === 'string' ? JSON.parse(row.raw_event) : row.raw_event;
        const content = typeof raw?.content === 'string' ? JSON.parse(raw.content) : raw?.content;
        const displayName =
          (content?.display_name && String(content.display_name).trim()) ||
          (content?.name && String(content.name).trim()) ||
          null;
        const avatarUrl =
          (content?.picture && String(content.picture).trim()) || null;

        profileMap.set(row.pubkey, {
          display_name: displayName,
          avatar_url: avatarUrl,
        });
      } catch {
        // Non-fatal if single profile content parse fails
      }
    }
  } catch (err) {
    console.warn('[Dashboard] resolveProfiles batch query failed:', err);
  }

  return profileMap;
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
        `SELECT pubkey, COUNT(*) AS count
         FROM events
         WHERE kind = 1 AND created_at >= ?
         GROUP BY pubkey
         ORDER BY count DESC
         LIMIT 10`
      )
      .bind(since)
      .all<{ pubkey: string; count: number }>();

    const rows = result.results ?? [];
    if (rows.length === 0) return [];

    const pubkeys = rows.map((r) => r.pubkey);
    const profiles = await resolveProfiles(db, pubkeys);

    return rows.map((r) => {
      const prof = profiles.get(r.pubkey);
      return {
        pubkey: r.pubkey,
        count: r.count,
        display_name: prof?.display_name || shortenNpub(r.pubkey),
        avatar_url: prof?.avatar_url ?? null,
      };
    });
  } catch (err) {
    console.warn('[Dashboard] queryTopPosters failed:', err);
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
        `SELECT pubkey, COUNT(*) AS count
         FROM events
         WHERE kind IN (6, 16) AND created_at >= ?
         GROUP BY pubkey
         ORDER BY count DESC
         LIMIT 10`
      )
      .bind(since)
      .all<{ pubkey: string; count: number }>();

    const rows = result.results ?? [];
    if (rows.length === 0) return [];

    const pubkeys = rows.map((r) => r.pubkey);
    const profiles = await resolveProfiles(db, pubkeys);

    return rows.map((r) => {
      const prof = profiles.get(r.pubkey);
      return {
        pubkey: r.pubkey,
        count: r.count,
        display_name: prof?.display_name || shortenNpub(r.pubkey),
        avatar_url: prof?.avatar_url ?? null,
      };
    });
  } catch (err) {
    console.warn('[Dashboard] queryTopSharers failed:', err);
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
        `SELECT tag_value AS pubkey, COUNT(*) AS count
         FROM event_tags
         WHERE tag_name = 'p'
         GROUP BY tag_value
         ORDER BY count DESC
         LIMIT 10`
      )
      .all<{ pubkey: string; count: number }>();

    const rows = result.results ?? [];
    if (rows.length === 0) return [];

    const pubkeys = rows.map((r) => r.pubkey);
    const profiles = await resolveProfiles(db, pubkeys);

    return rows.map((r) => {
      const prof = profiles.get(r.pubkey);
      return {
        pubkey: r.pubkey,
        count: r.count,
        display_name: prof?.display_name || shortenNpub(r.pubkey),
        avatar_url: prof?.avatar_url ?? null,
      };
    });
  } catch (err) {
    console.warn('[Dashboard] queryMostFollowed failed:', err);
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

    // Resolve display names & avatars for top 5 in a single batch
    const top5Pubkeys = top5.map((c) => c.pubkey);
    const profiles = await resolveProfiles(db, top5Pubkeys);

    // Build sparklines from the already-fetched hourlyTimeline for these pubkeys.
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
    } catch (err) {
      console.warn('[Dashboard] queryHot5 sparkline batch query failed:', err);
    }

    // Build a complete 168-slot hour array (last 7 days) for consistent sparkline width
    const baseHour = Math.floor((nowSeconds - SEVEN_DAYS_S) / 3600) * 3600;
    const totalHours = 168;

    return top5.map((c, i) => {
      const prof = profiles.get(c.pubkey);
      const display_name = prof?.display_name || shortenNpub(c.pubkey);
      const avatar_url = prof?.avatar_url ?? null;

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
        avatar_url,
        posts_24h: c.posts_24h,
        mentions_24h: c.mentions_24h,
        trend_score,
        trend_label,
        sparkline,
      };
    });
  } catch (err) {
    console.warn('[Dashboard] queryHot5 failed:', err);
    return [];
  }
}
