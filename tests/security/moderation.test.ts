import { describe, expect, it } from 'vitest';
import {
  createEmptyModerationRuleset,
  extractModerationRulesFromEvents,
  hasNip32SensitiveLabel,
  hasNip36ContentWarning,
  inspectEventModeration,
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
