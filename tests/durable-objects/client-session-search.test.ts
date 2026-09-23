import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeEventId } from '../../src/crypto/canonical';
import { ClientSession } from '../../src/durable-objects/client-session';
import type { Env } from '../../src/types/env';
import type { NostrEvent } from '../../src/types/nostr';
import { MockDurableObjectState } from '../mocks/cloudflare-workers';
import { MockD1Database } from '../mocks/mock-d1';
import { createAutoEoseWebSocketFactory } from '../mocks/mock-websocket';

class TestWebSocket {
  public sentMessages: string[] = [];
  public closed = false;

  send(data: string | ArrayBuffer): void {
    const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.sentMessages.push(str);
  }

  close(): void {
    this.closed = true;
  }
}

function createSignedEvent(
  privKey: Uint8Array,
  params: {
    kind: number;
    created_at: number;
    tags?: string[][];
    content: string;
  }
): NostrEvent {
  const pubkeyHex = bytesToHex(schnorr.getPublicKey(privKey));
  const tags = params.tags ?? [];
  const eventIdHex = computeEventId({
    pubkey: pubkeyHex,
    created_at: params.created_at,
    kind: params.kind,
    tags,
    content: params.content,
  });

  const sigHex = bytesToHex(schnorr.sign(eventIdHex, privKey));

  return {
    id: eventIdHex,
    pubkey: pubkeyHex,
    created_at: params.created_at,
    kind: params.kind,
    tags,
    content: params.content,
    sig: sigHex,
  };
}

describe('ClientSession NIP-50 Search Protocol', () => {
  let mockState: MockDurableObjectState;
  let mockDb: MockD1Database;
  let mockEnv: Env;
  let session: ClientSession;
  let privKey: Uint8Array;

  beforeEach(() => {
    mockState = new MockDurableObjectState();
    mockDb = new MockD1Database();
    mockEnv = {
      DB: mockDb as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<ClientSession>,
      RELAY_NAME: 'test.nostr.org.tr',
      UPSTREAM_RELAYS: 'wss://relay.damus.io',
      ALLOW_DIRECT_WRITES: 'true',
    };
    session = new ClientSession(mockState as unknown as DurableObjectState, mockEnv);
    session.setWebSocketFactory(createAutoEoseWebSocketFactory());

    privKey = secp256k1.utils.randomPrivateKey();
  });

  it('handles REQ message with NIP-50 search filter and streams matching events followed by EOSE', async () => {
    const ws = new TestWebSocket();

    // 1. Insert an event with matching keyword into cache
    const event1 = createSignedEvent(privKey, {
      kind: 1,
      created_at: 1700000000,
      content: 'Bitcoin Lightning payments are instant and low-cost.',
    });

    const event2 = createSignedEvent(privKey, {
      kind: 1,
      created_at: 1700000001,
      content: 'Unrelated message about cooking pasta.',
    });

    await session.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify(['EVENT', event1])
    );
    await session.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify(['EVENT', event2])
    );

    ws.sentMessages = [];

    // 2. Client sends REQ with search filter
    await session.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify(['REQ', 'sub_search', { search: 'lightning', kinds: [1] }])
    );

    // Verify messages: EVENT for event1, then EOSE
    const parsedMessages = ws.sentMessages.map((m) => JSON.parse(m) as unknown[]);
    const eventMessages = parsedMessages.filter((m) => m[0] === 'EVENT');
    const eoseMessages = parsedMessages.filter((m) => m[0] === 'EOSE');

    expect(eventMessages.length).toBe(1);
    expect((eventMessages[0]?.[2] as NostrEvent).id).toBe(event1.id);
    expect(eoseMessages.length).toBe(1);
    expect(eoseMessages[0]?.[1]).toBe('sub_search');
  });

  it('sends only EOSE when no events match the search query', async () => {
    const ws = new TestWebSocket();

    await session.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify(['REQ', 'sub_none', { search: 'nonexistentkeyword12345' }])
    );

    const parsedMessages = ws.sentMessages.map((m) => JSON.parse(m) as unknown[]);
    const eventMessages = parsedMessages.filter((m) => m[0] === 'EVENT');
    const eoseMessages = parsedMessages.filter((m) => m[0] === 'EOSE');

    expect(eventMessages.length).toBe(0);
    expect(eoseMessages.length).toBe(1);
    expect(eoseMessages[0]?.[1]).toBe('sub_none');
  });
});
