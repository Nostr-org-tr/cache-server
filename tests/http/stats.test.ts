import { describe, expect, it } from 'vitest';
import {
  collectKvStats,
  getKindDescription,
  handleStatsRequest,
  type RelayStatsResponse,
} from '../../src/http/stats';
import type { Env } from '../../src/types/env';
import { APP_VERSION } from '../../src/version';
import { MockD1Database } from '../mocks/mock-d1';
import { MockKVNamespace } from '../mocks/mock-kv';

describe('HTTP /stats Endpoint', () => {
  it('should return cache, KV telemetry, and upstream statistics', async () => {
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
    mockDb.eventTags.push({ event_id: 'e1', tag_name: 'client', tag_value: 'Damus' });

    const mockKv = new MockKVNamespace();
    await mockKv.put('evt:e1', JSON.stringify({ id: 'e1' }));
    await mockKv.put('profile:p2', JSON.stringify({ id: 'e3' }));
    await mockKv.put('relays:p1', JSON.stringify(['wss://relay.damus.io']));
    await mockKv.put('contacts:p1', JSON.stringify({ id: 'contacts' }));
    await mockKv.put('replaceable:p1:10000', JSON.stringify({ id: 'r1' }));
    await mockKv.put('param:p1:30000:d1', JSON.stringify({ id: 'pr1' }));
    await mockKv.put('misc:key', 'misc_val');

    const env: Env = {
      DB: mockDb as unknown as D1Database,
      CACHE_KV: mockKv as unknown as KVNamespace,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
      RELAY_NAME: 'Nostr Turkey Regional Cache',
      RELAY_DESCRIPTION: 'Regional Cache Relay',
      RELAY_PUBKEY: '46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a',
      RELAY_CONTACT: 'admin@nostr.org.tr',
      UPSTREAM_RELAYS: 'wss://relay.damus.io, wss://nos.lol',
      UPSTREAM_TIMEOUT_MS: '4000',
      RATE_LIMIT_IP_HANDSHAKE_PER_MIN: '120',
      RATE_LIMIT_MSG_PER_WINDOW: '300',
      RATE_LIMIT_PUBKEY_WRITES_PER_MIN: '60',
      ALLOW_DIRECT_WRITES: 'false',
    };

    const response = await handleStatsRequest(env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const json = (await response.json()) as RelayStatsResponse;
    expect(json.service).toBe('cache.nostr.org.tr');
    expect(json.version).toBe(APP_VERSION);
    expect(json.cache.total_events).toBe(3);
    expect(json.cache.total_tags).toBe(2);
    expect(json.cache.total_authors).toBe(2);
    expect(json.cache.time_range).toEqual({
      oldest_event_at: 1000,
      newest_event_at: 1002,
    });
    expect(json.cache.kind_distribution).toEqual([
      { kind: 1, name: 'Short Text Note', count: 2 },
      { kind: 0, name: 'User Metadata / Profile', count: 1 },
    ]);
    expect(json.cache.client_distribution).toEqual([
      { client: 'Damus', count: 1 },
    ]);

    // KV Telemetry checks
    expect(json.kv).toBeDefined();
    expect(json.kv.status).toBe('active');
    expect(json.kv.configured).toBe(true);
    expect(json.kv.ttl_seconds).toEqual({
      default: 7200,
      min: 60,
      max: 7200,
    });
    expect(json.kv.sample_keys_count).toBe(7);
    expect(json.kv.keys_by_prefix).toEqual({
      events: 1,
      profiles: 1,
      relays: 1,
      contacts: 1,
      replaceable: 1,
      parameterized: 1,
      other: 1,
    });
    expect(json.kv.list_complete).toBe(true);
    expect(typeof json.kv.latency_ms).toBe('number');

    // Relay checks
    expect(json.relay.name).toBe('Nostr Turkey Regional Cache');
    expect(json.relay.pubkey).toBe('46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a');
    expect(json.relay.read_only).toBe(true);
    expect(json.relay.allow_direct_writes).toBe(false);

    // Security & Rate Limits checks
    expect(json.security.rate_limits).toEqual({
      ip_handshake_per_min: 120,
      messages_per_window: 300,
      pubkey_writes_per_min: 60,
    });

    // GC checks
    expect(json.gc).toBeDefined();
    expect(json.gc.schedule).toBe('Daily at 03:00 UTC (0 3 * * *)');
    expect(json.gc.batch_size).toBe(500);
    expect(json.gc.max_batches_per_tier).toBe(10);
    expect(json.gc.tiers.length).toBeGreaterThan(0);
    expect(json.gc.tiers[0]).toHaveProperty('ttl_seconds');

    // Upstreams checks
    expect(json.upstreams.configured).toEqual(['wss://relay.damus.io', 'wss://nos.lol']);
    expect(json.upstreams.total_configured).toBe(2);
    expect(json.upstreams.timeout_ms).toBe(4000);
  });

  it('should handle unconfigured KV namespace gracefully', async () => {
    const mockDb = new MockD1Database();
    const env: Env = {
      DB: mockDb as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const response = await handleStatsRequest(env);
    expect(response.status).toBe(200);

    const json = (await response.json()) as RelayStatsResponse;
    expect(json.kv.status).toBe('disabled');
    expect(json.kv.configured).toBe(false);
    expect(json.kv.latency_ms).toBeNull();
    expect(json.kv.sample_keys_count).toBe(0);
    expect(json.upstreams.configured).toEqual([
      'wss://relay.primal.net',
      'wss://relay.damus.io',
      'wss://relay.ditto.pub',
      'wss://relay.emre.xyz',
      'wss://relay.nostr.org.tr',
    ]);
    expect(json.upstreams.total_configured).toBe(5);
    expect(json.upstreams.timeout_ms).toBe(5000);
  });

  it('should handle KV errors gracefully without breaking /stats', async () => {
    const mockDb = new MockD1Database();
    const faultyKv = {
      list: () => {
        throw new Error('KV storage degraded');
      },
    } as unknown as KVNamespace;

    const env: Env = {
      DB: mockDb as unknown as D1Database,
      CACHE_KV: faultyKv,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const response = await handleStatsRequest(env);
    expect(response.status).toBe(200);

    const json = (await response.json()) as RelayStatsResponse;
    expect(json.kv.status).toBe('error');
    expect(json.kv.configured).toBe(true);
    expect(json.kv.error).toBe('KV storage degraded');
    expect(json.kv.latency_ms).toBeNull();
  });

  it('should return correct kind descriptions for standard and parameterized kinds', () => {
    expect(getKindDescription(0)).toBe('User Metadata / Profile');
    expect(getKindDescription(1)).toBe('Short Text Note');
    expect(getKindDescription(3)).toBe('Follow List / Contacts');
    expect(getKindDescription(7)).toBe('Reaction');
    expect(getKindDescription(9735)).toBe('Zap Receipt');
    expect(getKindDescription(10002)).toBe('Relay List Metadata');
    expect(getKindDescription(15000)).toBe('Replaceable List / State');
    expect(getKindDescription(25000)).toBe('Ephemeral Event');
    expect(getKindDescription(30023)).toBe('Long-form Content');
    expect(getKindDescription(35000)).toBe('Parameterized Replaceable Event');
    expect(getKindDescription(99999)).toBe('Regular Event');
  });

  it('should collect KV stats directly from namespace', async () => {
    const mockKv = new MockKVNamespace();
    await mockKv.put('evt:123', JSON.stringify({ id: '123' }));
    await mockKv.put('profile:abc', JSON.stringify({ id: 'profile' }));

    const stats = await collectKvStats(mockKv as unknown as KVNamespace);
    expect(stats.status).toBe('active');
    expect(stats.configured).toBe(true);
    expect(stats.sample_keys_count).toBe(2);
    expect(stats.keys_by_prefix.events).toBe(1);
    expect(stats.keys_by_prefix.profiles).toBe(1);
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
