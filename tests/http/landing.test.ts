import { describe, expect, it } from 'vitest';
import { handleLandingRequest } from '../../src/http/landing';
import { renderLandingHtml } from '../../src/landing/renderer';
import type { Env } from '../../src/types/env';
import { MockD1Database } from '../mocks/mock-d1';

describe('Landing Page Renderer & Handler', () => {
  it('should render complete HTML with FlyonUI classes and community metadata', () => {
    const html = renderLandingHtml({
      relayName: 'cache.nostr.org.tr',
      relayDescription: 'Regional Nostr Cache',
      relayContact: 'admin@nostr.org.tr',
      stats: {
        totalEvents: 125000,
        totalAuthors: 4200,
        totalTags: 540000,
        upstreamCount: 5,
        kvStatus: 'active',
      },
      upstreams: ['wss://relay.damus.io', 'wss://nos.lol'],
      supportedNips: [1, 9, 11, 16, 20, 33, 65],
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('data-theme="light"');
    expect(html).toContain('cache.nostr.org.tr');
    expect(html).toContain('Nostr Cache');
    expect(html).toContain('Stats JSON');
    expect(html).toContain('nostr.org.tr');
    expect(html).toContain('https://github.com/Nostr-org-tr/cache-server');
    expect(html).toContain('https://github.com/Nostr-org-tr/cache-server/blob/master/CONTRIBUTING.md');
    expect(html).not.toContain('ROADMAP.md');
    expect(html).toContain('wss://cache.nostr.org.tr');
    expect(html).toContain('wss://cache.nostr.org.tr?relays=wss://relay.damus.io,wss://nos.lol');
    expect(html).toContain('125.0K+');
    expect(html).toContain('4.2K+');
    expect(html).toContain('540.0K+');
    expect(html).toContain('nak req');
    expect(html).toContain('nostr-tools');
    expect(html).toContain('nostr_sdk');
    expect(html).toContain('nostr.hs');
    expect(html).toContain('https://hackage.haskell.org/package/nostr');
    expect(html).toContain('tab-haskell');
    expect(html).toContain('NIP-01');
    expect(html).toContain('NIP-33');
    expect(html).toContain('NIP-65');
  });

  it('should support custom relayHost option when provided', () => {
    const html = renderLandingHtml({
      relayHost: 'custom-cache.example.com',
    });
    expect(html).toContain('wss://custom-cache.example.com');
    expect(html).toContain('wss://custom-cache.example.com?relays=');
  });

  it('should handle missing or empty stats gracefully with fallback formatting', () => {
    const html = renderLandingHtml();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Nostr Cache');
    expect(html).toContain('wss://cache.nostr.org.tr');
    expect(html).toContain('—'); // Fallback symbol for undefined stats
  });

  it('should serve landing page HTTP response with 200 OK and text/html', async () => {
    const mockDb = new MockD1Database();
    const mockNamespace = {
      newUniqueId: () => 'mock-id',
      get: () => ({ fetch: async () => new Response('ok') }),
    };

    const env: Env = {
      DB: mockDb as unknown as D1Database,
      CLIENT_SESSION: mockNamespace as unknown as DurableObjectNamespace<any>,
      RELAY_NAME: 'cache.nostr.org.tr',
    };

    const request = new Request('https://cache.nostr.org.tr/', {
      headers: { Accept: 'text/html' },
    });

    const response = await handleLandingRequest(request, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toContain('public');

    const body = await response.text();
    expect(body).toContain('cache.nostr.org.tr');
    expect(body).toContain('nostr.org.tr');
  });

  it('should read summary telemetry from KV cache and never query D1', async () => {
    let d1Queried = false;
    const trackingDb = {
      prepare: () => {
        d1Queried = true;
        throw new Error('D1 must never be called during landing request');
      },
    } as unknown as D1Database;

    const mockKvStore = new Map<string, string>();
    mockKvStore.set(
      'stats:summary',
      JSON.stringify({
        total_events: 50000,
        total_authors: 1200,
        total_tags: 150000,
        indexed_vectors: 3000,
      })
    );
    const mockKvNamespace = {
      get: async (key: string) => {
        const val = mockKvStore.get(key);
        return val ? JSON.parse(val) : null;
      },
    } as unknown as KVNamespace;

    const env: Env = {
      DB: trackingDb,
      CACHE_KV: mockKvNamespace,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const request = new Request('https://cache.nostr.org.tr/');
    const response = await handleLandingRequest(request, env);
    expect(response.status).toBe(200);
    expect(d1Queried).toBe(false);

    const body = await response.text();
    expect(body).toContain('50.0K+');
    expect(body).toContain('1.2K+');
    expect(body).toContain('150.0K+');
  });
});
