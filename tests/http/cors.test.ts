import { describe, expect, it } from 'vitest';
import {
  CORS_HEADERS,
  createCorsHeaders,
  handleCorsPreflight,
  jsonResponse,
} from '../../src/http/cors';

describe('HTTP CORS Utilities', () => {
  it('should define standard CORS headers conforming to specifications', () => {
    expect(CORS_HEADERS['Access-Control-Allow-Origin']).toBe('*');
    expect(CORS_HEADERS['Access-Control-Allow-Methods']).toContain('GET');
    expect(CORS_HEADERS['Access-Control-Allow-Methods']).toContain('POST');
    expect(CORS_HEADERS['Access-Control-Allow-Methods']).toContain('OPTIONS');
    expect(CORS_HEADERS['Access-Control-Allow-Headers']).toContain('Content-Type');
    expect(CORS_HEADERS['Access-Control-Allow-Headers']).toContain('Accept');
  });

  it('should create Headers instance with default and extra headers', () => {
    const headers = createCorsHeaders({ 'X-Custom-Header': 'nostr' });
    expect(headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(headers.get('X-Custom-Header')).toBe('nostr');
  });

  it('should respond to CORS preflight OPTIONS request with 204 and headers', () => {
    const response = handleCorsPreflight();
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(response.body).toBeNull();
  });

  it('should create JSON response with default 200 status and CORS headers', async () => {
    const data = { hello: 'world' };
    const response = jsonResponse(data);
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');

    const json = await response.json();
    expect(json).toEqual({ hello: 'world' });
  });

  it('should support custom status code and additional headers in jsonResponse', async () => {
    const data = { error: 'Not Found' };
    const response = jsonResponse(data, 404, { 'Cache-Control': 'no-cache' });
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const json = await response.json();
    expect(json).toEqual({ error: 'Not Found' });
  });
});
