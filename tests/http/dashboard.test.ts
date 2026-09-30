import { describe, expect, it } from 'vitest';
import { handleDashboardRequest } from '../../src/http/dashboard';
import type { Env } from '../../src/types/env';
import { MockKVNamespace } from '../mocks/mock-kv';

describe('HTTP /dashboard Endpoint', () => {
  it('should serve cached dashboard HTML from KV without querying D1', async () => {
    let d1Queried = false;
    const trackingDb = {
      prepare: () => {
        d1Queried = true;
        throw new Error('D1 must never be called during dashboard request');
      },
    } as unknown as D1Database;

    const mockKv = new MockKVNamespace();
    await mockKv.put('dashboard:html', '<html><body>Cached Dashboard</body></html>');

    const env: Env = {
      DB: trackingDb,
      CACHE_KV: mockKv as unknown as KVNamespace,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const request = new Request('https://cache.nostr.org.tr/dashboard');
    const response = await handleDashboardRequest(request, env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Cache-Control')).toContain('public');
    expect(d1Queried).toBe(false);

    const body = await response.text();
    expect(body).toBe('<html><body>Cached Dashboard</body></html>');
  });

  it('should serve placeholder HTML on cold start without querying D1', async () => {
    let d1Queried = false;
    const trackingDb = {
      prepare: () => {
        d1Queried = true;
        throw new Error('D1 must never be called on cold start dashboard request');
      },
    } as unknown as D1Database;

    const mockKv = new MockKVNamespace();
    const env: Env = {
      DB: trackingDb,
      CACHE_KV: mockKv as unknown as KVNamespace,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const request = new Request('https://cache.nostr.org.tr/dashboard');
    const response = await handleDashboardRequest(request, env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(d1Queried).toBe(false);

    const body = await response.text();
    expect(body).toContain('Dashboard is being generated…');
    expect(body).toContain('The first hourly report is not ready yet.');
  });
});
