import { describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { computeEventId } from '../../src/crypto/canonical';
import type { NostrEvent } from '../../src/types/nostr';
import { UpstreamRelayClient } from '../../src/upstream/relay-client';
import { MockClientWebSocket } from '../mocks/mock-websocket';

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

describe('UpstreamRelayClient', () => {
  const privKey = secp256k1.utils.randomPrivateKey();

  it('connects, sends REQ message on open, and processes valid incoming EVENTs and EOSE', async () => {
    let mockWs: MockClientWebSocket | null = null;
    const client = new UpstreamRelayClient('wss://relay.damus.io', {
      webSocketFactory: (url) => {
        mockWs = new MockClientWebSocket(url);
        return mockWs as unknown as WebSocket;
      },
    });

    const receivedEvents: NostrEvent[] = [];
    let eoseCalled = false;
    let errorCalled = false;

    const event1 = createSignedEvent(privKey, {
      kind: 1,
      created_at: 1000,
      content: 'Upstream note',
    });

    client.subscribe(
      'sub_1',
      [{ kinds: [1] }],
      {
        onEvent: (event) => receivedEvents.push(event),
        onEose: () => {
          eoseCalled = true;
        },
        onError: () => {
          errorCalled = true;
        },
      }
    );

    // Wait for connection to open
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(mockWs).toBeDefined();
    expect(mockWs!.sentMessages).toHaveLength(1);
    const sentReq = JSON.parse(mockWs!.sentMessages[0]!);
    expect(sentReq[0]).toBe('REQ');
    expect(sentReq[1]).toBe('sub_1');
    expect(sentReq[2]).toEqual({ kinds: [1] });

    // Simulate incoming valid event
    mockWs!.simulateServerMessage(JSON.stringify(['EVENT', 'sub_1', event1]));
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.id).toBe(event1.id);

    // Simulate EOSE
    mockWs!.simulateServerMessage(JSON.stringify(['EOSE', 'sub_1']));
    expect(eoseCalled).toBe(true);
    expect(errorCalled).toBe(false);
  });

  it('cryptographically rejects tampered events from upstream', async () => {
    let mockWs: MockClientWebSocket | null = null;
    const client = new UpstreamRelayClient('wss://nos.lol', {
      webSocketFactory: (url) => {
        mockWs = new MockClientWebSocket(url);
        return mockWs as unknown as WebSocket;
      },
    });

    const receivedEvents: NostrEvent[] = [];
    const validEvent = createSignedEvent(privKey, {
      kind: 1,
      created_at: 1000,
      content: 'Legit',
    });

    const tamperedEvent: NostrEvent = {
      ...validEvent,
      content: 'Tampered content',
    };

    client.subscribe(
      'sub_tamper',
      [{ kinds: [1] }],
      {
        onEvent: (event) => receivedEvents.push(event),
        onEose: () => {},
        onError: () => {},
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Send tampered event
    mockWs!.simulateServerMessage(JSON.stringify(['EVENT', 'sub_tamper', tamperedEvent]));
    // Should be dropped
    expect(receivedEvents).toHaveLength(0);

    // Send valid event
    mockWs!.simulateServerMessage(JSON.stringify(['EVENT', 'sub_tamper', validEvent]));
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.id).toBe(validEvent.id);
  });

  it('handles server error and triggers onError callback', async () => {
    let mockWs: MockClientWebSocket | null = null;
    const client = new UpstreamRelayClient('wss://bad.relay', {
      webSocketFactory: (url) => {
        mockWs = new MockClientWebSocket(url);
        return mockWs as unknown as WebSocket;
      },
    });

    let errorReceived: Error | null = null;
    client.subscribe(
      'sub_err',
      [{ kinds: [1] }],
      {
        onEvent: () => {},
        onEose: () => {},
        onError: (err) => {
          errorReceived = err;
        },
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    mockWs!.simulateServerError('Connection dropped');

    expect(errorReceived).toBeDefined();
    expect(errorReceived!.message).toContain('Connection dropped');
  });

  it('sends CLOSE and terminates socket cleanly on client.close()', async () => {
    let mockWs: MockClientWebSocket | null = null;
    const client = new UpstreamRelayClient('wss://relay.nostr.band', {
      webSocketFactory: (url) => {
        mockWs = new MockClientWebSocket(url);
        return mockWs as unknown as WebSocket;
      },
    });

    client.subscribe(
      'sub_close',
      [{ kinds: [1] }],
      {
        onEvent: () => {},
        onEose: () => {},
        onError: () => {},
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    client.close();


    expect(mockWs!.readyState).toBe(WebSocket.CLOSED);
    const lastSent = JSON.parse(mockWs!.sentMessages[mockWs!.sentMessages.length - 1]!);
    expect(lastSent[0]).toBe('CLOSE');
    expect(lastSent[1]).toBe('sub_close');
  });


  it('keeps connection alive after EOSE and streams subsequent live events', async () => {
    let mockWs: MockClientWebSocket | null = null;
    const client = new UpstreamRelayClient('wss://relay.damus.io', {
      webSocketFactory: (url) => {
        mockWs = new MockClientWebSocket(url);
        return mockWs as unknown as WebSocket;
      },
    });

    const receivedEvents: { event: NostrEvent; isLive: boolean }[] = [];
    let eoseCount = 0;

    const initialEvent = createSignedEvent(privKey, {
      kind: 1,
      created_at: 1000,
      content: 'Initial history note',
    });

    const liveEvent = createSignedEvent(privKey, {
      kind: 1,
      created_at: 2000,
      content: 'Subsequent live note',
    });

    client.subscribe(
      'sub_live',
      [{ kinds: [1] }],
      {
        onEvent: (event, isLive) => receivedEvents.push({ event, isLive }),
        onEose: () => {
          eoseCount++;
        },
        onError: () => {},
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    // 1. Initial history event arrives before EOSE
    mockWs!.simulateServerMessage(JSON.stringify(['EVENT', 'sub_live', initialEvent]));
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.isLive).toBe(false);

    // 2. Relay sends EOSE
    mockWs!.simulateServerMessage(JSON.stringify(['EOSE', 'sub_live']));
    expect(eoseCount).toBe(1);
    expect(client.isInitialEoseReceived()).toBe(true);
    expect(client.getStatus()).toBe('live');

    // 3. Subsequent live event arrives AFTER EOSE
    mockWs!.simulateServerMessage(JSON.stringify(['EVENT', 'sub_live', liveEvent]));
    expect(receivedEvents).toHaveLength(2);
    expect(receivedEvents[1]!.isLive).toBe(true);
    expect(receivedEvents[1]!.event.id).toBe(liveEvent.id);

    client.close();
  });

  it('defaultWebSocketFactory converts wss to https and calls fetch with websocket upgrade', async () => {
    let fetchCalledWithUrl = '';
    let fetchHeaders: Record<string, string> = {};
    let acceptCalled = false;

    const mockWs = new MockClientWebSocket('wss://relay.damus.io');
    (mockWs as unknown as { accept: () => void }).accept = () => {
      acceptCalled = true;
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalledWithUrl = input.toString();
      fetchHeaders = (init?.headers as Record<string, string>) || {};
      return {
        status: 101,
        statusText: 'Switching Protocols',
        webSocket: mockWs as unknown as WebSocket,
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const { defaultWebSocketFactory } = await import('../../src/upstream/relay-client');
      const ws = await defaultWebSocketFactory('wss://relay.damus.io');

      expect(fetchCalledWithUrl).toBe('https://relay.damus.io');
      expect(fetchHeaders.Upgrade).toBe('websocket');
      expect(acceptCalled).toBe(true);
      expect(ws).toBe(mockWs);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('handles async webSocketFactory rejection gracefully', async () => {
    const client = new UpstreamRelayClient('wss://unreachable.relay', {
      webSocketFactory: async () => {
        throw new Error('Connection refused');
      },
    });

    let errorReceived: Error | null = null;
    client.subscribe(
      'sub_fail',
      [{ kinds: [1] }],
      {
        onEvent: () => {},
        onEose: () => {},
        onError: (err) => {
          errorReceived = err;
        },
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.getStatus()).toBe('error');
    expect(errorReceived).toBeDefined();
    expect(errorReceived!.message).toContain('Connection refused');
  });

  it('cleans up properly if client.close() is called before async connection resolves', async () => {
    let mockWs: MockClientWebSocket | null = null;
    let resolveFactory: (ws: WebSocket) => void = () => {};

    const client = new UpstreamRelayClient('wss://slow.relay', {
      webSocketFactory: () =>
        new Promise((resolve) => {
          resolveFactory = resolve;
        }),
    });

    client.subscribe(
      'sub_slow',
      [{ kinds: [1] }],
      {
        onEvent: () => {},
        onEose: () => {},
        onError: () => {},
      }
    );

    // Close before factory resolves
    client.close();

    // Now resolve factory
    mockWs = new MockClientWebSocket('wss://slow.relay');
    resolveFactory(mockWs as unknown as WebSocket);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(client.getStatus()).toBe('closed');
    expect(mockWs.readyState).toBe(WebSocket.CLOSED);
  });
});


