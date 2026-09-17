import {
  DEFAULT_GC_BATCH_SIZE,
  DEFAULT_GC_TIERS,
  DEFAULT_MAX_BATCHES_PER_TIER,
} from '../db/gc';
import {
  DEFAULT_KV_TTL_SECONDS,
  MAX_KV_TTL_SECONDS,
  MIN_KV_TTL_SECONDS,
} from '../cache/kv-cache';
import { RATE_LIMIT_DEFAULTS } from '../security/rate-limiter';
import type { Env } from '../types/env';
import { DEFAULT_UPSTREAM_RELAYS } from '../upstream/pool-manager';
import { APP_NAME, APP_VERSION } from '../version';
import { jsonResponse } from './cors';

export interface KindDistribution {
  kind: number;
  name: string;
  count: number;
}

export interface KvPrefixCounts {
  events: number;
  profiles: number;
  relays: number;
  contacts: number;
  replaceable: number;
  parameterized: number;
  other: number;
}

export interface KvStats {
  status: 'active' | 'disabled' | 'error';
  configured: boolean;
  ttl_seconds: {
    default: number;
    min: number;
    max: number;
  };
  key_prefixes: string[];
  latency_ms: number | null;
  sample_keys_count: number;
  keys_by_prefix: KvPrefixCounts;
  list_complete: boolean;
  error?: string;
}

export interface RelayStatsResponse {
  timestamp: number;
  service: string;
  version: string;
  cache: {
    total_events: number;
    total_tags: number;
    total_authors: number;
    time_range: {
      oldest_event_at: number | null;
      newest_event_at: number | null;
    };
    kind_distribution: KindDistribution[];
  };
  kv: KvStats;
  relay: {
    name: string;
    description: string;
    pubkey: string;
    contact: string;
    read_only: boolean;
    allow_direct_writes: boolean;
  };
  security: {
    rate_limits: {
      ip_handshake_per_min: number;
      messages_per_window: number;
      pubkey_writes_per_min: number;
    };
  };
  gc: {
    schedule: string;
    batch_size: number;
    max_batches_per_tier: number;
    tiers: Array<{ name: string; ttl_days: number; ttl_seconds: number }>;
  };
  upstreams: {
    configured: string[];
    total_configured: number;
    timeout_ms: number;
  };
}

export const KV_KEY_PREFIXES = [
  'evt:',
  'profile:',
  'relays:',
  'contacts:',
  'replaceable:',
  'param:',
] as const;

const KNOWN_KIND_DESCRIPTIONS: Record<number, string> = {
  0: 'User Metadata / Profile',
  1: 'Short Text Note',
  2: 'Recommend Relay',
  3: 'Follow List / Contacts',
  4: 'Encrypted Direct Message',
  5: 'Event Deletion Request',
  6: 'Repost',
  7: 'Reaction',
  8: 'Badge Award',
  9: 'Group Chat Message',
  10: 'Group Chat Threaded Reply',
  16: 'Generic Repost',
  40: 'Channel Creation',
  41: 'Channel Metadata',
  42: 'Channel Message',
  43: 'Channel Hide Message',
  44: 'Channel Mute User',
  1063: 'File Metadata',
  1311: 'Live Chat Message',
  1984: 'Reporting',
  9734: 'Zap Request',
  9735: 'Zap Receipt',
  10000: 'Mute List',
  10001: 'Pin List',
  10002: 'Relay List Metadata',
  10003: 'Bookmark List',
  10004: 'Communities List',
  10005: 'Public Chats List',
  10006: 'Blocked Relays List',
  10007: 'Search Relays List',
  10015: 'Interests List',
  10030: 'User Emoji List',
  30000: 'Categorized People List',
  30001: 'Categorized Bookmark List',
  30008: 'Profile Badges',
  30009: 'Badge Definition',
  30023: 'Long-form Content',
  30024: 'Draft Long-form Content',
  30311: 'Live Event',
  30315: 'User Status',
  31989: 'App Recommendation',
  31990: 'App Handler',
};

/**
 * Returns human-readable classification or description for a given Nostr event kind.
 */
export function getKindDescription(kind: number): string {
  if (KNOWN_KIND_DESCRIPTIONS[kind]) {
    return KNOWN_KIND_DESCRIPTIONS[kind];
  }
  if (kind >= 10000 && kind < 20000) {
    return 'Replaceable List / State';
  }
  if (kind >= 20000 && kind < 30000) {
    return 'Ephemeral Event';
  }
  if (kind >= 30000 && kind < 40000) {
    return 'Parameterized Replaceable Event';
  }
  return 'Regular Event';
}

/**
 * Collects Cloudflare KV cache status, latency, prefix distribution, and TTL configuration.
 */
export async function collectKvStats(kv?: KVNamespace): Promise<KvStats> {
  const defaultTtl = {
    default: DEFAULT_KV_TTL_SECONDS,
    min: MIN_KV_TTL_SECONDS,
    max: MAX_KV_TTL_SECONDS,
  };

  const prefixes = [...KV_KEY_PREFIXES];

  if (!kv) {
    return {
      status: 'disabled',
      configured: false,
      ttl_seconds: defaultTtl,
      key_prefixes: prefixes,
      latency_ms: null,
      sample_keys_count: 0,
      keys_by_prefix: {
        events: 0,
        profiles: 0,
        relays: 0,
        contacts: 0,
        replaceable: 0,
        parameterized: 0,
        other: 0,
      },
      list_complete: true,
    };
  }

  const start = performance.now();
  try {
    const listRes = await kv.list({ limit: 1000 });
    const latencyMs = Math.round((performance.now() - start) * 100) / 100;

    const breakdown: KvPrefixCounts = {
      events: 0,
      profiles: 0,
      relays: 0,
      contacts: 0,
      replaceable: 0,
      parameterized: 0,
      other: 0,
    };

    const keys = Array.isArray(listRes?.keys) ? listRes.keys : [];
    for (const key of keys) {
      const name = key.name;
      if (name.startsWith('evt:')) {
        breakdown.events++;
      } else if (name.startsWith('profile:')) {
        breakdown.profiles++;
      } else if (name.startsWith('relays:')) {
        breakdown.relays++;
      } else if (name.startsWith('contacts:')) {
        breakdown.contacts++;
      } else if (name.startsWith('replaceable:')) {
        breakdown.replaceable++;
      } else if (name.startsWith('param:')) {
        breakdown.parameterized++;
      } else {
        breakdown.other++;
      }
    }

    return {
      status: 'active',
      configured: true,
      ttl_seconds: defaultTtl,
      key_prefixes: prefixes,
      latency_ms: latencyMs,
      sample_keys_count: keys.length,
      keys_by_prefix: breakdown,
      list_complete: listRes?.list_complete ?? true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: 'error',
      configured: true,
      ttl_seconds: defaultTtl,
      key_prefixes: prefixes,
      latency_ms: null,
      sample_keys_count: 0,
      keys_by_prefix: {
        events: 0,
        profiles: 0,
        relays: 0,
        contacts: 0,
        replaceable: 0,
        parameterized: 0,
        other: 0,
      },
      list_complete: false,
      error: errorMessage,
    };
  }
}

/**
 * Handles `/stats` endpoint reporting cache statistics, database state, KV telemetry, and relay configuration.
 */
export async function handleStatsRequest(env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);

  try {
    if (!env.DB) {
      throw new Error('Database binding (DB) is not configured');
    }

    // 1. Total events
    const eventsResult = await env.DB.prepare('SELECT COUNT(*) AS total FROM events').first<{
      total: number;
    }>();
    const totalEvents = eventsResult?.total ?? 0;

    // 2. Total tags
    let totalTags = 0;
    try {
      const tagsResult = await env.DB.prepare('SELECT COUNT(*) AS total FROM event_tags').first<{
        total: number;
      }>();
      totalTags = tagsResult?.total ?? 0;
    } catch {
      // Non-fatal if tags table query fails
    }

    // 3. Total unique authors
    let totalAuthors = 0;
    try {
      const authorsResult = await env.DB.prepare(
        'SELECT COUNT(DISTINCT pubkey) AS total FROM events'
      ).first<{ total: number }>();
      totalAuthors = authorsResult?.total ?? 0;
    } catch {
      // Non-fatal
    }

    // 4. Time range (oldest and newest created_at timestamps)
    let oldestEventAt: number | null = null;
    let newestEventAt: number | null = null;
    try {
      const rangeResult = await env.DB.prepare(
        'SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM events'
      ).first<{ oldest: number | null; newest: number | null }>();
      if (rangeResult) {
        oldestEventAt = rangeResult.oldest;
        newestEventAt = rangeResult.newest;
      }
    } catch {
      // Non-fatal
    }

    // 5. Kind distribution (top 20) with human-readable annotations
    let kindDistribution: KindDistribution[] = [];
    try {
      const distResult = await env.DB.prepare(
        'SELECT kind, COUNT(*) AS count FROM events GROUP BY kind ORDER BY count DESC LIMIT 20'
      ).all<{ kind: number; count: number }>();
      if (distResult && Array.isArray(distResult.results)) {
        kindDistribution = distResult.results.map((r) => ({
          kind: r.kind,
          name: getKindDescription(r.kind),
          count: r.count,
        }));
      }
    } catch {
      // Non-fatal
    }

    // 6. Collect KV Cache Telemetry
    const kvStats = await collectKvStats(env.CACHE_KV);

    // 7. Parse configured upstreams
    const upstreamRelays = env.UPSTREAM_RELAYS
      ? env.UPSTREAM_RELAYS.split(',').map((u) => u.trim()).filter(Boolean)
      : DEFAULT_UPSTREAM_RELAYS;

    const timeoutMs = parseInt(env.UPSTREAM_TIMEOUT_MS || '5000', 10);

    // 8. Rate Limits & Security Configuration
    const ipHandshakeLimit = env.RATE_LIMIT_IP_HANDSHAKE_PER_MIN
      ? parseInt(env.RATE_LIMIT_IP_HANDSHAKE_PER_MIN, 10)
      : RATE_LIMIT_DEFAULTS.IP_HANDSHAKE_LIMIT;
    const msgPerWindow = env.RATE_LIMIT_MSG_PER_WINDOW
      ? parseInt(env.RATE_LIMIT_MSG_PER_WINDOW, 10)
      : RATE_LIMIT_DEFAULTS.SESSION_MSG_LIMIT;
    const pubkeyWrites = env.RATE_LIMIT_PUBKEY_WRITES_PER_MIN
      ? parseInt(env.RATE_LIMIT_PUBKEY_WRITES_PER_MIN, 10)
      : RATE_LIMIT_DEFAULTS.PUBKEY_WRITE_LIMIT;

    const isReadOnly = env.READ_ONLY === 'true' || env.ALLOW_DIRECT_WRITES === 'false';
    const allowDirectWrites = env.ALLOW_DIRECT_WRITES === 'true';

    const payload: RelayStatsResponse = {
      timestamp: now,
      service: APP_NAME,
      version: APP_VERSION,
      cache: {
        total_events: totalEvents,
        total_tags: totalTags,
        total_authors: totalAuthors,
        time_range: {
          oldest_event_at: oldestEventAt,
          newest_event_at: newestEventAt,
        },
        kind_distribution: kindDistribution,
      },
      kv: kvStats,
      relay: {
        name: env.RELAY_NAME || APP_NAME,
        description: env.RELAY_DESCRIPTION || 'High-Performance Regional Edge-Caching Nostr Relay',
        pubkey: env.RELAY_PUBKEY || '',
        contact: env.RELAY_CONTACT || '',
        read_only: isReadOnly,
        allow_direct_writes: allowDirectWrites,
      },
      security: {
        rate_limits: {
          ip_handshake_per_min: Number.isFinite(ipHandshakeLimit) ? ipHandshakeLimit : 60,
          messages_per_window: Number.isFinite(msgPerWindow) ? msgPerWindow : 100,
          pubkey_writes_per_min: Number.isFinite(pubkeyWrites) ? pubkeyWrites : 30,
        },
      },
      gc: {
        schedule: 'Daily at 03:00 UTC (0 3 * * *)',
        batch_size: DEFAULT_GC_BATCH_SIZE,
        max_batches_per_tier: DEFAULT_MAX_BATCHES_PER_TIER,
        tiers: DEFAULT_GC_TIERS.map((t) => ({
          name: t.name,
          ttl_days: Math.round(t.ttlSeconds / 86400),
          ttl_seconds: t.ttlSeconds,
        })),
      },
      upstreams: {
        configured: upstreamRelays,
        total_configured: upstreamRelays.length,
        timeout_ms: Number.isFinite(timeoutMs) ? timeoutMs : 5000,
      },
    };

    return jsonResponse(payload, 200, {
      'Cache-Control': 'public, max-age=60',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      {
        error: 'Failed to retrieve relay statistics',
        message: errorMessage,
        timestamp: now,
      },
      500
    );
  }
}
