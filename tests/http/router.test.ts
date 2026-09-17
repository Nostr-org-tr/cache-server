import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHttpRequest, resetRouterLimiter } from '../../src/http/router';
import type { Env } from '../../src/types/env';
import { MockD1Database } from '../mocks/mock-d1';

describe('HTTP Router', () => {
  beforeEach(() => {
    resetRouterLimiter();
  });

  const mockDb = new MockD1Database();

  const mockDoFetch = vi.fn().mockResolvedValue(new Response('WebSocket Upgraded', { status: 200 }));
  const mockStub = { fetch: mockDoFetch };
  const mockNamespace = {
    newUniqueId: vi.fn().mockReturnValue('mock-unique-id'),
    get: vi.fn().mockReturnValue(mockStub),
  };

  const env: Env = {
    DB: mockDb as unknown as D1Database,
    CLIENT_SESSION: mockNamespace as unknown as DurableObjectNamespace<any>,
  };

  it('should handle OPTIONS preflight request with 204', async () => {
    const request = new Request('https://cache.nostr.org.tr/', {
      method: 'OPTIONS',
    });

    const response = await handleHttpRequest(request, env);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('should delegate WebSocket upgrade request to Durable Object', async () => {
    const request = new Request('https://cache.nostr.org.tr/', {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });

    const response = await handleHttpRequest(request, env);
    expect(mockNamespace.newUniqueId).toHaveBeenCalled();
    expect(mockNamespace.get).toHaveBeenCalledWith('mock-unique-id');
    expect(mockDoFetch).toHaveBeenCalledWith(request);
    expect(response.status).toBe(200);
  });

  it('should route GET / to NIP-11 handler', async () => {
    const request = new Request('https://cache.nostr.org.tr/', {
      method: 'GET',
      headers: {
        Accept: 'application/nostr+json',
      },
    });

    const response = await handleHttpRequest(request, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/nostr+json');

    const json = (await response.json()) as { name: string };
    expect(json.name).toBe('cache.nostr.org.tr');
  });

  it('should route GET /health to health handler', async () => {
    const request = new Request('https://cache.nostr.org.tr/health', {
      method: 'GET',
    });

    const response = await handleHttpRequest(request, env);
    expect(response.status).toBe(200);

    const json = (await response.json()) as { status: string };
    expect(json.status).toBe('healthy');
  });

  it('should route GET /stats to stats handler', async () => {
    const request = new Request('https://cache.nostr.org.tr/stats', {
      method: 'GET',
    });

    const response = await handleHttpRequest(request, env);
    expect(response.status).toBe(200);

    const json = (await response.json()) as { cache: unknown };
    expect(json.cache).toBeDefined();
  });

  it('should return 404 for unknown routes', async () => {
    const request = new Request('https://cache.nostr.org.tr/nonexistent', {
      method: 'GET',
    });

    const response = await handleHttpRequest(request, env);
    expect(response.status).toBe(404);

    const json = (await response.json()) as { error: string };
    expect(json.error).toBe('Not Found');
  });

  it('should return 405 for unsupported HTTP methods', async () => {
    const request = new Request('https://cache.nostr.org.tr/health', {
      method: 'POST',
      body: JSON.stringify({ data: 'test' }),
    });

    const response = await handleHttpRequest(request, env);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toContain('GET');

    const json = (await response.json()) as { error: string };
    expect(json.error).toBe('Method Not Allowed');
  });

  it('should return 429 Too Many Requests when IP rate limit is exceeded', async () => {
    const strictEnv: Env = {
      ...env,
      RATE_LIMIT_IP_HANDSHAKE_PER_MIN: '3',
    };

    const makeRequest = () =>
      new Request('https://cache.nostr.org.tr/health', {
        headers: {
          'cf-connecting-ip': '203.0.113.195',
        },
      });

    // 3 allowed requests
    const res1 = await handleHttpRequest(makeRequest(), strictEnv);
    expect(res1.status).toBe(200);

    const res2 = await handleHttpRequest(makeRequest(), strictEnv);
    expect(res2.status).toBe(200);

    const res3 = await handleHttpRequest(makeRequest(), strictEnv);
    expect(res3.status).toBe(200);

    // 4th request exceeds rate limit
    const res4 = await handleHttpRequest(makeRequest(), strictEnv);
    expect(res4.status).toBe(429);
    expect(res4.headers.get('Retry-After')).toBeDefined();

    const json = (await res4.json()) as { error: string };
    expect(json.error).toBe('Too Many Requests');
  });
});

