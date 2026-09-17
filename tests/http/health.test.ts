import { describe, expect, it } from 'vitest';
import { handleHealthRequest, type HealthResponse } from '../../src/http/health';
import type { Env } from '../../src/types/env';
import { APP_VERSION } from '../../src/version';
import { MockD1Database } from '../mocks/mock-d1';

describe('HTTP /health Check Endpoint', () => {
  it('should return HTTP 200 and healthy status when D1 database is connected', async () => {
    const mockDb = new MockD1Database();
    // Populate an event into mock DB
    mockDb.events.set('event1', {
      id: 'event1',
      pubkey: 'pub1',
      created_at: 1000,
      kind: 1,
      d_tag: null,
      raw_event: '{}',
      created_at_recorded: 1000,
    });

    const env: Env = {
      DB: mockDb as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const response = await handleHealthRequest(env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toContain('no-cache');

    const json = (await response.json()) as HealthResponse;
    expect(json.status).toBe('healthy');
    expect(json.service).toBe('cache.nostr.org.tr');
    expect(json.version).toBe(APP_VERSION);
    expect(json.db.status).toBe('connected');
    expect(typeof json.db.latency_ms).toBe('number');
    expect(json.db.event_count).toBe(1);
    expect(typeof json.timestamp).toBe('number');
  });

  it('should return HTTP 503 and unhealthy status when D1 probe throws an error', async () => {
    const faultyDb = {
      prepare: () => {
        throw new Error('D1 Connection Failed');
      },
    } as unknown as D1Database;

    const env: Env = {
      DB: faultyDb,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const response = await handleHealthRequest(env);

    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const json = (await response.json()) as HealthResponse;
    expect(json.status).toBe('unhealthy');
    expect(json.db.status).toBe('disconnected');
    expect(json.db.error).toContain('D1 Connection Failed');
  });

  it('should return HTTP 503 when D1 binding is undefined', async () => {
    const env: Env = {
      DB: undefined as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const response = await handleHealthRequest(env);
    expect(response.status).toBe(503);

    const json = (await response.json()) as HealthResponse;
    expect(json.status).toBe('unhealthy');
    expect(json.db.status).toBe('disconnected');
  });
});
