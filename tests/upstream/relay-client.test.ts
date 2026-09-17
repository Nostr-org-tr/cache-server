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
});
