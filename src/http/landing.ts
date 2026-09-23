import { querySummary } from '../dashboard/queries';
import { renderLandingHtml } from '../landing/renderer';
import type { Env } from '../types/env';
import { DEFAULT_UPSTREAM_RELAYS } from '../upstream/pool-manager';
import {
  APP_CONTACT,
  APP_DESCRIPTION,
  APP_NAME,
} from '../version';
import { createCorsHeaders } from './cors';

/**
 * Handles GET / requests for browsers and HTML consumers.
 * Queries fast summary telemetry from D1 and serves the FlyonUI Light landing page.
 */
export async function handleLandingRequest(
  _request: Request,
  env: Env,
  _ctx?: ExecutionContext
): Promise<Response> {
  const relayName = env.RELAY_NAME || APP_NAME;
  const relayDescription = env.RELAY_DESCRIPTION || APP_DESCRIPTION;
  const relayContact = env.RELAY_CONTACT || APP_CONTACT;
  const relayPubkey = env.RELAY_PUBKEY || '';

  let totalEvents: number | undefined;
  let totalAuthors: number | undefined;
  let totalTags: number | undefined;

  // Attempt fast summary query from D1
  if (env.DB) {
    try {
      const summary = await querySummary(env.DB);
      totalEvents = summary.total_events;
      totalAuthors = summary.total_authors;
      totalTags = summary.total_tags;
    } catch (err) {
      console.warn('[Landing] Failed to query live summary stats from D1:', err);
    }
  }

  const configuredUpstreams = env.UPSTREAM_RELAYS
    ? env.UPSTREAM_RELAYS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_UPSTREAM_RELAYS;

  const kvStatus: 'active' | 'disabled' = env.CACHE_KV ? 'active' : 'disabled';

  const html = renderLandingHtml({
    relayName,
    relayDescription,
    relayContact,
    relayPubkey,
    stats: {
      totalEvents,
      totalAuthors,
      totalTags,
      upstreamCount: configuredUpstreams.length,
      kvStatus,
      gcSchedule: 'Daily at 03:00 UTC',
    },
    upstreams: configuredUpstreams,
    supportedNips: [1, 9, 11, 16, 20, 33, 65],
  });

  const headers = createCorsHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
  });

  return new Response(html, {
    status: 200,
    headers,
  });
}
