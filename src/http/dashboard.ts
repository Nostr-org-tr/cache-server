import type { Env } from '../types/env';
import { generateDashboard } from '../dashboard/generator';
import { renderPlaceholderHtml } from '../dashboard/renderer';
import { createCorsHeaders } from './cors';

const DASHBOARD_KV_KEY = 'dashboard:html';

/**
 * Handles GET /dashboard — serves the static HTML dashboard.
 * If not yet cached in KV (e.g. cold start, first deploy, or local dev),
 * generates on demand so users see data immediately without waiting for the hourly cron.
 */
export async function handleDashboardRequest(
  env: Env,
  _ctx?: ExecutionContext
): Promise<Response> {
  let html: string | null = null;

  // 1. Try fast KV cache read
  if (env.CACHE_KV) {
    try {
      html = await env.CACHE_KV.get(DASHBOARD_KV_KEY, { type: 'text' });
    } catch (err) {
      console.warn('[Dashboard] KV read failed, falling back to on-demand generation:', err);
    }
  }

  // 2. If not cached yet (or KV unavailable), generate on the fly
  if (!html) {
    html = await generateDashboard(env);
  }

  // 3. Return dashboard HTML if available
  if (html) {
    return new Response(html, {
      status: 200,
      headers: createCorsHeaders({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=600',
      }),
    });
  }

  // 4. Fallback if DB is unavailable or generation failed
  return new Response(renderPlaceholderHtml(), {
    status: 503,
    headers: createCorsHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': '60',
      'Cache-Control': 'no-store',
    }),
  });
}
