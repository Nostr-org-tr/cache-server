import type { Env } from '../types/env';
import { APP_NAME, APP_VERSION } from '../version';
import { jsonResponse } from './cors';

export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: number;
  service: string;
  version: string;
  db: {
    status: 'connected' | 'disconnected';
    latency_ms?: number;
    event_count?: number;
    error?: string;
  };
}

/**
 * Handles `/health` endpoint by verifying D1 connectivity and latency
 */
export async function handleHealthRequest(env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const start = performance.now();

  try {
    if (!env.DB) {
      throw new Error('Database binding (DB) is not configured');
    }

    // Active probe
    const probe = await env.DB.prepare('SELECT 1 AS alive').first<{ alive: number }>();
    if (!probe || probe.alive !== 1) {
      throw new Error('Database probe query did not return expected value');
    }

    const latencyMs = Math.round((performance.now() - start) * 100) / 100;

    // Retrieve cached event count from KV cache without running heavy table scans on D1
    let eventCount = 0;
    if (env.CACHE_KV) {
      try {
        const cached = await env.CACHE_KV.get('stats:summary', 'json');
        if (cached && typeof cached === 'object' && typeof (cached as { total_events?: number }).total_events === 'number') {
          eventCount = (cached as { total_events: number }).total_events;
        }
      } catch {
        // Non-fatal if KV read fails
      }
    }

    const payload: HealthResponse = {
      status: 'healthy',
      timestamp: now,
      service: APP_NAME,
      version: APP_VERSION,
      db: {
        status: 'connected',
        latency_ms: latencyMs,
        event_count: eventCount,
      },
    };

    return jsonResponse(payload, 200, {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const payload: HealthResponse = {
      status: 'unhealthy',
      timestamp: now,
      service: APP_NAME,
      version: APP_VERSION,
      db: {
        status: 'disconnected',
        error: errorMessage,
      },
    };

    return jsonResponse(payload, 503, {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
  }
}
