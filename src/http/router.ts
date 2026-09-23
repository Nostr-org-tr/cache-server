import type { Env } from '../types/env';
import { handleCorsPreflight, jsonResponse } from './cors';
import { handleHealthRequest } from './health';
import { handleNip11Request } from './nip11';
import { handleStatsRequest } from './stats';
import { handleDashboardRequest } from './dashboard';
import { RATE_LIMIT_DEFAULTS, SlidingWindowLimiter } from '../security';

let ipLimiter: SlidingWindowLimiter | null = null;

export function getIpLimiter(env: Env): SlidingWindowLimiter {
  if (!ipLimiter) {
    const limit = env.RATE_LIMIT_IP_HANDSHAKE_PER_MIN
      ? Number.parseInt(env.RATE_LIMIT_IP_HANDSHAKE_PER_MIN, 10)
      : RATE_LIMIT_DEFAULTS.IP_HANDSHAKE_LIMIT;
    ipLimiter = new SlidingWindowLimiter({
      maxRequests: limit,
      windowMs: RATE_LIMIT_DEFAULTS.IP_HANDSHAKE_WINDOW_MS,
    });
  }
  return ipLimiter;
}

export function resetRouterLimiter(): void {
  ipLimiter = null;
}

/**
 * Main HTTP Router for cache.nostr.org.tr
 */
export async function handleHttpRequest(
  request: Request,
  env: Env,
  _ctx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // 1. Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return handleCorsPreflight();
  }

  // 2. IP Rate Limiting Check
  const clientIp =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    '127.0.0.1';
  const rateLimit = getIpLimiter(env).check(clientIp);
  if (!rateLimit.allowed) {
    return jsonResponse(
      {
        error: 'Too Many Requests',
        message: 'Rate limit exceeded for IP address. Please slow down.',
      },
      429,
      {
        'Retry-After': Math.ceil(rateLimit.retryAfterMs / 1000).toString(),
      }
    );
  }

  // 3. Handle WebSocket Upgrade requests -> delegate to ClientSession Durable Object
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
    const sessionId = env.CLIENT_SESSION.newUniqueId();
    const stub = env.CLIENT_SESSION.get(sessionId);
    return stub.fetch(request);
  }

  // 3. Route GET / HEAD requests
  if (request.method === 'GET' || request.method === 'HEAD') {
    switch (url.pathname) {
      case '/': {
        return handleNip11Request(env);
      }
      case '/health': {
        return handleHealthRequest(env);
      }
      case '/stats': {
        return handleStatsRequest(env);
      }
      case '/dashboard': {
        return handleDashboardRequest(env);
      }
      default: {
        return jsonResponse(
          {
            error: 'Not Found',
            message: `The requested path '${url.pathname}' was not found on this relay.`,
          },
          404
        );
      }
    }
  }

  // 4. Method not allowed for non-GET/HEAD/OPTIONS HTTP requests
  return jsonResponse(
    {
      error: 'Method Not Allowed',
      message: `HTTP method '${request.method}' is not supported on this endpoint.`,
    },
    405,
    {
      Allow: 'GET, HEAD, OPTIONS',
    }
  );
}
