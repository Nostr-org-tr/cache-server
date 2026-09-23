import { executeSearch } from '../search';
import type { SearchApiResponse } from '../search/types';
import type { Env } from '../types/env';
import { jsonResponse } from './cors';

/**
 * Handles GET /api/search HTTP API requests for Landing Page Search UI and developer integrations.
 */
export async function handleSearchApiRequest(request: Request, env: Env): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(request.url);

  const query = (url.searchParams.get('q') || url.searchParams.get('search') || '').trim();
  if (query.length === 0) {
    return jsonResponse(
      {
        query: '',
        count: 0,
        tookMs: 0,
        results: [],
      } satisfies SearchApiResponse,
      200,
      {
        'Cache-Control': 'public, max-age=60',
      }
    );
  }

  // Parse kinds parameter (default to notes, profiles, and articles: 1, 0, 30023)
  const kindsParam = url.searchParams.get('kinds');
  let kinds: number[] | undefined;
  if (kindsParam) {
    kinds = kindsParam
      .split(',')
      .map((k) => parseInt(k.trim(), 10))
      .filter((k) => !isNaN(k));
    if (kinds.length === 0) {
      kinds = undefined;
    }
  }

  // Parse limit parameter (default 20, max 50)
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Math.max(1, Math.min(parseInt(limitParam, 10) || 20, 50)) : 20;

  try {
    const filter: { search: string; limit: number; kinds?: number[] } = {
      search: query,
      limit,
    };
    if (kinds && kinds.length > 0) {
      filter.kinds = kinds;
    }

    const results = await executeSearch(env.DB, env, filter, limit);

    const tookMs = Date.now() - startTime;

    const payload: SearchApiResponse = {
      query,
      count: results.length,
      tookMs,
      results,
    };

    return jsonResponse(payload, 200, {
      'Cache-Control': 'public, max-age=60',
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Search execution failed';
    return jsonResponse(
      {
        error: 'Search Error',
        message: errorMsg,
      },
      500
    );
  }
}
