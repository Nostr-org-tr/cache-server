import { describe, expect, it } from 'vitest';
import { handleSearchApiRequest } from '../../src/http/search';
import type { Env } from '../../src/types/env';
import type { NostrEvent } from '../../src/types/nostr';

class MockD1Database {
  private rows: Array<{
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    d_tag: string;
    raw_event: string;
    created_at_recorded: number;
  }> = [];

  insertEvent(event: NostrEvent, dTag = '') {
    this.rows.push({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      d_tag: dTag,
      raw_event: JSON.stringify(event),
      created_at_recorded: event.created_at,
    });
  }

  prepare(_query: string) {
    const rows = this.rows;
    return {
      bind(...params: unknown[]) {
        return {
          async all() {
            // Simple mock filter matching for tests
            const searchTerms = params
              .filter((p): p is string => typeof p === 'string' && p.startsWith('%') && p.endsWith('%'))
              .map((p) => p.slice(1, -1).toLowerCase());

            let filtered = rows;
            if (searchTerms.length > 0) {
              filtered = filtered.filter((r) =>
                searchTerms.some((term) => r.raw_event.toLowerCase().includes(term))
              );
            }

            return { results: filtered, success: true, meta: {} };
          },
          async first() {
            return null;
          },
          async run() {
            return { success: true };
          },
        };
      },
    };
  }
}

describe('HTTP Search API Endpoint (GET /api/search)', () => {
  const dummyPubkey = '46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a';
  const dummyId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('returns empty results array when query is empty', async () => {
    const mockDb = new MockD1Database();
    const env = { DB: mockDb as unknown as D1Database } as Env;

    const request = new Request('https://cache.nostr.org.tr/api/search?q=');
    const response = await handleSearchApiRequest(request, env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');

    const json = await response.json() as { query: string; count: number; results: unknown[] };
    expect(json.query).toBe('');
    expect(json.count).toBe(0);
    expect(json.results).toEqual([]);
  });

  it('returns formatted results and njump links for matching query', async () => {
    const mockDb = new MockD1Database();
    const sampleEvent: NostrEvent = {
      id: dummyId,
      pubkey: dummyPubkey,
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: 'Nostr protocol and Bitcoin Lightning integration.',
      sig: 'f'.repeat(128),
    };
    mockDb.insertEvent(sampleEvent);

    const env = { DB: mockDb as unknown as D1Database } as Env;

    const request = new Request('https://cache.nostr.org.tr/api/search?q=lightning&kinds=1,0,30023');
    const response = await handleSearchApiRequest(request, env);

    expect(response.status).toBe(200);
    const json = await response.json() as { query: string; count: number; results: Array<{ event: NostrEvent; njumpUrl: string; score: number }> };
    expect(json.query).toBe('lightning');
    expect(json.count).toBe(1);
    expect(json.results[0]?.event.id).toBe(dummyId);
    expect(json.results[0]?.njumpUrl).toMatch(/^https:\/\/njump\.me\/note1/);
    expect(json.results[0]?.score).toBeGreaterThan(0);
  });
});
