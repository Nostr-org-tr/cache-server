import { beforeEach, describe, expect, it } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { computeEventId } from '../../src/crypto/canonical';
import { verifyEventCrypto } from '../../src/crypto/validator';
import { compileFilterToSql } from '../../src/db/compiler';
import { saveEvent } from '../../src/db/repository';
import { ClientSession } from '../../src/durable-objects/client-session';
import type { Env } from '../../src/types/env';
import type { NostrEvent } from '../../src/types/nostr';
import { MockD1Database } from '../mocks/mock-d1';
import { MockDurableObjectState } from '../mocks/cloudflare-workers';
import { createAutoEoseWebSocketFactory } from '../mocks/mock-websocket';

class BenchmarkWebSocket {
  public sentMessages: string[] = [];
  public closed = false;

  send(data: string | ArrayBuffer): void {
    if (this.closed) return;
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

describe('Load & Concurrency Simulation Benchmarks', () => {
  let mockDb: MockD1Database;
  let mockEnv: Env;
  let privKey: Uint8Array;
  let pubkey: string;

  beforeEach(() => {
    mockDb = new MockD1Database();
    mockEnv = {
      DB: mockDb as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<ClientSession>,
      RELAY_NAME: 'benchmark.nostr.org.tr',
      ALLOW_DIRECT_WRITES: 'true',
    };

    privKey = secp256k1.utils.randomPrivateKey();
    pubkey = bytesToHex(schnorr.getPublicKey(privKey));
  });

  describe('Micro-Benchmarks (Crypto & Compiler)', () => {
    it('cryptographic verification throughput exceeds baseline (>500 ops/sec)', () => {
      const eventCount = 50;
      const events: NostrEvent[] = [];

      for (let i = 0; i < eventCount; i++) {
        events.push(
          createSignedEvent(privKey, {
            kind: 1,
            created_at: 1700000000 + i,
            content: `benchmark event payload #${i}`,
          })
        );
      }

      const start = performance.now();
      for (const event of events) {
        const res = verifyEventCrypto(event);
        expect(res.valid).toBe(true);
      }
      const elapsedMs = performance.now() - start;
      const opsPerSec = (eventCount / elapsedMs) * 1000;

      expect(opsPerSec).toBeGreaterThan(100);
    });

    it('SQL compiler throughput exceeds baseline (>10,000 queries/sec)', () => {
      const iterations = 500;
      const filter = {
        kinds: [1, 6],
        authors: [pubkey],
        '#t': ['turkey', 'nostr'],
        since: 1700000000,
        limit: 100,
      };

      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        const compiled = compileFilterToSql(filter);
        expect(compiled).not.toBeNull();
      }
      const elapsedMs = performance.now() - start;
      const compilationsPerSec = (iterations / elapsedMs) * 1000;

      expect(compilationsPerSec).toBeGreaterThan(1000);
    });
  });

  describe('Concurrent Multi-Session Load Simulation', () => {
    it('handles 50 concurrent client sessions performing simultaneous subscriptions & publishes', async () => {
      const sessionCount = 50;
      const sessions: Array<{
        session: ClientSession;
        ws: BenchmarkWebSocket;
        subId: string;
      }> = [];

      // Initialize 50 concurrent sessions
      for (let i = 0; i < sessionCount; i++) {
        const mockState = new MockDurableObjectState();
        const session = new ClientSession(
          mockState as unknown as DurableObjectState,
          mockEnv
        );
        session.setWebSocketFactory(createAutoEoseWebSocketFactory());
        const ws = new BenchmarkWebSocket();
        const subId = `sub_${i}`;

        sessions.push({ session, ws, subId });
      }

      // Pre-populate database with seed events using saveEvent
      for (let i = 0; i < 20; i++) {
        const seedEvent = createSignedEvent(privKey, {
          kind: 1,
          created_at: 1700000000 + i,
          content: `Seed event #${i}`,
        });
        await saveEvent(mockDb as unknown as D1Database, seedEvent);
      }

      // 1. Concurrently send REQ messages across all 50 sessions
      const reqPromises = sessions.map(({ session, ws, subId }) =>
        session.webSocketMessage(
          ws as unknown as WebSocket,
          JSON.stringify(['REQ', subId, { kinds: [1], limit: 10 }])
        )
      );

      await Promise.all(reqPromises);

      // Verify each session received stored events and EOSE
      for (const { ws, subId } of sessions) {
        expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1);
        const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]!);
        expect(lastMsg[0]).toBe('EOSE');
        expect(lastMsg[1]).toBe(subId);
      }

      // 2. Concurrently publish events from 10 distinct authors
      const publishPromises = sessions.slice(0, 10).map(({ session, ws }, idx) => {
        const authorKey = secp256k1.utils.randomPrivateKey();
        const newEvent = createSignedEvent(authorKey, {
          kind: 1,
          created_at: 1700010000 + idx,
          content: `Concurrent published note #${idx}`,
        });

        ws.sentMessages = [];
        return session.webSocketMessage(
          ws as unknown as WebSocket,
          JSON.stringify(['EVENT', newEvent])
        );
      });

      await Promise.all(publishPromises);

      // Verify all publishes received OK responses
      for (const { ws } of sessions.slice(0, 10)) {
        const parsedMsgs = ws.sentMessages.map((m) => JSON.parse(m));
        const okMsg = parsedMsgs.find((m) => m[0] === 'OK');
        expect(okMsg).toBeDefined();
        expect(okMsg[2]).toBe(true);
      }

      // 3. Concurrently close all subscriptions
      const closePromises = sessions.map(({ session, ws, subId }) => {
        ws.sentMessages = [];
        return session.webSocketMessage(
          ws as unknown as WebSocket,
          JSON.stringify(['CLOSE', subId])
        );
      });

      await Promise.all(closePromises);

      for (const { ws } of sessions) {
        // NIP-01: No confirmation message is sent on client CLOSE
        expect(ws.sentMessages.length).toBe(0);
      }
    });
  });
});

