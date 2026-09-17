import { describe, expect, it } from 'vitest';
import { buildNip11Document, handleNip11Request } from '../../src/http/nip11';
import type { Env } from '../../src/types/env';
import type { Nip11RelayInformation } from '../../src/types/nostr';
import { APP_VERSION } from '../../src/version';
import { MockD1Database } from '../mocks/mock-d1';

describe('NIP-11 Relay Information Document', () => {
  const baseEnv: Env = {
    DB: new MockD1Database() as unknown as D1Database,
    CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
  };

  it('should generate default NIP-11 document with standard properties', () => {
    const doc = buildNip11Document(baseEnv);

    expect(doc.name).toBe('cache.nostr.org.tr');
    expect(doc.description).toBe(
      'High-Performance Nostr Regional Cache Relay (Read-only cache. Direct writes are not allowed; events are ingested from upstream relays).'
    );
    expect(doc.pubkey).toBe('');
    expect(doc.contact).toBe('admin@nostr.org.tr');
    expect(doc.supported_nips).toEqual([1, 9, 11, 16, 20, 33]);
    expect(doc.software).toBe('https://github.com/delirehberi/cache.nostr.org.tr');
    expect(doc.version).toBe(APP_VERSION);
    expect(doc.limitation).toBeDefined();
    expect(doc.limitation?.max_message_length).toBe(65536);
    expect(doc.limitation?.max_subscriptions).toBe(20);
    expect(doc.limitation?.max_filters).toBe(10);
    expect(doc.limitation?.max_limit).toBe(500);
    expect(doc.limitation?.max_event_tags).toBe(100);
    expect(doc.limitation?.auth_required).toBe(false);
    expect(doc.limitation?.payment_required).toBe(false);
    expect(doc.limitation?.restricted_writes).toBe(true);
  });

  it('should set restricted_writes to false when ALLOW_DIRECT_WRITES is true', () => {
    const openEnv: Env = {
      ...baseEnv,
      ALLOW_DIRECT_WRITES: 'true',
    };
    const doc = buildNip11Document(openEnv);
    expect(doc.limitation?.restricted_writes).toBe(false);
  });

  it('should override fields with custom environment variables', () => {
    const customEnv: Env = {
      ...baseEnv,
      RELAY_NAME: 'Custom Regional Relay',
      RELAY_DESCRIPTION: 'Custom Description',
      RELAY_PUBKEY: 'a'.repeat(64),
      RELAY_CONTACT: 'nostr:npub12345',
    };

    const doc = buildNip11Document(customEnv);
    expect(doc.name).toBe('Custom Regional Relay');
    expect(doc.description).toBe('Custom Description');
    expect(doc.pubkey).toBe('a'.repeat(64));
    expect(doc.contact).toBe('nostr:npub12345');
  });

  it('should handle NIP-11 HTTP request with correct content-type and CORS', async () => {
    const response = handleNip11Request(baseEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/nostr+json; charset=utf-8');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');

    const json = (await response.json()) as Nip11RelayInformation;
    expect(json.name).toBe('cache.nostr.org.tr');
    expect(json.supported_nips).toContain(11);
  });
});
