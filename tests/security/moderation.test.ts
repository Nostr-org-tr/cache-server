import { describe, expect, it } from 'vitest';
import {
  createEmptyModerationRuleset,
  extractModerationRulesFromEvents,
  hasNip32SensitiveLabel,
  hasNip36ContentWarning,
  inspectEventModeration,
  inspectEventStoragePolicy,
  isChunkOrPacketProtocol,
  isEncryptedPayloadInPublicKind,
  isRawBinaryOrAppBlob,
  isRecordableEvent,
} from '../../src/security/moderation';
import type { NostrEvent } from '../../src/types/nostr';

describe('Moderation Engine - NIP-36 Content Warning', () => {
  const baseEvent: NostrEvent = {
    id: '1111111111111111111111111111111111111111111111111111111111111111',
    pubkey: '2222222222222222222222222222222222222222222222222222222222222222',
    created_at: 1700000000,
    kind: 1,
    tags: [],
    content: 'Hello Nostr world!',
    sig: '33333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333',
  };

  it('detects NIP-36 content-warning tags correctly', () => {
    const cleanEvent: NostrEvent = { ...baseEvent, tags: [['e', 'someid'], ['p', 'somepub']] };
    expect(hasNip36ContentWarning(cleanEvent)).toBe(false);

    const flaggedEvent1: NostrEvent = { ...baseEvent, tags: [['content-warning']] };
    expect(hasNip36ContentWarning(flaggedEvent1)).toBe(true);

    const flaggedEvent2: NostrEvent = { ...baseEvent, tags: [['content-warning', 'nsfw graphic']] };
    expect(hasNip36ContentWarning(flaggedEvent2)).toBe(true);

    const result = inspectEventModeration(flaggedEvent2);
    expect(result.allowed).toBe(false);
    expect(result.isSensitive).toBe(true);
    expect(result.flagType).toBe('nip36');
  });

  it('detects NIP-32 adult/nsfw labels correctly', () => {
    const cleanEvent: NostrEvent = { ...baseEvent, tags: [['l', 'technology', 'topic']] };
    expect(hasNip32SensitiveLabel(cleanEvent)).toBe(false);

    const adultEvent: NostrEvent = { ...baseEvent, tags: [['l', 'adult', 'moderation']] };
    expect(hasNip32SensitiveLabel(adultEvent)).toBe(true);

    const pornEvent: NostrEvent = { ...baseEvent, tags: [['l', 'porn', 'ISO-3166-1']] };
    expect(hasNip32SensitiveLabel(pornEvent)).toBe(true);

    const nsfwEvent: NostrEvent = { ...baseEvent, tags: [['L', 'nsfw']] };
    expect(hasNip32SensitiveLabel(nsfwEvent)).toBe(true);

    const result = inspectEventModeration(adultEvent);
    expect(result.allowed).toBe(false);
    expect(result.isSensitive).toBe(true);
    expect(result.flagType).toBe('nip32');
  });

  it('handles empty or malformed tags gracefully without crashing', () => {
    const emptyTagsEvent: NostrEvent = { ...baseEvent, tags: [] };
    expect(hasNip36ContentWarning(emptyTagsEvent)).toBe(false);
    expect(hasNip32SensitiveLabel(emptyTagsEvent)).toBe(false);
    expect(inspectEventModeration(emptyTagsEvent).allowed).toBe(true);

    const malformedEvent = {
      ...baseEvent,
      tags: [[] as unknown as string[], ['a'], [null as unknown as string]],
    };
    expect(hasNip36ContentWarning(malformedEvent as unknown as NostrEvent)).toBe(false);
  });
});

describe('Moderation Engine - Operator NIP-51 & NIP-56 Ruleset', () => {
  const operatorPubkey = '46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a';
  const maliciousPubkey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const maliciousEventId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  it('extracts blocked pubkeys, event IDs, words, and hashtags from kind 10000 and kind 1984', () => {
    const operatorMuteEvent: NostrEvent = {
      id: 'mute1',
      pubkey: operatorPubkey,
      created_at: 1700000100,
      kind: 10000,
      tags: [
        ['p', maliciousPubkey],
        ['e', maliciousEventId],
        ['word', 'illegaldomain.com'],
        ['word', 'badword'],
        ['t', 'prohibitedtag'],
        ['t', '#anothertag'],
      ],
      content: '',
      sig: 'sig1',
    };

    const operatorReportEvent: NostrEvent = {
      id: 'report1',
      pubkey: operatorPubkey,
      created_at: 1700000200,
      kind: 1984,
      tags: [
        ['p', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'nudity'],
        ['e', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'illegal'],
      ],
      content: 'Reporting illegal content',
      sig: 'sig2',
    };

    const unauthorizedEvent: NostrEvent = {
      id: 'unauth1',
      pubkey: '9999999999999999999999999999999999999999999999999999999999999999',
      created_at: 1700000300,
      kind: 10000,
      tags: [['p', 'shouldnotbeincluded']],
      content: '',
      sig: 'sig3',
    };

    const ruleset = extractModerationRulesFromEvents(
      [operatorMuteEvent, operatorReportEvent, unauthorizedEvent],
      operatorPubkey
    );

    expect(ruleset.blockedPubkeys.has(maliciousPubkey)).toBe(true);
    expect(ruleset.blockedPubkeys.has('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')).toBe(true);
    expect(ruleset.blockedPubkeys.has('shouldnotbeincluded')).toBe(false);

    expect(ruleset.blockedEventIds.has(maliciousEventId)).toBe(true);
    expect(ruleset.blockedEventIds.has('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')).toBe(true);

    expect(ruleset.bannedWordsAndDomains).toContain('illegaldomain.com');
    expect(ruleset.bannedWordsAndDomains).toContain('badword');
    expect(ruleset.bannedHashtags.has('prohibitedtag')).toBe(true);
    expect(ruleset.bannedHashtags.has('anothertag')).toBe(true);
  });

  it('blocks events authored by muted pubkeys', () => {
    const ruleset = {
      ...createEmptyModerationRuleset(),
      blockedPubkeys: new Set([maliciousPubkey]),
    };

    const event: NostrEvent = {
      id: 'event1',
      pubkey: maliciousPubkey,
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: 'Harmless text',
      sig: 'sig',
    };

    const result = inspectEventModeration(event, ruleset);
    expect(result.allowed).toBe(false);
    expect(result.flagType).toBe('banned_pubkey');
  });

  it('blocks specific muted event IDs', () => {
    const ruleset = {
      ...createEmptyModerationRuleset(),
      blockedEventIds: new Set([maliciousEventId]),
    };

    const event: NostrEvent = {
      id: maliciousEventId,
      pubkey: 'cleanpubkey',
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: 'Harmless text',
      sig: 'sig',
    };

    const result = inspectEventModeration(event, ruleset);
    expect(result.allowed).toBe(false);
    expect(result.flagType).toBe('banned_event');
  });

  it('blocks events containing prohibited hashtags', () => {
    const ruleset = {
      ...createEmptyModerationRuleset(),
      bannedHashtags: new Set(['prohibitedtag']),
    };

    const event: NostrEvent = {
      id: 'event1',
      pubkey: 'cleanpubkey',
      created_at: 1700000000,
      kind: 1,
      tags: [['t', 'ProhibitedTag']],
      content: 'Check this out',
      sig: 'sig',
    };

    const result = inspectEventModeration(event, ruleset);
    expect(result.allowed).toBe(false);
    expect(result.flagType).toBe('banned_hashtag');
  });

  it('blocks events containing banned keywords or domain patterns in content and tags', () => {
    const ruleset = {
      ...createEmptyModerationRuleset(),
      bannedWordsAndDomains: ['badmediahost.xyz'],
    };

    const eventWithBannedContent: NostrEvent = {
      id: 'event1',
      pubkey: 'cleanpubkey',
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: 'Look at https://badmediahost.xyz/photo.jpg here',
      sig: 'sig',
    };

    const result1 = inspectEventModeration(eventWithBannedContent, ruleset);
    expect(result1.allowed).toBe(false);
    expect(result1.flagType).toBe('banned_content');

    const eventWithBannedTag: NostrEvent = {
      id: 'event2',
      pubkey: 'cleanpubkey',
      created_at: 1700000000,
      kind: 1,
      tags: [['r', 'https://badmediahost.xyz/video.mp4']],
      content: 'Video attachment',
      sig: 'sig',
    };

    const result2 = inspectEventModeration(eventWithBannedTag, ruleset);
    expect(result2.allowed).toBe(false);
    expect(result2.flagType).toBe('banned_content');
  });

  it('allows completely clean events', () => {
    const ruleset = {
      blockedPubkeys: new Set([maliciousPubkey]),
      blockedEventIds: new Set([maliciousEventId]),
      bannedWordsAndDomains: ['badword'],
      bannedHashtags: new Set(['badtag']),
    };

    const cleanEvent: NostrEvent = {
      id: 'cleaneventid',
      pubkey: 'cleanpubkey',
      created_at: 1700000000,
      kind: 1,
      tags: [['t', 'nostr'], ['p', 'friendpubkey']],
      content: 'This is a high-quality, clean Nostr note on cache.nostr.org.tr',
      sig: 'sig',
    };

    const result = inspectEventModeration(cleanEvent, ruleset);
    expect(result.allowed).toBe(true);
    expect(result.isSensitive).toBe(false);
  });
});

describe('Storage Policy - Chunk Protocols, Encrypted Notes & Binary Dumps', () => {
  const userSampleHppEvent: NostrEvent = {
    id: '4e290efb60b6ab14d048c40dc3ebc16dddc643e2f544c077d2fe7c4f43cf969d',
    pubkey: '92fd8c2ebfb14744c5759f4b20a3acf938b06fac0c08ce9f7ff0df7a8d49a76e',
    created_at: 1790300798,
    kind: 1,
    tags: [
      ['t', 'hpp'],
      ['t', 'hpp-seed-v1'],
      ['x', 'c468e5f4f7e0adccd82911d091f370452554bb967ab0f57d9aa225bf72e16163'],
      ['i', '52'],
      ['n', '53'],
    ],
    content:
      '{"protocol":"HPP_SEED/1","sha256":"c468e5f4f7e0adccd82911d091f370452554bb967ab0f57d9aa225bf72e16163","encoding":"base64","chunk_index":52,"chunk_count":53,"data":"QoPP9+1JmXMT..."}',
    sig: 'b1cd71c65f8f6721111e337a72c5610d5015713197d0b1a3a50194d69fdf89f00e3dc9f49fd9612390d69948a50a291d210f1d35794aa111456aadf1c4897c45',
  };

  it('correctly flags the user-provided HPP event as unrecordable', () => {
    expect(isChunkOrPacketProtocol(userSampleHppEvent)).toBe(true);
    expect(isRecordableEvent(userSampleHppEvent)).toBe(false);

    const policy = inspectEventStoragePolicy(userSampleHppEvent);
    expect(policy.recordable).toBe(false);
    expect(policy.classification).toBe('chunk_file_protocol');
  });

  it('flags tag-based HPP variations as unrecordable chunk protocols', () => {
    const hppEvent1: NostrEvent = {
      id: 'e1',
      pubkey: 'p1',
      created_at: 1700000000,
      kind: 1,
      tags: [['t', 'hpp']],
      content: 'chunk 1',
      sig: 's1',
    };
    expect(isChunkOrPacketProtocol(hppEvent1)).toBe(true);
    expect(isRecordableEvent(hppEvent1)).toBe(false);

    const hppEvent2: NostrEvent = {
      id: 'e2',
      pubkey: 'p1',
      created_at: 1700000000,
      kind: 1,
      tags: [['t', 'hpp-seed']],
      content: 'chunk 2',
      sig: 's2',
    };
    expect(isChunkOrPacketProtocol(hppEvent2)).toBe(true);

    const hppEvent3: NostrEvent = {
      id: 'e3',
      pubkey: 'p1',
      created_at: 1700000000,
      kind: 1,
      tags: [['t', 'seed-v1'], ['i', '1'], ['n', '10']],
      content: 'binary piece',
      sig: 's3',
    };
    expect(isChunkOrPacketProtocol(hppEvent3)).toBe(true);
  });

  it('flags chunk index and count tag combinations as chunk protocols', () => {
    const chunkTagEvent: NostrEvent = {
      id: 'e4',
      pubkey: 'p1',
      created_at: 1700000000,
      kind: 1,
      tags: [
        ['x', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
        ['i', '3'],
        ['n', '25'],
      ],
      content: 'some payload',
      sig: 's4',
    };
    expect(isChunkOrPacketProtocol(chunkTagEvent)).toBe(true);
    expect(isRecordableEvent(chunkTagEvent)).toBe(false);
  });

  it('flags content-based JSON packet protocols as unrecordable', () => {
    const jsonProtocolEvent: NostrEvent = {
      id: 'e5',
      pubkey: 'p1',
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: JSON.stringify({
        protocol: 'NOSTR_CHUNK/1.0',
        chunk_index: 0,
        chunk_count: 5,
        data: 'VGhpcyBpcyBhIGZpbGUgY2h1bms=',
      }),
      sig: 's5',
    };
    expect(isChunkOrPacketProtocol(jsonProtocolEvent)).toBe(true);
    expect(isRecordableEvent(jsonProtocolEvent)).toBe(false);
  });

  it('detects encrypted ciphertext payloads in public text kinds (Kind 1)', () => {
    const nip04InKind1: NostrEvent = {
      id: 'e6',
      pubkey: 'p1',
      created_at: 1700000000,
      kind: 1,
      tags: [['p', 'recipientpubkey']],
      content:
        'SGVsbG8gV29ybGQgdGhpcyBpcyBhIHNlY3JldA==?iv=MDEyMzQ1Njc4OWFiY2RlZg==',
      sig: 's6',
    };
    expect(isEncryptedPayloadInPublicKind(nip04InKind1)).toBe(true);
    expect(isRecordableEvent(nip04InKind1)).toBe(false);

    const policy = inspectEventStoragePolicy(nip04InKind1);
    expect(policy.classification).toBe('encrypted_public_kind');

    // Kind 4 (NIP-04 DM) is allowed as an encrypted kind
    const validKind4Dm: NostrEvent = {
      ...nip04InKind1,
      kind: 4,
    };
    expect(isEncryptedPayloadInPublicKind(validKind4Dm)).toBe(false);
    expect(isRecordableEvent(validKind4Dm)).toBe(true);
  });

  it('detects raw monolithic base64 or hex dumps in Kind 1', () => {
    const monolithicBase64 = 'A'.repeat(400);
    const base64Event: NostrEvent = {
      id: 'e7',
      pubkey: 'p1',
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: monolithicBase64,
      sig: 's7',
    };
    expect(isRawBinaryOrAppBlob(base64Event)).toBe(true);
    expect(isRecordableEvent(base64Event)).toBe(false);

    const monolithicHex = 'deadbeef0123456789abcdef'.repeat(15);
    const hexEvent: NostrEvent = {
      id: 'e8',
      pubkey: 'p1',
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: monolithicHex,
      sig: 's8',
    };
    expect(isRawBinaryOrAppBlob(hexEvent)).toBe(true);
    expect(isRecordableEvent(hexEvent)).toBe(false);
  });

  it('allows standard social notes and metadata events to be recorded', () => {
    const standardNote: NostrEvent = {
      id: 'e9',
      pubkey: 'p1',
      created_at: 1700000000,
      kind: 1,
      tags: [['t', 'bitcoin'], ['p', 'friendpubkey']],
      content:
        'Excited about building high-performance decentralized systems on Nostr! Check out https://cache.nostr.org.tr',
      sig: 's9',
    };
    expect(isRecordableEvent(standardNote)).toBe(true);

    const userProfile: NostrEvent = {
      id: 'e10',
      pubkey: 'p1',
      created_at: 1700000000,
      kind: 0,
      tags: [],
      content: JSON.stringify({
        name: 'alice',
        about: 'Nostr builder & researcher',
        picture: 'https://example.com/alice.png',
      }),
      sig: 's10',
    };
    expect(isRecordableEvent(userProfile)).toBe(true);
  });
});
