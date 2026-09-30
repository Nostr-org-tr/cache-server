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
import { formatClientName } from '../dashboard/queries';

export interface KindDistribution {
  kind: number;
  name: string;
  count: number;
}

export interface ClientDistribution {
  client: string;
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

export interface VectorStats {
  status: 'active' | 'disabled' | 'unconfigured';
  indexed_vectors_count: number;
  total_indexable_events: number;
  embedding_model: string;
  dimensions: number;
  metric: string;
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
    client_distribution: ClientDistribution[];
  };
  kv: KvStats;
  vector_search: VectorStats;
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

export const STATS_KV_KEY = 'stats:json';
export const STATS_KV_TTL_SECONDS = 300; // 5 minutes cache

/**
 * Handles `/stats` endpoint reporting cache statistics, database state, KV telemetry, and relay configuration.
 * Leverages Cloudflare KV caching and D1 query batching to prevent database queue overload.
 */
export async function handleStatsRequest(env: Env, request?: Request): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);

  let forceRefresh = false;
  if (request) {
    try {
      const url = new URL(request.url);
      forceRefresh =
        url.searchParams.get('refresh') === 'true' ||
        url.searchParams.get('force') === '1' ||
        url.searchParams.get('force') === 'true';
    } catch {
      // Non-fatal URL parse fallback
    }
  }

  // 1. Try fast KV cache read if available and not forced
  if (env.CACHE_KV && typeof env.CACHE_KV.get === 'function' && !forceRefresh) {
    try {
      const cached = await env.CACHE_KV.get(STATS_KV_KEY, 'json');
      if (cached && typeof cached === 'object') {
        return jsonResponse(cached, 200, {
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
        });
      }
    } catch (err) {
      console.warn('[Stats] KV cache read failed, falling back to D1:', err);
    }
  }

  try {
    if (!env.DB) {
      throw new Error('Database binding (DB) is not configured');
    }

    // Execute independent analytical queries in a single batched D1 roundtrip
    let totalEvents = 0;
    let totalTags = 0;
    let totalAuthors = 0;
    let oldestEventAt: number | null = null;
    let newestEventAt: number | null = null;
    let kindDistribution: KindDistribution[] = [];
    let clientDistribution: ClientDistribution[] = [];
    let indexedVectorsCount = 0;
    let totalIndexableEvents = 0;

    try {
      const batchRes = await env.DB.batch<
        | { total: number }
        | { oldest: number | null; newest: number | null }
        | { kind: number; count: number }
        | { client: string; count: number }
      >([
        // 0: Total events
        env.DB.prepare('SELECT COUNT(*) AS total FROM events'),
        // 1: Total tags
        env.DB.prepare('SELECT COUNT(*) AS total FROM event_tags'),
        // 2: Total unique authors
        env.DB.prepare('SELECT COUNT(DISTINCT pubkey) AS total FROM events'),
        // 3: Time range (Index-seek subqueries)
        env.DB.prepare(
          `SELECT
             (SELECT created_at FROM events ORDER BY created_at ASC LIMIT 1) AS oldest,
             (SELECT created_at FROM events ORDER BY created_at DESC LIMIT 1) AS newest`
        ),
        // 4: Kind distribution (top 20)
        env.DB.prepare(
          'SELECT kind, COUNT(*) AS count FROM events GROUP BY kind ORDER BY count DESC LIMIT 20'
        ),
        // 5: Client distribution (top 30 tags, aggregated in-memory)
        env.DB.prepare(
          `SELECT tag_value AS client, COUNT(*) AS count
           FROM event_tags
           WHERE tag_name = 'client' AND tag_value != ''
           GROUP BY tag_value
           ORDER BY count DESC
           LIMIT 30`
        ),
        // 6: Indexed vectors count
        env.DB.prepare('SELECT COUNT(*) AS total FROM events WHERE vector_indexed = 1'),
        // 7: Total indexable events
        env.DB.prepare('SELECT COUNT(*) AS total FROM events WHERE kind IN (0, 1, 30023, 9802)'),
      ]);

      const eventsRow = batchRes[0]?.results?.[0] as { total: number } | undefined;
      totalEvents = eventsRow?.total ?? 0;

      const tagsRow = batchRes[1]?.results?.[0] as { total: number } | undefined;
      totalTags = tagsRow?.total ?? 0;

      const authorsRow = batchRes[2]?.results?.[0] as { total: number } | undefined;
      totalAuthors = authorsRow?.total ?? 0;

      const rangeRow = batchRes[3]?.results?.[0] as
        | { oldest: number | null; newest: number | null }
        | undefined;
      if (rangeRow) {
        oldestEventAt = rangeRow.oldest ?? null;
        newestEventAt = rangeRow.newest ?? null;
      }

      const kindRows = (batchRes[4]?.results ?? []) as Array<{ kind: number; count: number }>;
      kindDistribution = kindRows.map((r) => ({
        kind: r.kind,
        name: getKindDescription(r.kind),
        count: r.count,
      }));

      const clientRows = (batchRes[5]?.results ?? []) as Array<{ client: string; count: number }>;
      const clientMap = new Map<string, number>();
      for (const r of clientRows) {
        const formatted = formatClientName(r.client);
        clientMap.set(formatted, (clientMap.get(formatted) || 0) + r.count);
      }
      clientDistribution = Array.from(clientMap.entries())
        .map(([client, count]) => ({ client, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15);

      const vectorRow = batchRes[6]?.results?.[0] as { total: number } | undefined;
      indexedVectorsCount = vectorRow?.total ?? 0;

      const indexableRow = batchRes[7]?.results?.[0] as { total: number } | undefined;
      totalIndexableEvents = indexableRow?.total ?? 0;
    } catch (d1Err) {
      console.warn('[Stats] Batched D1 query failed, checking for fallback:', d1Err);
      // If error is DB down/failure on initial run without any data, propagate
      if (!env.CACHE_KV) {
        throw d1Err;
      }
    }

    // Collect KV Cache Telemetry (if enabled)
    const kvBinding = env.ENABLE_KV_CACHE === 'false' ? undefined : env.CACHE_KV;
    const kvStats = await collectKvStats(kvBinding);

    const vectorEnabled = env.VECTOR_SEARCH_ENABLED !== 'false';
    const vectorStatus: 'active' | 'disabled' | 'unconfigured' =
      !env.VECTOR_INDEX || !env.AI
        ? 'unconfigured'
        : vectorEnabled
          ? 'active'
          : 'disabled';

    const vectorStats: VectorStats = {
      status: vectorStatus,
      indexed_vectors_count: indexedVectorsCount,
      total_indexable_events: totalIndexableEvents,
      embedding_model: env.VECTOR_EMBEDDING_MODEL || '@cf/baai/bge-m3',
      dimensions: 1024,
      metric: 'cosine',
    };

    // Parse configured upstreams
    const upstreamRelays = env.UPSTREAM_RELAYS
      ? env.UPSTREAM_RELAYS.split(',').map((u) => u.trim()).filter(Boolean)
      : DEFAULT_UPSTREAM_RELAYS;

    const timeoutMs = parseInt(env.UPSTREAM_TIMEOUT_MS || '5000', 10);

    // Rate Limits & Security Configuration
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
        client_distribution: clientDistribution,
      },
      kv: kvStats,
      vector_search: vectorStats,
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

    // Store in KV cache for subsequent requests
    if (env.CACHE_KV && typeof env.CACHE_KV.put === 'function') {
      try {
        const putPromise = env.CACHE_KV.put(STATS_KV_KEY, JSON.stringify(payload), {
          expirationTtl: STATS_KV_TTL_SECONDS,
        });
        if (putPromise && typeof putPromise.catch === 'function') {
          putPromise.catch((err) => {
            console.warn('[Stats] Failed to persist stats to KV:', err);
          });
        }
      } catch (err) {
        console.warn('[Stats] Failed to invoke KV put:', err);
      }
    }

    return jsonResponse(payload, 200, {
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
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
