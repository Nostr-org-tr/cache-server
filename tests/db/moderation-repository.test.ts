import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { computeEventId } from '../../src/crypto/canonical';
import {
  loadOperatorModerationRules,
  purgeModeratedEntities,
  saveEvent,
} from '../../src/db/repository';
import type { NostrEvent } from '../../src/types/nostr';
import { MockD1Database } from '../mocks/mock-d1';

class MockVectorizeIndex {
  public deletedIds: string[] = [];

  async deleteByIds(ids: string[]): Promise<VectorizeAsyncMutation> {
    this.deletedIds.push(...ids);
    return { ids } as unknown as VectorizeAsyncMutation;
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

describe('Database Repository - Moderation Rules Loading & Entity Purging', () => {
  const operatorPrivKey = new Uint8Array(32).fill(10);
  const operatorPubkey = bytesToHex(schnorr.getPublicKey(operatorPrivKey));

  const spammerPrivKey = new Uint8Array(32).fill(20);
  const spammerPubkey = bytesToHex(schnorr.getPublicKey(spammerPrivKey));

  it('loads operator moderation rules from stored kind 10000 and 1984 events', async () => {
    const mockDb = new MockD1Database();

    const operatorMuteEvent = createSignedEvent(operatorPrivKey, {
      kind: 10000,
      created_at: 1700000100,
      tags: [
        ['p', spammerPubkey],
        ['word', 'bandomain.xyz'],
        ['t', 'illegalhashtag'],
      ],
      content: '',
    });

    const saveResult = await saveEvent(mockDb as unknown as D1Database, operatorMuteEvent);
    expect(saveResult.action).not.toBe('ignored');

    const ruleset = await loadOperatorModerationRules(
      mockDb as unknown as D1Database,
      operatorPubkey
    );

    expect(ruleset.blockedPubkeys.has(spammerPubkey)).toBe(true);
    expect(ruleset.bannedWordsAndDomains).toContain('bandomain.xyz');
    expect(ruleset.bannedHashtags.has('illegalhashtag')).toBe(true);
  });

  it('purges moderated event IDs and pubkeys retroactively from D1 and Vectorize', async () => {
    const mockDb = new MockD1Database();
    const mockVector = new MockVectorizeIndex();

    const spamNote1 = createSignedEvent(spammerPrivKey, {
      kind: 1,
      created_at: 1700000010,
      tags: [],
      content: 'Spam note 1',
    });

    const spamNote2 = createSignedEvent(spammerPrivKey, {
      kind: 1,
      created_at: 1700000020,
      tags: [],
      content: 'Spam note 2',
    });

    const targetBlockedEvent = createSignedEvent(new Uint8Array(32).fill(30), {
      kind: 1,
      created_at: 1700000030,
      tags: [],
      content: 'Target blocked note',
    });

    mockDb.events.set(spamNote1.id, {
      id: spamNote1.id,
      pubkey: spamNote1.pubkey,
      created_at: spamNote1.created_at,
      kind: spamNote1.kind,
      d_tag: null,
      raw_event: JSON.stringify(spamNote1),
      created_at_recorded: 1700000010,
    });

    mockDb.events.set(spamNote2.id, {
      id: spamNote2.id,
      pubkey: spamNote2.pubkey,
      created_at: spamNote2.created_at,
      kind: spamNote2.kind,
      d_tag: null,
      raw_event: JSON.stringify(spamNote2),
      created_at_recorded: 1700000020,
    });

    mockDb.events.set(targetBlockedEvent.id, {
      id: targetBlockedEvent.id,
      pubkey: targetBlockedEvent.pubkey,
      created_at: targetBlockedEvent.created_at,
      kind: targetBlockedEvent.kind,
      d_tag: null,
      raw_event: JSON.stringify(targetBlockedEvent),
      created_at_recorded: 1700000030,
    });

    const ruleset = {
      blockedPubkeys: new Set([spammerPubkey]),
      blockedEventIds: new Set([targetBlockedEvent.id]),
      bannedWordsAndDomains: [],
      bannedHashtags: new Set<string>(),
    };

    const result = await purgeModeratedEntities(
      mockDb as unknown as D1Database,
      undefined,
      mockVector as unknown as VectorizeIndex,
      ruleset
    );

    expect(result.purgedCount).toBeGreaterThanOrEqual(2);
    expect(mockVector.deletedIds).toContain(targetBlockedEvent.id);
  });
});
