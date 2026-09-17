import { beforeEach, describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { ClientSession } from '../../src/durable-objects/client-session';
import { computeEventId } from '../../src/crypto/canonical';
import type { Env } from '../../src/types/env';
import type { NostrEvent } from '../../src/types/nostr';
import { MockD1Database } from '../mocks/mock-d1';
import { MockDurableObjectState } from '../mocks/cloudflare-workers';
import { createAutoEoseWebSocketFactory, MockClientWebSocket } from '../mocks/mock-websocket';

// Mock WebSocket implementation for unit tests
class TestWebSocket {
  public sentMessages: string[] = [];
  public closed = false;
  public closeCode?: number | undefined;
  public closeReason?: string | undefined;

  send(data: string | ArrayBuffer): void {
    if (this.closed) {
      throw new Error('WebSocket is already closed');
    }
    const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.sentMessages.push(str);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
}

// Helper to create a cryptographically valid Nostr event
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

describe('ClientSession Durable Object', () => {
  let mockState: MockDurableObjectState;
  let mockDb: MockD1Database;
  let mockEnv: Env;
  let session: ClientSession;
  let privKeyA: Uint8Array;
  let pubkeyA: string;
  let privKeyB: Uint8Array;

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

    privKeyA = secp256k1.utils.randomPrivateKey();
    pubkeyA = bytesToHex(schnorr.getPublicKey(privKeyA));

    privKeyB = secp256k1.utils.randomPrivateKey();
  });


  describe('fetch() - WebSocket Upgrade Handling', () => {
    it('rejects HTTP requests missing Upgrade: websocket header', async () => {
      const request = new Request('https://cache.nostr.org.tr/', {
        method: 'GET',
      });
      const response = await session.fetch(request);
      expect(response.status).toBe(426);
      expect(await response.text()).toBe('Expected WebSocket Upgrade');
    });

    it('accepts valid WebSocket upgrade and registers socket with hibernation tag', async () => {
      // Mock global WebSocketPair if in Node environment
      class MockWebSocketPair {
        0 = new TestWebSocket();
        1 = new TestWebSocket();
      }
      (globalThis as unknown as { WebSocketPair: typeof MockWebSocketPair }).WebSocketPair = MockWebSocketPair;

      const request = new Request('https://cache.nostr.org.tr/', {
        method: 'GET',
        headers: { Upgrade: 'websocket' },
      });

      const response = await session.fetch(request);
      expect(response.status).toBe(101);
      expect(response.webSocket).toBeDefined();

      const sockets = mockState.getWebSockets('client');
      expect(sockets).toHaveLength(1);
    });
  });

  describe('webSocketMessage() - REQ and D1 Querying', () => {
    it('returns NOTICE on malformed JSON payload', async () => {
      const ws = new TestWebSocket() as unknown as WebSocket;
      await session.webSocketMessage(ws, 'NOT_VALID_JSON{');

      const testWs = ws as unknown as TestWebSocket;
      expect(testWs.sentMessages).toHaveLength(1);
      const parsed = JSON.parse(testWs.sentMessages[0]!);
      expect(parsed[0]).toBe('NOTICE');
      expect(parsed[1]).toContain('error:');
    });

    it('enforces maximum filters per subscription limitation (10 max)', async () => {
      const ws = new TestWebSocket() as unknown as WebSocket;
      const elevenFilters = Array.from({ length: 11 }, () => ({ kinds: [1] }));
      const reqMsg = JSON.stringify(['REQ', 'sub_large', ...elevenFilters]);

      await session.webSocketMessage(ws, reqMsg);

      const testWs = ws as unknown as TestWebSocket;
      expect(testWs.sentMessages).toHaveLength(1);
      const parsed = JSON.parse(testWs.sentMessages[0]!);
      expect(parsed[0]).toBe('CLOSED');
      expect(parsed[1]).toBe('sub_large');
      expect(parsed[2]).toContain('maximum 10 filters');
    });

    it('enforces maximum concurrent active subscriptions per session (20 max)', async () => {
      const ws = new TestWebSocket() as unknown as WebSocket;

      // Register 20 subscriptions
      for (let i = 0; i < 20; i++) {
        await session.webSocketMessage(ws, JSON.stringify(['REQ', `sub_${i}`, { kinds: [1] }]));
      }

      const testWs = ws as unknown as TestWebSocket;
      testWs.sentMessages = [];

      // Attempt 21st subscription
      await session.webSocketMessage(ws, JSON.stringify(['REQ', 'sub_21', { kinds: [1] }]));
      expect(testWs.sentMessages).toHaveLength(1);
      const parsed = JSON.parse(testWs.sentMessages[0]!);
      expect(parsed[0]).toBe('CLOSED');
      expect(parsed[1]).toBe('sub_21');
      expect(parsed[2]).toContain('rate-limited');
    });

    it('queries D1 cache, streams matching events, and terminates with EOSE', async () => {
      const event1 = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1000,
        content: 'Note 1',
      });
      const event2 = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 2000,
        content: 'Note 2',
      });

      // Populate D1
      mockDb.events.set(event1.id, {
        id: event1.id,
        pubkey: event1.pubkey,
        created_at: event1.created_at,
        kind: event1.kind,
        d_tag: null,
        raw_event: JSON.stringify(event1),
        created_at_recorded: 1000,
      });
      mockDb.events.set(event2.id, {
        id: event2.id,
        pubkey: event2.pubkey,
        created_at: event2.created_at,
        kind: event2.kind,
        d_tag: null,
        raw_event: JSON.stringify(event2),
        created_at_recorded: 2000,
      });

      const ws = new TestWebSocket() as unknown as WebSocket;
      await session.webSocketMessage(ws, JSON.stringify(['REQ', 'sub_notes', { kinds: [1] }]));

      const testWs = ws as unknown as TestWebSocket;
      expect(testWs.sentMessages).toHaveLength(3);

      const msg1 = JSON.parse(testWs.sentMessages[0]!);
      const msg2 = JSON.parse(testWs.sentMessages[1]!);
      const msg3 = JSON.parse(testWs.sentMessages[2]!);

      expect(msg1[0]).toBe('EVENT');
      expect(msg1[1]).toBe('sub_notes');
      expect(msg1[2].id).toBe(event2.id); // sorted created_at DESC

      expect(msg2[0]).toBe('EVENT');
      expect(msg2[1]).toBe('sub_notes');
      expect(msg2[2].id).toBe(event1.id);

      expect(msg3[0]).toBe('EOSE');
      expect(msg3[1]).toBe('sub_notes');
    });

    it('handles binary ArrayBuffer message correctly', async () => {
      const ws = new TestWebSocket() as unknown as WebSocket;
      const rawText = JSON.stringify(['REQ', 'binary_sub', { kinds: [1] }]);
      const encoded = new TextEncoder().encode(rawText);
      const buffer = encoded.buffer as ArrayBuffer;

      await session.webSocketMessage(ws, buffer);


      const testWs = ws as unknown as TestWebSocket;
      expect(testWs.sentMessages).toHaveLength(1);
      const parsed = JSON.parse(testWs.sentMessages[0]!);
      expect(parsed[0]).toBe('EOSE');
      expect(parsed[1]).toBe('binary_sub');
    });
  });

  describe('webSocketMessage() - EVENT Ingestion & Broadcast', () => {
    it('rejects events with invalid cryptographic signatures', async () => {
      const validEvent = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1000,
        content: 'Valid',
      });

      // Tamper signature
      const tamperedEvent: NostrEvent = {
        ...validEvent,
        sig: '0'.repeat(128),
      };

      const ws = new TestWebSocket() as unknown as WebSocket;
      await session.webSocketMessage(ws, JSON.stringify(['EVENT', tamperedEvent]));

      const testWs = ws as unknown as TestWebSocket;
      expect(testWs.sentMessages).toHaveLength(1);
      const okMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(okMsg[0]).toBe('OK');
      expect(okMsg[1]).toBe(tamperedEvent.id);
      expect(okMsg[2]).toBe(false);
      expect(okMsg[3]).toContain('invalid:');
    });

    it('saves valid persistent event to D1, broadcasts to matching active subscriptions, and replies OK', async () => {
      const ws = new TestWebSocket() as unknown as WebSocket;

      // Register an active subscription for kind 1 events by pubkeyA
      await session.webSocketMessage(
        ws,
        JSON.stringify(['REQ', 'sub_author', { authors: [pubkeyA], kinds: [1] }])
      );

      const testWs = ws as unknown as TestWebSocket;
      testWs.sentMessages = []; // clear initial EOSE message

      const event = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1000,
        content: 'Hello World',
      });

      await session.webSocketMessage(ws, JSON.stringify(['EVENT', event]));

      expect(testWs.sentMessages).toHaveLength(2);

      const eventMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(eventMsg[0]).toBe('EVENT');
      expect(eventMsg[1]).toBe('sub_author');
      expect(eventMsg[2].id).toBe(event.id);

      const okMsg = JSON.parse(testWs.sentMessages[1]!);
      expect(okMsg[0]).toBe('OK');
      expect(okMsg[1]).toBe(event.id);
      expect(okMsg[2]).toBe(true);

      // Verify event was persisted to D1
      expect(mockDb.events.has(event.id)).toBe(true);
    });

    it('broadcasts ephemeral events (kinds 20000..29999) to matching subscriptions WITHOUT saving to D1', async () => {
      const ws = new TestWebSocket() as unknown as WebSocket;

      // Register subscription for typing indicators (kind 20001)
      await session.webSocketMessage(
        ws,
        JSON.stringify(['REQ', 'sub_typing', { kinds: [20001] }])
      );

      const testWs = ws as unknown as TestWebSocket;
      testWs.sentMessages = [];

      const ephemeralEvent = createSignedEvent(privKeyA, {
        kind: 20001,
        created_at: 1500,
        content: 'typing...',
      });

      await session.webSocketMessage(ws, JSON.stringify(['EVENT', ephemeralEvent]));

      expect(testWs.sentMessages).toHaveLength(2);

      const streamedMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(streamedMsg[0]).toBe('EVENT');
      expect(streamedMsg[1]).toBe('sub_typing');
      expect(streamedMsg[2].id).toBe(ephemeralEvent.id);

      const okMsg = JSON.parse(testWs.sentMessages[1]!);
      expect(okMsg[0]).toBe('OK');
      expect(okMsg[1]).toBe(ephemeralEvent.id);
      expect(okMsg[2]).toBe(true);

      // Ephemeral events MUST NEVER be in D1
      expect(mockDb.events.size).toBe(0);
    });

    it('does not broadcast to non-matching active subscriptions', async () => {
      const ws = new TestWebSocket() as unknown as WebSocket;

      // Subscription for kind 0 only
      await session.webSocketMessage(
        ws,
        JSON.stringify(['REQ', 'sub_metadata', { kinds: [0] }])
      );

      const testWs = ws as unknown as TestWebSocket;
      testWs.sentMessages = [];

      // Inbound kind 1 event
      const kind1Event = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1000,
        content: 'Kind 1 Note',
      });

      await session.webSocketMessage(ws, JSON.stringify(['EVENT', kind1Event]));

      // Only the OK response should be sent, not the EVENT message
      expect(testWs.sentMessages).toHaveLength(1);
      const okMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(okMsg[0]).toBe('OK');
      expect(okMsg[1]).toBe(kind1Event.id);
      expect(okMsg[2]).toBe(true);
    });

    it('processes deletion event (kind 5) and removes target event from D1', async () => {
      const authorEvent = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1000,
        content: 'Delete this note',
      });

      const ws = new TestWebSocket() as unknown as WebSocket;

      // Save initial note
      await session.webSocketMessage(ws, JSON.stringify(['EVENT', authorEvent]));
      expect(mockDb.events.has(authorEvent.id)).toBe(true);

      // Issue kind 5 deletion
      const deletionEvent = createSignedEvent(privKeyA, {
        kind: 5,
        created_at: 1500,
        tags: [['e', authorEvent.id]],
        content: 'deleting note',
      });

      await session.webSocketMessage(ws, JSON.stringify(['EVENT', deletionEvent]));

      // Target note must be deleted
      expect(mockDb.events.has(authorEvent.id)).toBe(false);
      // Deletion event itself recorded
      expect(mockDb.events.has(deletionEvent.id)).toBe(true);
    });
  });

  describe('webSocketMessage() - Deduplication Engine', () => {
    it('prevents resending duplicate events on matching multiple criteria in live broadcast', async () => {
      const ws = new TestWebSocket() as unknown as WebSocket;

      // Register subscription that has two filters which both match the same event
      await session.webSocketMessage(
        ws,
        JSON.stringify([
          'REQ',
          'sub_multi',
          { kinds: [1], authors: [pubkeyA] },
          { kinds: [1] },
        ])
      );

      const testWs = ws as unknown as TestWebSocket;
      testWs.sentMessages = [];

      const event = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1000,
        content: 'Unique event',
      });

      await session.webSocketMessage(ws, JSON.stringify(['EVENT', event]));

      // Should only receive 1 EVENT message + 1 OK message
      const eventMessages = testWs.sentMessages
        .map((m) => JSON.parse(m))
        .filter((m) => m[0] === 'EVENT');

      expect(eventMessages).toHaveLength(1);
      expect(eventMessages[0][2].id).toBe(event.id);
    });
  });

  describe('webSocketMessage() - CLOSE & COUNT', () => {
    it('handles CLOSE by unregistering subscription and responding with CLOSED', async () => {
      const ws = new TestWebSocket() as unknown as WebSocket;

      await session.webSocketMessage(ws, JSON.stringify(['REQ', 'sub_close_test', { kinds: [1] }]));

      const testWs = ws as unknown as TestWebSocket;
      testWs.sentMessages = [];

      await session.webSocketMessage(ws, JSON.stringify(['CLOSE', 'sub_close_test']));

      expect(testWs.sentMessages).toHaveLength(1);
      const closedMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(closedMsg[0]).toBe('CLOSED');
      expect(closedMsg[1]).toBe('sub_close_test');
      expect(closedMsg[2]).toBe('subscription closed');

      // Subsequent event should not be streamed to closed subscription
      testWs.sentMessages = [];
      const event = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1000,
        content: 'After close',
      });
      await session.webSocketMessage(ws, JSON.stringify(['EVENT', event]));

      const streamedEvents = testWs.sentMessages
        .map((m) => JSON.parse(m))
        .filter((m) => m[0] === 'EVENT');
      expect(streamedEvents).toHaveLength(0);
    });

    it('handles COUNT (NIP-45) and returns count response', async () => {
      const event1 = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1000,
        content: 'Note 1',
      });
      const event2 = createSignedEvent(privKeyB, {
        kind: 1,
        created_at: 2000,
        content: 'Note 2',
      });

      mockDb.events.set(event1.id, {
        id: event1.id,
        pubkey: event1.pubkey,
        created_at: event1.created_at,
        kind: event1.kind,
        d_tag: null,
        raw_event: JSON.stringify(event1),
        created_at_recorded: 1000,
      });
      mockDb.events.set(event2.id, {
        id: event2.id,
        pubkey: event2.pubkey,
        created_at: event2.created_at,
        kind: event2.kind,
        d_tag: null,
        raw_event: JSON.stringify(event2),
        created_at_recorded: 2000,
      });

      const ws = new TestWebSocket() as unknown as WebSocket;
      await session.webSocketMessage(ws, JSON.stringify(['COUNT', 'count_sub', { kinds: [1] }]));

      const testWs = ws as unknown as TestWebSocket;
      expect(testWs.sentMessages).toHaveLength(1);
      const countMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(countMsg[0]).toBe('COUNT');
      expect(countMsg[1]).toBe('count_sub');
      expect(countMsg[2]).toEqual({ count: 2 });
    });
  });

  describe('webSocketClose() and webSocketError() Lifecycle Hooks', () => {
    it('clears all active subscriptions on webSocketClose', async () => {
      const ws = new TestWebSocket() as unknown as WebSocket;
      await session.webSocketMessage(ws, JSON.stringify(['REQ', 'sub_active', { kinds: [1] }]));

      await session.webSocketClose(ws, 1000, 'Normal Closure', true);

      // Ingest new event - should not stream to cleared subscription
      const testWs = ws as unknown as TestWebSocket;
      testWs.sentMessages = [];

      const event = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1000,
        content: 'Post-close test',
      });
      await session.webSocketMessage(ws, JSON.stringify(['EVENT', event]));

      const streamedEvents = testWs.sentMessages
        .map((m) => JSON.parse(m))
        .filter((m) => m[0] === 'EVENT');
      expect(streamedEvents).toHaveLength(0);
    });

    it('handles webSocketError gracefully and sends error notice', async () => {
      const ws = new TestWebSocket() as unknown as WebSocket;
      await session.webSocketError(ws, new Error('Socket network drop'));

      const testWs = ws as unknown as TestWebSocket;
      expect(testWs.sentMessages).toHaveLength(1);
      const noticeMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(noticeMsg[0]).toBe('NOTICE');
      expect(noticeMsg[1]).toContain('Socket network drop');
    });
  });

  describe('Pull-Through Caching & Upstream Pool Integration', () => {
    it('pulls missing events from upstream relays, streams them to client, and persists them into D1', async () => {
      session.setWebSocketFactory((url) => {
        const mockWs = new MockClientWebSocket(url);
        const origSend = mockWs.send.bind(mockWs);
        mockWs.send = (data) => {
          origSend(data);
          const raw = typeof data === 'string' ? data : new TextDecoder().decode(data);
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed[0] === 'REQ') {
              const reqSubId = parsed[1] as string;
              queueMicrotask(() => {
                if (reqSubId === 'sub_pull') {
                  const upstreamEvent = createSignedEvent(privKeyA, {
                    kind: 1,
                    created_at: 5000,
                    content: 'Fresh note from upstream',
                  });
                  mockWs.simulateServerMessage(
                    JSON.stringify(['EVENT', reqSubId, upstreamEvent])
                  );
                }
                mockWs.simulateServerMessage(
                  JSON.stringify(['EOSE', reqSubId])
                );
              });
            }
          } catch {
            // Ignore parse errors
          }
        };
        return mockWs as unknown as WebSocket;
      });

      const ws = new TestWebSocket() as unknown as WebSocket;
      await session.webSocketMessage(
        ws,
        JSON.stringify(['REQ', 'sub_pull', { kinds: [1], authors: [pubkeyA] }])
      );

      const testWs = ws as unknown as TestWebSocket;
      expect(testWs.sentMessages.length).toBeGreaterThanOrEqual(2);

      const eventMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(eventMsg[0]).toBe('EVENT');
      expect(eventMsg[1]).toBe('sub_pull');
      expect(eventMsg[2].content).toBe('Fresh note from upstream');

      const eoseMsg = JSON.parse(testWs.sentMessages[testWs.sentMessages.length - 1]!);
      expect(eoseMsg[0]).toBe('EOSE');
      expect(eoseMsg[1]).toBe('sub_pull');

      // Verify event was saved to D1
      expect(mockDb.events.has(eventMsg[2].id)).toBe(true);

      // Subsequent query directly hits D1 without needing upstream response
      testWs.sentMessages = [];
      await session.webSocketMessage(
        ws,
        JSON.stringify(['REQ', 'sub_cached', { kinds: [1], authors: [pubkeyA] }])
      );

      const cachedEventMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(cachedEventMsg[0]).toBe('EVENT');
      expect(cachedEventMsg[2].id).toBe(eventMsg[2].id);
    });

    it('respects connection-level custom relays provided in ?relays= query param', async () => {
      const queriedUrls: string[] = [];
      session.setWebSocketFactory((url) => {
        queriedUrls.push(url);
        const mockWs = new MockClientWebSocket(url);
        mockWs.addEventListener('open', () => {
          setTimeout(() => {
            mockWs.simulateServerMessage(JSON.stringify(['EOSE', 'sub_custom']));
          }, 15);
        });
        return mockWs as unknown as WebSocket;
      });

      // Connect with custom ?relays parameter
      const request = new Request(
        'https://cache.nostr.org.tr/?relays=wss://custom.relay.one,wss://custom.relay.two',
        {
          method: 'GET',
          headers: { Upgrade: 'websocket' },
        }
      );
      await session.fetch(request);

      const ws = new TestWebSocket() as unknown as WebSocket;
      await session.webSocketMessage(
        ws,
        JSON.stringify(['REQ', 'sub_custom', { kinds: [1] }])
      );

      expect(queriedUrls).toContain('wss://custom.relay.one');
      expect(queriedUrls).toContain('wss://custom.relay.two');
    });
  });

  describe('Rate Limiting & Hardening in ClientSession', () => {
    it('enforces per-session message throughput rate limit', async () => {
      // Create session with low limit for testing (e.g. 5 messages)
      const strictEnv = {
        ...mockEnv,
        RATE_LIMIT_MSG_PER_WINDOW: '5',
      };
      const strictSession = new ClientSession(
        mockState as unknown as DurableObjectState,
        strictEnv
      );

      const testWs = new TestWebSocket();
      const ws = testWs as unknown as WebSocket;

      // Send 5 permitted messages
      for (let i = 0; i < 5; i++) {
        await strictSession.webSocketMessage(
          ws,
          JSON.stringify(['CLOSE', `sub_${i}`])
        );
      }

      // 6th message should be blocked by rate limiter
      testWs.sentMessages = [];
      await strictSession.webSocketMessage(
        ws,
        JSON.stringify(['CLOSE', 'sub_blocked'])
      );

      expect(testWs.sentMessages.length).toBe(1);
      const noticeMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(noticeMsg[0]).toBe('NOTICE');
      expect(noticeMsg[1]).toContain('rate-limited: message throughput exceeded');
    });

    it('enforces pubkey write rate limit on incoming EVENT messages', async () => {
      // Create session with pubkey write limit of 2
      const strictEnv = {
        ...mockEnv,
        RATE_LIMIT_PUBKEY_WRITES_PER_MIN: '2',
      };
      const strictSession = new ClientSession(
        mockState as unknown as DurableObjectState,
        strictEnv
      );

      const testWs = new TestWebSocket();
      const ws = testWs as unknown as WebSocket;

      const event1 = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1700000001,
        content: 'first write',
      });
      const event2 = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1700000002,
        content: 'second write',
      });
      const event3 = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1700000003,
        content: 'third write - should be throttled',
      });

      await strictSession.webSocketMessage(ws, JSON.stringify(['EVENT', event1]));
      const ok1 = JSON.parse(testWs.sentMessages[0]!);
      expect(ok1[0]).toBe('OK');
      expect(ok1[1]).toBe(event1.id);
      expect(ok1[2]).toBe(true);

      testWs.sentMessages = [];
      await strictSession.webSocketMessage(ws, JSON.stringify(['EVENT', event2]));
      const ok2 = JSON.parse(testWs.sentMessages[0]!);
      expect(ok2[0]).toBe('OK');
      expect(ok2[1]).toBe(event2.id);
      expect(ok2[2]).toBe(true);

      // 3rd write should be rate-limited
      testWs.sentMessages = [];
      await strictSession.webSocketMessage(ws, JSON.stringify(['EVENT', event3]));
      const ok3 = JSON.parse(testWs.sentMessages[0]!);
      expect(ok3[0]).toBe('OK');
      expect(ok3[1]).toBe(event3.id);
      expect(ok3[2]).toBe(false);
      expect(ok3[3]).toContain('rate-limited: pubkey write frequency exceeded');
    });
  });

  describe('Read-Only Caching Mode & Write Blocking', () => {
    it('blocks direct client EVENT when ALLOW_DIRECT_WRITES is false', async () => {
      const readOnlyEnv: Env = {
        ...mockEnv,
        ALLOW_DIRECT_WRITES: 'false',
      };
      const readOnlySession = new ClientSession(
        mockState as unknown as DurableObjectState,
        readOnlyEnv
      );

      const testWs = new TestWebSocket();
      const ws = testWs as unknown as WebSocket;

      const event = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1000,
        content: 'Direct note attempt',
      });

      await readOnlySession.webSocketMessage(ws, JSON.stringify(['EVENT', event]));

      expect(testWs.sentMessages).toHaveLength(1);
      const okMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(okMsg[0]).toBe('OK');
      expect(okMsg[1]).toBe(event.id);
      expect(okMsg[2]).toBe(false);
      expect(okMsg[3]).toBe('blocked: this relay operates in read-only caching mode');

      // Verify event was NOT persisted to D1
      expect(mockDb.events.has(event.id)).toBe(false);
    });

    it('allows relay operator (RELAY_PUBKEY) to write even in read-only mode', async () => {
      const operatorEnv: Env = {
        ...mockEnv,
        ALLOW_DIRECT_WRITES: 'false',
        RELAY_PUBKEY: pubkeyA,
      };
      const operatorSession = new ClientSession(
        mockState as unknown as DurableObjectState,
        operatorEnv
      );

      const testWs = new TestWebSocket();
      const ws = testWs as unknown as WebSocket;

      const operatorEvent = createSignedEvent(privKeyA, {
        kind: 1,
        created_at: 1000,
        content: 'Announcement from relay operator',
      });

      await operatorSession.webSocketMessage(ws, JSON.stringify(['EVENT', operatorEvent]));

      expect(testWs.sentMessages).toHaveLength(1);
      const okMsg = JSON.parse(testWs.sentMessages[0]!);
      expect(okMsg[0]).toBe('OK');
      expect(okMsg[1]).toBe(operatorEvent.id);
      expect(okMsg[2]).toBe(true);

      // Verify operator event was persisted
      expect(mockDb.events.has(operatorEvent.id)).toBe(true);
    });
  });
});

