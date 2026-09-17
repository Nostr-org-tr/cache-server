/**
 * Standard CORS and HTTP Header Configuration
 */

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Authorization, Upgrade, Sec-WebSocket-Key, Sec-WebSocket-Version',
  'Access-Control-Max-Age': '86400',
};

/**
 * Creates Headers object including CORS headers and any custom overrides
 */
export function createCorsHeaders(extra?: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      headers.set(key, value);
    }
  }
  return headers;
}

/**
 * Handles HTTP OPTIONS CORS preflight requests
 */
export function handleCorsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: createCorsHeaders(),
  });
}

/**
 * Helper to construct JSON HTTP Responses with CORS headers
 */
export function jsonResponse(
  data: unknown,
  status: number = 200,
  extraHeaders?: Record<string, string>
): Response {
  const headers = createCorsHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });

  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers,
  });
}
