import { DEFAULT_GC_TIERS } from '../db/gc';
import type { Env } from '../types/env';
import { DEFAULT_UPSTREAM_RELAYS } from '../upstream/pool-manager';
import { APP_NAME, APP_VERSION } from '../version';
import { jsonResponse } from './cors';

export interface KindDistribution {
  kind: number;
  count: number;
}

export interface RelayStatsResponse {
  timestamp: number;
  service: string;
  version: string;
  cache: {
    total_events: number;
    total_tags: number;
    kind_distribution: KindDistribution[];
  };
  gc: {
    schedule: string;
    tiers: Array<{ name: string; ttl_days: number }>;
  };
  upstreams: {
    configured: string[];
    timeout_ms: number;
  };
}

/**
 * Handles `/stats` endpoint reporting cache statistics and database state
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

    // 3. Kind distribution (top 20)
    let kindDistribution: KindDistribution[] = [];
    try {
      const distResult = await env.DB.prepare(
        'SELECT kind, COUNT(*) AS count FROM events GROUP BY kind ORDER BY count DESC LIMIT 20'
      ).all<KindDistribution>();
      if (distResult && Array.isArray(distResult.results)) {
        kindDistribution = distResult.results;
      }
    } catch {
      // Non-fatal
    }

    // Parse configured upstreams
    const upstreamRelays = env.UPSTREAM_RELAYS
      ? env.UPSTREAM_RELAYS.split(',').map((u) => u.trim()).filter(Boolean)
      : DEFAULT_UPSTREAM_RELAYS;

    const timeoutMs = parseInt(env.UPSTREAM_TIMEOUT_MS || '5000', 10);

    const payload: RelayStatsResponse = {
      timestamp: now,
      service: APP_NAME,
      version: APP_VERSION,
      cache: {
        total_events: totalEvents,
        total_tags: totalTags,
        kind_distribution: kindDistribution,
      },
      gc: {
        schedule: 'Daily at 03:00 UTC (0 3 * * *)',
        tiers: DEFAULT_GC_TIERS.map((t) => ({
          name: t.name,
          ttl_days: Math.round(t.ttlSeconds / 86400),
        })),
      },
      upstreams: {
        configured: upstreamRelays,
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
