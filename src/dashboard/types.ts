/**
 * Dashboard Data Types
 *
 * Strongly-typed interfaces for all query result shapes, assembled dashboard
 * data, and relay metadata used by the hourly static dashboard generator.
 */

// ---------------------------------------------------------------------------
// Query result shapes
// ---------------------------------------------------------------------------

export interface HourlyBucket {
  readonly hour_bucket: number; // Unix epoch, truncated to the hour
  readonly count: number;
}

export interface DayBucket {
  readonly day_bucket: number; // Unix epoch, truncated to the day
  readonly count: number;
}

export interface HourOfDay {
  readonly hour_of_day: number; // 0–23
  readonly count: number;
}

export interface KindEntry {
  readonly kind: number;
  readonly name: string;
  readonly count: number;
}

export interface TagEntry {
  readonly tag_name: string;
  readonly count: number;
}

export interface AgeBuckets {
  readonly lt1h: number;
  readonly h1to6: number;
  readonly h6to24: number;
  readonly d1to3: number;
  readonly d3to7: number;
}

export interface AccountLeaderEntry {
  readonly pubkey: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
  readonly count: number;
}

export interface TrendingAccount {
  readonly pubkey: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
  readonly posts_24h: number;
  readonly mentions_24h: number;
  readonly trend_score: number;
  readonly trend_label: 'surging' | 'rising' | 'stable';
  readonly sparkline: readonly number[]; // hourly post counts for this pubkey, last 7 days
}

// ---------------------------------------------------------------------------
// Summary card data
// ---------------------------------------------------------------------------

export interface DashboardSummary {
  readonly total_events: number;
  readonly total_authors: number;
  readonly total_tags: number;
  readonly oldest_event_at: number | null;
  readonly newest_event_at: number | null;
}

// ---------------------------------------------------------------------------
// Relay info embedded at generation time from env vars
// ---------------------------------------------------------------------------

export interface RelayInfo {
  readonly name: string;
  readonly version: string;
  readonly pubkey: string;
  readonly contact: string;
  readonly upstream_relays: readonly string[];
  readonly gc_schedule: string;
}

// ---------------------------------------------------------------------------
// Assembled dashboard payload
// ---------------------------------------------------------------------------

export interface DashboardData {
  readonly generatedAt: number; // Unix epoch seconds
  readonly summary: DashboardSummary;
  readonly hourlyTimeline: readonly HourlyBucket[];      // B1: last 7 days, hourly
  readonly hourOfDay: readonly HourOfDay[];              // B2: 0–23 UTC pattern
  readonly dailyVolume: readonly DayBucket[];            // B3: last 7 days, daily
  readonly kindDist: readonly KindEntry[];               // B4: top 15 kinds
  readonly ageBuckets: AgeBuckets;                       // B5: freshness doughnut
  readonly topTags: readonly TagEntry[];                 // B6: top 20 hashtags
  readonly topPosters: readonly AccountLeaderEntry[];    // C1: most posts today
  readonly topSharers: readonly AccountLeaderEntry[];    // C2: most reposts 7d
  readonly mostFollowed: readonly AccountLeaderEntry[];  // C3: most followed
  readonly hot5: readonly TrendingAccount[];             // D: trending accounts
  readonly relay: RelayInfo;
}
