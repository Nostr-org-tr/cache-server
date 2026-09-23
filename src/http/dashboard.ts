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
  request: Request,
  env: Env,
  _ctx?: ExecutionContext
): Promise<Response> {
  let html: string | null = null;
  const url = new URL(request.url);
  const forceRefresh =
    url.searchParams.get('refresh') === 'true' ||
    url.searchParams.get('force') === '1' ||
    url.searchParams.get('force') === 'true';

  // 1. Try fast KV cache read (unless force refresh requested)
  if (env.CACHE_KV && !forceRefresh) {
    try {
      html = await env.CACHE_KV.get(DASHBOARD_KV_KEY, { type: 'text' });
    } catch (err) {
      console.warn('[Dashboard] KV read failed, falling back to on-demand generation:', err);
    }
  }

  // 2. If not cached yet (or force refresh requested), generate on the fly
  if (!html || forceRefresh) {
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
