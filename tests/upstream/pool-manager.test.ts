import { describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { computeEventId } from '../../src/crypto/canonical';
import type { NostrEvent } from '../../src/types/nostr';
import { UpstreamPoolManager } from '../../src/upstream/pool-manager';
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

describe('UpstreamPoolManager', () => {
  const privKey = secp256k1.utils.randomPrivateKey();

  it('queries multiple relays in parallel, deduplicates events across relays, and aggregates EOSE', async () => {
    const sockets = new Map<string, MockClientWebSocket>();

    const poolManager = new UpstreamPoolManager(
      {
        defaultRelays: ['wss://relay1.com', 'wss://relay2.com'],
        defaultTimeoutMs: 1000,
      },
      {
        webSocketFactory: (url) => {
          const mockWs = new MockClientWebSocket(url);
          sockets.set(url, mockWs);
          return mockWs as unknown as WebSocket;
        },
      }
    );

    const eventShared = createSignedEvent(privKey, {
      kind: 1,
      created_at: 1000,
      content: 'Shared across both relays',
    });

    const eventUnique = createSignedEvent(privKey, {
      kind: 1,
      created_at: 2000,
      content: 'Only on relay2',
    });

    const streamedEvents: NostrEvent[] = [];

    const pullPromise = poolManager.pullEvents(
      {
        subId: 'sub_parallel',
        filters: [{ kinds: [1] }],
      },
      (event) => {
        streamedEvents.push(event);
      }
    );

    // Allow sockets to open
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(sockets.size).toBe(2);

    const ws1 = sockets.get('wss://relay1.com')!;
    const ws2 = sockets.get('wss://relay2.com')!;

    // Both relays emit eventShared
    ws1.simulateServerMessage(JSON.stringify(['EVENT', 'sub_parallel', eventShared]));
    ws2.simulateServerMessage(JSON.stringify(['EVENT', 'sub_parallel', eventShared]));

    // Only ws2 emits eventUnique
    ws2.simulateServerMessage(JSON.stringify(['EVENT', 'sub_parallel', eventUnique]));

    // Emit EOSE on both
    ws1.simulateServerMessage(JSON.stringify(['EOSE', 'sub_parallel']));
    ws2.simulateServerMessage(JSON.stringify(['EOSE', 'sub_parallel']));

    const result = await pullPromise;

    // Streamed events should have exact deduplication
    expect(streamedEvents).toHaveLength(2);
    expect(streamedEvents.map((e) => e.id)).toEqual([eventShared.id, eventUnique.id]);

    expect(result.events).toHaveLength(2);
    expect(result.relaysSuccessful).toContain('wss://relay1.com');
    expect(result.relaysSuccessful).toContain('wss://relay2.com');
    expect(result.relaysFailed).toHaveLength(0);
    expect(result.timedOut).toBe(false);
  });

  it('triggers timeout when an upstream relay hangs and returns collected events so far', async () => {
    const sockets = new Map<string, MockClientWebSocket>();

    const poolManager = new UpstreamPoolManager(
      {
        defaultRelays: ['wss://fast.relay', 'wss://slow.relay'],
        defaultTimeoutMs: 100, // Short timeout for test
      },
      {
        webSocketFactory: (url) => {
          const mockWs = new MockClientWebSocket(url);
          sockets.set(url, mockWs);
          return mockWs as unknown as WebSocket;
        },
      }
    );

    const event = createSignedEvent(privKey, {
      kind: 1,
      created_at: 1000,
      content: 'From fast relay',
    });

    const pullPromise = poolManager.pullEvents(
      {
        subId: 'sub_timeout',
        filters: [{ kinds: [1] }],
        timeoutMs: 100,
      },
      () => {}
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const fastWs = sockets.get('wss://fast.relay')!;
    fastWs.simulateServerMessage(JSON.stringify(['EVENT', 'sub_timeout', event]));
    fastWs.simulateServerMessage(JSON.stringify(['EOSE', 'sub_timeout']));

    // slow.relay hangs and never sends EOSE

    const result = await pullPromise;
    expect(result.timedOut).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.id).toBe(event.id);
  });

  it('handles partial relay errors gracefully', async () => {
    const sockets = new Map<string, MockClientWebSocket>();

    const poolManager = new UpstreamPoolManager(
      {
        defaultRelays: ['wss://ok.relay', 'wss://error.relay'],
        defaultTimeoutMs: 500,
      },
      {
        webSocketFactory: (url) => {
          const mockWs = new MockClientWebSocket(url);
          sockets.set(url, mockWs);
          return mockWs as unknown as WebSocket;
        },
      }
    );

    const event = createSignedEvent(privKey, {
      kind: 1,
      created_at: 1000,
      content: 'From OK relay',
    });

    const pullPromise = poolManager.pullEvents(
      {
        subId: 'sub_partial',
        filters: [{ kinds: [1] }],
      },
      () => {}
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const okWs = sockets.get('wss://ok.relay')!;
    const errorWs = sockets.get('wss://error.relay')!;

    okWs.simulateServerMessage(JSON.stringify(['EVENT', 'sub_partial', event]));
    okWs.simulateServerMessage(JSON.stringify(['EOSE', 'sub_partial']));

    errorWs.simulateServerError('Upstream connection failed');

    const result = await pullPromise;
    expect(result.timedOut).toBe(false);
    expect(result.relaysSuccessful).toContain('wss://ok.relay');
    expect(result.relaysFailed).toContain('wss://error.relay');
    expect(result.events).toHaveLength(1);
  });

  it('aborts active subscription and closes all connected sockets', async () => {
    const sockets = new Map<string, MockClientWebSocket>();

    const poolManager = new UpstreamPoolManager(
      {
        defaultRelays: ['wss://relay1.com', 'wss://relay2.com'],
        defaultTimeoutMs: 2000,
      },
      {
        webSocketFactory: (url) => {
          const mockWs = new MockClientWebSocket(url);
          sockets.set(url, mockWs);
          return mockWs as unknown as WebSocket;
        },
      }
    );

    poolManager.pullEvents(
      {
        subId: 'sub_abort',
        filters: [{ kinds: [1] }],
      },
      () => {}
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(poolManager.activePullCount()).toBe(1);

    poolManager.abort('sub_abort');
    expect(poolManager.activePullCount()).toBe(0);

    for (const ws of sockets.values()) {
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    }
  });

  it('coordinates subscribeLive across parallel upstreams, triggers initial EOSE, and streams live events', async () => {
    const sockets = new Map<string, MockClientWebSocket>();

    const poolManager = new UpstreamPoolManager(
      {
        defaultRelays: ['wss://relay1.com', 'wss://relay2.com'],
        defaultTimeoutMs: 1000,
      },
      {
        webSocketFactory: (url) => {
          const mockWs = new MockClientWebSocket(url);
          sockets.set(url, mockWs);
          return mockWs as unknown as WebSocket;
        },
      }
    );

    const initialEvent = createSignedEvent(privKey, {
      kind: 1,
      created_at: 1000,
      content: 'Initial event from relay1',
    });

    const liveEvent = createSignedEvent(privKey, {
      kind: 1,
      created_at: 2000,
      content: 'Live event from relay2',
    });

    const receivedEvents: { event: NostrEvent; isInitial: boolean }[] = [];
    let initialEoseFired = false;

    const handle = poolManager.subscribeLive(
      {
        subId: 'sub_live_pool',
        filters: [{ kinds: [1] }],
      },
      {
        onEvent: (event, isInitial) => {
          receivedEvents.push({ event, isInitial });
        },
        onInitialEose: () => {
          initialEoseFired = true;
        },
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    const ws1 = sockets.get('wss://relay1.com')!;
    const ws2 = sockets.get('wss://relay2.com')!;

    // 1. Initial event arrives before EOSE
    ws1.simulateServerMessage(JSON.stringify(['EVENT', 'sub_live_pool', initialEvent]));
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.isInitial).toBe(true);

    // 2. Both relays send EOSE
    ws1.simulateServerMessage(JSON.stringify(['EOSE', 'sub_live_pool']));
    expect(initialEoseFired).toBe(false); // Waiting for ws2

    ws2.simulateServerMessage(JSON.stringify(['EOSE', 'sub_live_pool']));
    expect(initialEoseFired).toBe(true); // Now both completed
    expect(handle.isInitialEoseComplete()).toBe(true);

    // Sockets must stay OPEN for live streaming
    expect(ws1.readyState).toBe(WebSocket.OPEN);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    // 3. Live event arrives after initial EOSE on relay2
    ws2.simulateServerMessage(JSON.stringify(['EVENT', 'sub_live_pool', liveEvent]));
    expect(receivedEvents).toHaveLength(2);
    expect(receivedEvents[1]!.isInitial).toBe(false);
    expect(receivedEvents[1]!.event.id).toBe(liveEvent.id);

    // 4. Teardown
    handle.close();
    expect(ws1.readyState).toBe(WebSocket.CLOSED);
    expect(ws2.readyState).toBe(WebSocket.CLOSED);
    expect(poolManager.activeSubscriptionCount()).toBe(0);
  });
});

