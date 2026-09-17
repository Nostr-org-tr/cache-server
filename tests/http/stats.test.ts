import { describe, expect, it } from 'vitest';
import { handleStatsRequest, type RelayStatsResponse } from '../../src/http/stats';
import type { Env } from '../../src/types/env';
import { APP_VERSION } from '../../src/version';
import { MockD1Database } from '../mocks/mock-d1';

describe('HTTP /stats Endpoint', () => {
  it('should return cache and upstream statistics', async () => {
    const mockDb = new MockD1Database();
    mockDb.events.set('e1', {
      id: 'e1',
      pubkey: 'p1',
      created_at: 1000,
      kind: 1,
      d_tag: null,
      raw_event: '{}',
      created_at_recorded: 1000,
    });
    mockDb.events.set('e2', {
      id: 'e2',
      pubkey: 'p1',
      created_at: 1001,
      kind: 1,
      d_tag: null,
      raw_event: '{}',
      created_at_recorded: 1001,
    });
    mockDb.events.set('e3', {
      id: 'e3',
      pubkey: 'p2',
      created_at: 1002,
      kind: 0,
      d_tag: null,
      raw_event: '{}',
      created_at_recorded: 1002,
    });
    mockDb.eventTags.push({ event_id: 'e1', tag_name: 'p', tag_value: 'p2' });

    const env: Env = {
      DB: mockDb as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
      UPSTREAM_RELAYS: 'wss://relay.damus.io, wss://nos.lol',
      UPSTREAM_TIMEOUT_MS: '4000',
    };

    const response = await handleStatsRequest(env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const json = (await response.json()) as RelayStatsResponse;
    expect(json.service).toBe('cache.nostr.org.tr');
    expect(json.version).toBe(APP_VERSION);
    expect(json.cache.total_events).toBe(3);
    expect(json.cache.total_tags).toBe(1);
    expect(json.cache.kind_distribution).toEqual([
      { kind: 1, count: 2 },
      { kind: 0, count: 1 },
    ]);
    expect(json.upstreams.configured).toEqual(['wss://relay.damus.io', 'wss://nos.lol']);
    expect(json.upstreams.timeout_ms).toBe(4000);
  });

  it('should use default upstreams if not explicitly configured in env', async () => {
    const mockDb = new MockD1Database();
    const env: Env = {
      DB: mockDb as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const response = await handleStatsRequest(env);
    expect(response.status).toBe(200);

    const json = (await response.json()) as RelayStatsResponse;
    expect(json.upstreams.configured).toEqual([
      'wss://relay.primal.net',
      'wss://relay.damus.io',
      'wss://relay.ditto.pub',
      'wss://relay.emre.xyz',
      'wss://relay.nostr.org.tr',
    ]);
    expect(json.upstreams.timeout_ms).toBe(5000);
  });

  it('should return HTTP 500 if database fails', async () => {
    const faultyDb = {
      prepare: () => {
        throw new Error('Database down');
      },
    } as unknown as D1Database;

    const env: Env = {
      DB: faultyDb,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const response = await handleStatsRequest(env);
    expect(response.status).toBe(500);

    const json = (await response.json()) as { error: string; message: string };
    expect(json.error).toBe('Failed to retrieve relay statistics');
  });
});
