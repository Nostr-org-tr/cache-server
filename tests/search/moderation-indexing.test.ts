import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { computeEventId } from '../../src/crypto/canonical';
import { executeSearch } from '../../src/search/engine';
import { indexEventsBatchVector, indexEventVector } from '../../src/search/vector-store';
import type { Env } from '../../src/types/env';
import type { NostrEvent } from '../../src/types/nostr';
import { MockD1Database } from '../mocks/mock-d1';

class MockAi {
  public runCalls: Array<{ model: string; input: unknown }> = [];

  async run(model: string, input: unknown): Promise<{ data: number[][] }> {
    this.runCalls.push({ model, input });
    const texts = (input as { text: string[] }).text;
    return {
      data: texts.map(() => new Array(384).fill(0.1)),
    };
  }
}

class MockVectorizeIndex {
  public upserted: VectorizeVector[] = [];
  public deletedIds: string[] = [];

  async upsert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation> {
    this.upserted.push(...vectors);
    return { ids: vectors.map((v) => v.id) } as unknown as VectorizeAsyncMutation;
  }

  async deleteByIds(ids: string[]): Promise<VectorizeAsyncMutation> {
    this.deletedIds.push(...ids);
    return { ids } as unknown as VectorizeAsyncMutation;
  }

  async query(): Promise<VectorizeMatches> {
    return { count: 0, matches: [] };
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

describe('Search & Vector Index - Moderation Safeguards', () => {
  const userPrivKey = new Uint8Array(32).fill(5);

  it('rejects single vector indexing for event with NIP-36 content-warning', async () => {
    const mockAi = new MockAi();
    const mockVector = new MockVectorizeIndex();

    const sensitiveEvent = createSignedEvent(userPrivKey, {
      kind: 1,
      created_at: 1700000000,
      tags: [['content-warning', 'nsfw']],
      content: 'Sensitive note content',
    });

    const indexed = await indexEventVector(
      mockAi as unknown as Ai,
      mockVector as unknown as VectorizeIndex,
      sensitiveEvent
    );

    expect(indexed).toBe(false);
    expect(mockAi.runCalls.length).toBe(0);
    expect(mockVector.upserted.length).toBe(0);
  });

  it('filters out sensitive events in batch vector indexing', async () => {
    const mockAi = new MockAi();
    const mockVector = new MockVectorizeIndex();

    const cleanEvent = createSignedEvent(userPrivKey, {
      kind: 1,
      created_at: 1700000010,
      tags: [],
      content: 'Clean search note about Nostr and Bitcoin',
    });

    const sensitiveEvent = createSignedEvent(userPrivKey, {
      kind: 1,
      created_at: 1700000020,
      tags: [['content-warning']],
      content: 'NSFW search note',
    });

    const indexedCount = await indexEventsBatchVector(
      mockAi as unknown as Ai,
      mockVector as unknown as VectorizeIndex,
      [cleanEvent, sensitiveEvent]
    );

    expect(indexedCount).toBe(1);
    expect(mockVector.upserted.length).toBe(1);
    expect(mockVector.upserted[0]?.id).toBe(cleanEvent.id);
  });

  it('skips moderated candidate events during executeSearch', async () => {
    const mockDb = new MockD1Database();
    const env = {
      DB: mockDb as unknown as D1Database,
      VECTOR_SEARCH_ENABLED: 'false',
    } as unknown as Env;

    const cleanEvent = createSignedEvent(userPrivKey, {
      kind: 1,
      created_at: 1700000010,
      tags: [],
      content: 'Decentralized Nostr protocol relay cache',
    });

    const sensitiveEvent = createSignedEvent(userPrivKey, {
      kind: 1,
      created_at: 1700000020,
      tags: [['content-warning']],
      content: 'Decentralized NSFW post',
    });

    mockDb.events.set(cleanEvent.id, {
      id: cleanEvent.id,
      pubkey: cleanEvent.pubkey,
      created_at: cleanEvent.created_at,
      kind: cleanEvent.kind,
      d_tag: null,
      raw_event: JSON.stringify(cleanEvent),
      created_at_recorded: 1700000010,
    });

    mockDb.events.set(sensitiveEvent.id, {
      id: sensitiveEvent.id,
      pubkey: sensitiveEvent.pubkey,
      created_at: sensitiveEvent.created_at,
      kind: sensitiveEvent.kind,
      d_tag: null,
      raw_event: JSON.stringify(sensitiveEvent),
      created_at_recorded: 1700000020,
    });

    const results = await executeSearch(
      mockDb as unknown as D1Database,
      env,
      { search: 'Decentralized', kinds: [1] },
      10
    );

    expect(results.length).toBe(1);
    expect(results[0]?.event.id).toBe(cleanEvent.id);
  });
});
