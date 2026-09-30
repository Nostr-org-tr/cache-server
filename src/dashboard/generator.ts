/**
 * Dashboard Generator
 *
 * Orchestrates all D1 queries in parallel, assembles DashboardData,
 * renders the HTML, and persists it to Cloudflare KV for hourly serving.
 */

import type { Env } from '../types/env';
import { APP_VERSION } from '../version';
import { DEFAULT_UPSTREAM_RELAYS } from '../upstream/pool-manager';
import {
  queryAgeBuckets,
  queryDailyVolume,
  queryHot5,
  queryHourlyTimeline,
  queryHourOfDay,
  queryKindDistribution,
  queryMostFollowed,
  querySummary,
  queryTopClients,
  queryTopPosters,
  queryTopSharers,
  queryTopTags,
} from './queries';
import { renderDashboardHtml } from './renderer';
import type { DashboardData } from './types';

// KV cache keys
export const DASHBOARD_KV_KEY = 'dashboard:html';
export const SUMMARY_KV_KEY = 'stats:summary';
export const STATS_KV_KEY = 'stats:json';

// 2-hour expiration window — ensures stale pages are never served beyond 2 GC cycles
export const DASHBOARD_KV_TTL_SECONDS = 7200;

/**
 * Runs all dashboard queries in sequential steps to prevent D1 queue congestion,
 * assembles the payload, renders the HTML, and persists it to KV.
 *
 * Individual query failures are caught internally by each query function,
 * returning empty/zero data. This function itself never throws.
 */
export async function generateDashboard(env: Env): Promise<string | null> {
  if (!env.DB) {
    console.error('[Dashboard] DB binding is not configured — cannot generate dashboard');
    return null;
  }

  const startMs = Date.now();
  const nowSeconds = Math.floor(startMs / 1000);

  console.log('[Dashboard] Starting sequential generation…');

  try {
    // Phase 1: Core summary
    const summary = await querySummary(env.DB);

    // Phase 2: Activity Timelines & Volumes
    const hourlyTimeline = await queryHourlyTimeline(env.DB, nowSeconds);
    const dailyVolume = await queryDailyVolume(env.DB, nowSeconds);
    const hourOfDay = await queryHourOfDay(env.DB);

    // Phase 3: Distributions & Buckets
    const kindDist = await queryKindDistribution(env.DB);
    const ageBuckets = await queryAgeBuckets(env.DB, nowSeconds);

    // Phase 4: Tags & Clients
    const topTags = await queryTopTags(env.DB);
    const topClients = await queryTopClients(env.DB);

    // Phase 5: Account Leaderboards
    const topPosters = await queryTopPosters(env.DB, nowSeconds);
    const topSharers = await queryTopSharers(env.DB, nowSeconds);
    const mostFollowed = await queryMostFollowed(env.DB);

    // Phase 6: Hot 5 Trending (uses hourlyTimeline for sparklines)
    const hot5 = await queryHot5(env.DB, nowSeconds, hourlyTimeline);

    // Parse relay configuration from env
    const upstreamRelays = env.UPSTREAM_RELAYS
      ? env.UPSTREAM_RELAYS.split(',').map((u) => u.trim()).filter(Boolean)
      : [...DEFAULT_UPSTREAM_RELAYS];

    const gcSchedule = 'Daily at 03:00 UTC (0 3 * * *)';

    const data: DashboardData = {
      generatedAt: nowSeconds,
      summary,
      hourlyTimeline,
      hourOfDay,
      dailyVolume,
      kindDist,
      ageBuckets,
      topTags,
      topClients,
      topPosters,
      topSharers,
      mostFollowed,
      hot5,
      relay: {
        name: env.RELAY_NAME ?? 'Nostr Cache',
        version: APP_VERSION,
        pubkey: env.RELAY_PUBKEY ?? '',
        contact: env.RELAY_CONTACT ?? '',
        upstream_relays: upstreamRelays,
        gc_schedule: gcSchedule,
      },
    };

    const html = renderDashboardHtml(data);
    const htmlBytes = new TextEncoder().encode(html).byteLength;

    if (env.CACHE_KV) {
      await Promise.allSettled([
        env.CACHE_KV.put(DASHBOARD_KV_KEY, html, {
          expirationTtl: DASHBOARD_KV_TTL_SECONDS,
        }),
        env.CACHE_KV.put(SUMMARY_KV_KEY, JSON.stringify(summary), {
          expirationTtl: DASHBOARD_KV_TTL_SECONDS,
        }),
      ]);
    }

    const durationMs = Date.now() - startMs;
    console.log(
      `[Dashboard] Generation complete in ${durationMs}ms. ` +
        `HTML: ${(htmlBytes / 1024).toFixed(1)} KB. ` +
        `Events: ${summary.total_events}, Authors: ${summary.total_authors}, ` +
        `Hot5: ${hot5.length}`
    );

    return html;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Dashboard] Generation failed: ${msg}`);
    return null;
  }
}
