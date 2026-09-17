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

    // Retrieve cached event count
    let eventCount = 0;
    try {
      const countResult = await env.DB.prepare('SELECT COUNT(*) AS total FROM events').first<{
        total: number;
      }>();
      if (countResult && typeof countResult.total === 'number') {
        eventCount = countResult.total;
      }
    } catch {
      // Non-fatal if count query fails while probe passed
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
