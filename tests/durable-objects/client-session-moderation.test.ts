import { beforeEach, describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { ClientSession } from '../../src/durable-objects/client-session';
import { computeEventId } from '../../src/crypto/canonical';
import type { Env } from '../../src/types/env';
import type { NostrEvent } from '../../src/types/nostr';
import { MockD1Database } from '../mocks/mock-d1';
import { MockDurableObjectState } from '../mocks/cloudflare-workers';
import { MockClientWebSocket } from '../mocks/mock-websocket';

class TestWebSocket {
  public sentMessages: string[] = [];
  public closed = false;

  send(data: string | ArrayBuffer): void {
    if (this.closed) throw new Error('WebSocket is already closed');
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

describe('ClientSession - Content Moderation & Operator Rule Enforcement', () => {
  let mockDb: MockD1Database;
  let mockState: MockDurableObjectState;
  let env: Env;
  let session: ClientSession;
  let clientWs: TestWebSocket;

  const operatorPrivKey = new Uint8Array(32).fill(1);
  const operatorPubkey = bytesToHex(schnorr.getPublicKey(operatorPrivKey));

  const userPrivKey = new Uint8Array(32).fill(2);

  beforeEach(() => {
    mockDb = new MockD1Database();
    mockState = new MockDurableObjectState();
    env = {
      DB: mockDb as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<ClientSession>,
      RELAY_PUBKEY: operatorPubkey,
      ALLOW_DIRECT_WRITES: 'true',
      UPSTREAM_RELAYS: 'wss://relay1.example.com',
      UPSTREAM_TIMEOUT_MS: '200',
    };
    session = new ClientSession(mockState as unknown as DurableObjectState, env);
    clientWs = new TestWebSocket();
  });

  it('rejects direct client EVENT write containing NIP-36 content-warning tag', async () => {
    const sensitiveEvent = createSignedEvent(userPrivKey, {
      kind: 1,
      created_at: 1700000000,
      tags: [['content-warning', 'nsfw']],
      content: 'Sensitive picture here',
    });

    await session.webSocketMessage(
      clientWs as unknown as WebSocket,
      JSON.stringify(['EVENT', sensitiveEvent])
    );

    expect(clientWs.sentMessages.length).toBe(1);
    const okMsg = JSON.parse(clientWs.sentMessages[0] as string);
    expect(okMsg[0]).toBe('OK');
    expect(okMsg[1]).toBe(sensitiveEvent.id);
    expect(okMsg[2]).toBe(false);
    expect(okMsg[3]).toContain('blocked: content-warning tag present (NIP-36)');

    // Verify NOT saved to D1
    expect(mockDb.events.has(sensitiveEvent.id)).toBe(false);
  });

  it('rejects direct client EVENT write containing NIP-32 sensitive label', async () => {
    const adultEvent = createSignedEvent(userPrivKey, {
      kind: 1,
      created_at: 1700000000,
      tags: [['l', 'adult', 'ISO-3166-1']],
      content: 'Adult note content',
    });

    await session.webSocketMessage(
      clientWs as unknown as WebSocket,
      JSON.stringify(['EVENT', adultEvent])
    );

    const okMsg = JSON.parse(clientWs.sentMessages[0] as string);
    expect(okMsg[0]).toBe('OK');
    expect(okMsg[1]).toBe(adultEvent.id);
    expect(okMsg[2]).toBe(false);
    expect(okMsg[3]).toContain('blocked: sensitive or adult label present (NIP-32)');
  });

  it('drops sensitive events pulled from upstream relays before streaming to client and persisting', async () => {
    const cleanUpstreamEvent = createSignedEvent(userPrivKey, {
      kind: 1,
      created_at: 1700000010,
      tags: [],
      content: 'Clean upstream note',
    });

    const sensitiveUpstreamEvent = createSignedEvent(userPrivKey, {
      kind: 1,
      created_at: 1700000020,
      tags: [['content-warning']],
      content: 'Sensitive upstream note',
    });

    session.setWebSocketFactory((url: string) => {
      const mockRelayWs = new MockClientWebSocket(url);
      const origSend = mockRelayWs.send.bind(mockRelayWs);
      mockRelayWs.send = (data: string | ArrayBuffer) => {
        origSend(data);
        const parsed = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
        if (parsed[0] === 'REQ') {
          const subId = parsed[1];
          queueMicrotask(() => {
            mockRelayWs.simulateServerMessage(JSON.stringify(['EVENT', subId, cleanUpstreamEvent]));
            mockRelayWs.simulateServerMessage(JSON.stringify(['EVENT', subId, sensitiveUpstreamEvent]));
            mockRelayWs.simulateServerMessage(JSON.stringify(['EOSE', subId]));
          });
        }
      };
      return mockRelayWs as unknown as WebSocket;
    });

    await session.webSocketMessage(
      clientWs as unknown as WebSocket,
      JSON.stringify(['REQ', 'sub1', { kinds: [1] }])
    );

    const eventMessages = clientWs.sentMessages
      .map((m) => JSON.parse(m))
      .filter((m) => m[0] === 'EVENT');

    // Only the clean event should be streamed to the client
    expect(eventMessages.length).toBe(1);
    expect(eventMessages[0][2].id).toBe(cleanUpstreamEvent.id);

    // Only the clean event should be persisted to D1
    expect(mockDb.events.has(cleanUpstreamEvent.id)).toBe(true);
    expect(mockDb.events.has(sensitiveUpstreamEvent.id)).toBe(false);
  });

  it('hot-reloads moderation rules when operator publishes kind 10000 mute list', async () => {
    const mutedAuthorPrivKey = new Uint8Array(32).fill(3);
    const mutedAuthorPubkey = bytesToHex(schnorr.getPublicKey(mutedAuthorPrivKey));

    // Operator publishes kind 10000 mute list
    const operatorMuteEvent = createSignedEvent(operatorPrivKey, {
      kind: 10000,
      created_at: 1700000100,
      tags: [
        ['p', mutedAuthorPubkey],
        ['word', 'toxicdomain.org'],
        ['t', 'bannedtopic'],
      ],
      content: '',
    });

    await session.webSocketMessage(
      clientWs as unknown as WebSocket,
      JSON.stringify(['EVENT', operatorMuteEvent])
    );

    const okMsg = JSON.parse(clientWs.sentMessages[0] as string);
    expect(okMsg[0]).toBe('OK');
    expect(okMsg[2]).toBe(true);

    // Now try to publish from muted author
    const eventFromMutedAuthor = createSignedEvent(mutedAuthorPrivKey, {
      kind: 1,
      created_at: 1700000200,
      tags: [],
      content: 'Trying to post from muted account',
    });

    clientWs.sentMessages = [];
    await session.webSocketMessage(
      clientWs as unknown as WebSocket,
      JSON.stringify(['EVENT', eventFromMutedAuthor])
    );

    const blockedMsg = JSON.parse(clientWs.sentMessages[0] as string);
    expect(blockedMsg[0]).toBe('OK');
    expect(blockedMsg[1]).toBe(eventFromMutedAuthor.id);
    expect(blockedMsg[2]).toBe(false);
    expect(blockedMsg[3]).toContain('blocked: author pubkey is muted by relay operator');

    // Try to post note with banned word
    const noteWithBannedWord = createSignedEvent(userPrivKey, {
      kind: 1,
      created_at: 1700000300,
      tags: [],
      content: 'Check out https://toxicdomain.org/scam',
    });

    clientWs.sentMessages = [];
    await session.webSocketMessage(
      clientWs as unknown as WebSocket,
      JSON.stringify(['EVENT', noteWithBannedWord])
    );

    const blockedWordMsg = JSON.parse(clientWs.sentMessages[0] as string);
    expect(blockedWordMsg[0]).toBe('OK');
    expect(blockedWordMsg[2]).toBe(false);
    expect(blockedWordMsg[3]).toContain('blocked: prohibited content or domain pattern');
  });
});
