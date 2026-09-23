/**
 * Dashboard Generator
 *
 * Orchestrates all D1 queries in parallel, assembles DashboardData,
 * renders the HTML, and persists it to Cloudflare KV for hourly serving.
 */

import type { Env } from '../types/env';
import { APP_VERSION } from '../version';
import { DEFAULT_GC_TIERS } from '../db/gc';
import { DEFAULT_UPSTREAM_RELAYS } from '../upstream/pool-manager';
import {
  queryAgeBuckets,
  queryDailyVolume,
  queryHot5,
  queryHourlyTimeline,
  queryHourOfDay,
  queryKindDistribution,
  queryMostFollowed,
  queryMostFollowing,
  querySummary,
  queryTopPosters,
  queryTopSharers,
  queryTopTags,
} from './queries';
import { renderDashboardHtml } from './renderer';
import type { DashboardData } from './types';

// KV key for the generated dashboard HTML
const DASHBOARD_KV_KEY = 'dashboard:html';

// 2-hour expiration window — ensures stale pages are never served beyond 2 GC cycles
const DASHBOARD_KV_TTL_SECONDS = 7200;

/**
 * Runs all dashboard queries concurrently, assembles the payload,
 * renders the HTML, and persists it to KV.
 *
 * Individual query failures are caught internally by each query function,
 * returning empty/zero data. This function itself never throws.
 */
export async function generateDashboard(env: Env): Promise<void> {
  if (!env.CACHE_KV) {
    console.warn('[Dashboard] CACHE_KV binding is not configured — skipping dashboard generation');
    return;
  }

  if (!env.DB) {
    console.error('[Dashboard] DB binding is not configured — cannot generate dashboard');
    return;
  }

  const startMs = Date.now();
  const nowSeconds = Math.floor(startMs / 1000);

  console.log('[Dashboard] Starting generation…');

  try {
    // Run all independent queries concurrently
    const [
      summary,
      hourlyTimeline,
      hourOfDay,
      dailyVolume,
      kindDist,
      ageBuckets,
      topTags,
      topPosters,
      topSharers,
      mostFollowed,
      mostFollowing,
    ] = await Promise.all([
      querySummary(env.DB),
      queryHourlyTimeline(env.DB, nowSeconds),
      queryHourOfDay(env.DB),
      queryDailyVolume(env.DB, nowSeconds),
      queryKindDistribution(env.DB),
      queryAgeBuckets(env.DB, nowSeconds),
      queryTopTags(env.DB),
      queryTopPosters(env.DB, nowSeconds),
      queryTopSharers(env.DB, nowSeconds),
      queryMostFollowed(env.DB),
      queryMostFollowing(env.DB),
    ]);

    // Hot 5 uses the hourlyTimeline result to build sparklines — runs after
    const hot5 = await queryHot5(env.DB, nowSeconds, hourlyTimeline);

    // Parse relay configuration from env
    const upstreamRelays = env.UPSTREAM_RELAYS
      ? env.UPSTREAM_RELAYS.split(',').map((u) => u.trim()).filter(Boolean)
      : [...DEFAULT_UPSTREAM_RELAYS];

    const gcSchedule = 'Daily at 03:00 UTC (0 3 * * *)';

    // Derive GC schedule description from DEFAULT_GC_TIERS
    const gcSummary = DEFAULT_GC_TIERS.map(
      (t) => `${t.name}: ${Math.round(t.ttlSeconds / 86400)}d`
    ).join(' · ');

    const data: DashboardData = {
      generatedAt: nowSeconds,
      summary,
      hourlyTimeline,
      hourOfDay,
      dailyVolume,
      kindDist,
      ageBuckets,
      topTags,
      topPosters,
      topSharers,
      mostFollowed,
      mostFollowing,
      hot5,
      relay: {
        name: env.RELAY_NAME ?? 'Nostr Cache',
        version: APP_VERSION,
        pubkey: env.RELAY_PUBKEY ?? '',
        contact: env.RELAY_CONTACT ?? '',
        upstream_relays: upstreamRelays,
        gc_schedule: `${gcSchedule} | ${gcSummary}`,
      },
    };

    const html = renderDashboardHtml(data);
    const htmlBytes = new TextEncoder().encode(html).byteLength;

    await env.CACHE_KV.put(DASHBOARD_KV_KEY, html, {
      expirationTtl: DASHBOARD_KV_TTL_SECONDS,
    });

    const durationMs = Date.now() - startMs;
    console.log(
      `[Dashboard] Generation complete in ${durationMs}ms. ` +
        `HTML: ${(htmlBytes / 1024).toFixed(1)} KB. ` +
        `Events: ${summary.total_events}, Authors: ${summary.total_authors}, ` +
        `Hot5: ${hot5.length}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Dashboard] Generation failed: ${msg}`);
    // Do not re-throw — the cron handler uses waitUntil and a crash here
    // would not surface to users; we just log and let the next hourly run retry.
  }
}
