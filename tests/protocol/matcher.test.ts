import { describe, it, expect } from 'vitest';
import { matchFilter, matchFilters } from '../../src/protocol/matcher';
import type { NostrEvent, NostrFilter } from '../../src/types/nostr';

describe('In-Memory NIP-01 Filter Match Engine', () => {
  const sampleEvent: NostrEvent = {
    id: 'a1b2c3d4e5f6'.padEnd(64, '0'),
    pubkey: 'f6e5d4c3b2a1'.padEnd(64, '0'),
    created_at: 1700000500,
    kind: 1,
    tags: [
      ['e', 'e1e2e3e4e5e6'.padEnd(64, '0')],
      ['p', 'p1p2p3p4p5p6'.padEnd(64, '0')],
      ['d', 'article-slug-1'],
      ['t', 'bitcoin'],
      ['t', 'nostr'],
    ],
    content: 'Testing filter match engine in TypeScript',
    sig: '0'.repeat(128),
  };

  it('matches event by exact ID and ID prefix', () => {
    // Exact ID
    expect(matchFilter({ ids: [sampleEvent.id] }, sampleEvent)).toBe(true);

    // Prefix ID
    expect(matchFilter({ ids: ['a1b2c3'] }, sampleEvent)).toBe(true);

    // Case insensitive prefix
    expect(matchFilter({ ids: ['A1B2C3'] }, sampleEvent)).toBe(true);

    // Non-matching ID
    expect(matchFilter({ ids: ['ffffffff'] }, sampleEvent)).toBe(false);
  });

  it('matches event by exact pubkey and author prefix', () => {
    // Exact pubkey
    expect(matchFilter({ authors: [sampleEvent.pubkey] }, sampleEvent)).toBe(true);

    // Prefix pubkey
    expect(matchFilter({ authors: ['f6e5'] }, sampleEvent)).toBe(true);

    // Non-matching author
    expect(matchFilter({ authors: ['0000'] }, sampleEvent)).toBe(false);
  });

  it('matches event by kind', () => {
    expect(matchFilter({ kinds: [1, 0, 3] }, sampleEvent)).toBe(true);
    expect(matchFilter({ kinds: [0, 3, 7] }, sampleEvent)).toBe(false);
  });

  it('matches event by time boundaries (since / until)', () => {
    // Inside range
    expect(matchFilter({ since: 1700000000, until: 1700001000 }, sampleEvent)).toBe(true);

    // Exact boundary
    expect(matchFilter({ since: 1700000500 }, sampleEvent)).toBe(true);
    expect(matchFilter({ until: 1700000500 }, sampleEvent)).toBe(true);

    // Outside range
    expect(matchFilter({ since: 1700000600 }, sampleEvent)).toBe(false);
    expect(matchFilter({ until: 1700000400 }, sampleEvent)).toBe(false);
  });

  it('matches event by single and multi-value tag queries', () => {
    // Single letter tags
    expect(matchFilter({ '#e': ['e1e2e3e4e5e6'.padEnd(64, '0')] }, sampleEvent)).toBe(true);
    expect(matchFilter({ '#p': ['p1p2p3p4p5p6'.padEnd(64, '0')] }, sampleEvent)).toBe(true);
    expect(matchFilter({ '#d': ['article-slug-1'] }, sampleEvent)).toBe(true);
    expect(matchFilter({ '#t': ['bitcoin', 'lightning'] }, sampleEvent)).toBe(true);

    // Non-matching tag value
    expect(matchFilter({ '#t': ['ethereum'] }, sampleEvent)).toBe(false);

    // Non-matching tag name
    expect(matchFilter({ '#q': ['some-quote-id'] }, sampleEvent)).toBe(false);
  });

  it('requires all criteria in a single filter to match (AND semantics)', () => {
    // Matching kind AND matching author AND matching tag
    expect(
      matchFilter(
        {
          kinds: [1],
          authors: ['f6e5'],
          '#t': ['bitcoin'],
        },
        sampleEvent
      )
    ).toBe(true);

    // Matching kind but NON-matching tag
    expect(
      matchFilter(
        {
          kinds: [1],
          '#t': ['ethereum'],
        },
        sampleEvent
      )
    ).toBe(false);
  });

  it('matches across multiple filters using OR semantics (matchFilters)', () => {
    const filters: NostrFilter[] = [
      { kinds: [0] }, // does not match (sample is kind 1)
      { '#t': ['nostr'] }, // matches!
    ];

    expect(matchFilters(filters, sampleEvent)).toBe(true);

    const nonMatchingFilters: NostrFilter[] = [
      { kinds: [0] },
      { authors: ['00000000'] },
    ];

    expect(matchFilters(nonMatchingFilters, sampleEvent)).toBe(false);
    expect(matchFilters([], sampleEvent)).toBe(false);
  });
});
