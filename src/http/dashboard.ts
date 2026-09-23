/**
 * HTTP /dashboard Handler
 *
 * Reads the pre-generated static HTML from Cloudflare KV and serves it.
 * Returns a 503 placeholder page on cold start (KV miss).
 */

import type { Env } from '../types/env';
import { renderPlaceholderHtml } from '../dashboard/renderer';
import { createCorsHeaders } from './cors';

const DASHBOARD_KV_KEY = 'dashboard:html';

/**
 * Handles GET /dashboard — serves the pre-rendered static HTML dashboard.
 */
export async function handleDashboardRequest(env: Env): Promise<Response> {
  if (!env.CACHE_KV) {
    return new Response(renderPlaceholderHtml(), {
      status: 503,
      headers: createCorsHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
    });
  }

  try {
    const html = await env.CACHE_KV.get(DASHBOARD_KV_KEY, { type: 'text' });

    if (html === null) {
      // Dashboard not yet generated — return styled placeholder with auto-refresh
      return new Response(renderPlaceholderHtml(), {
        status: 503,
        headers: createCorsHeaders({
          'Content-Type': 'text/html; charset=utf-8',
          'Retry-After': '60',
          'Cache-Control': 'no-store',
        }),
      });
    }

    return new Response(html, {
      status: 200,
      headers: createCorsHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        // Allow browsers to cache for up to 1 hour (matches generation cadence)
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=600',
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'KV read error';
    console.error(`[Dashboard] KV read failed: ${msg}`);
    return new Response(renderPlaceholderHtml(), {
      status: 503,
      headers: createCorsHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      }),
    });
  }
}
