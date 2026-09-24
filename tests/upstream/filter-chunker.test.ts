import { describe, expect, it } from 'vitest';
import {
  decomposeFilterForUpstream,
  decomposeFiltersForUpstream,
  DEFAULT_FILTER_CHUNK_LIMITS,
} from '../../src/upstream/filter-chunker';
import type { NostrFilter } from '../../src/types/nostr';

describe('Filter Chunker (decomposeFilterForUpstream)', () => {
  it('returns unchanged single filter when within limits', () => {
    const filter: NostrFilter = {
      kinds: [1, 6],
      authors: ['a'.repeat(64), 'b'.repeat(64)],
      since: 1000,
      limit: 20,
    };

    const decomposed = decomposeFilterForUpstream(filter);
    expect(decomposed).toHaveLength(1);
    expect(decomposed[0]).toEqual(filter);
  });

  it('decomposes 114 authors into chunks of <= 30 authors', () => {
    const authors = Array.from({ length: 114 }, (_, i) => i.toString(16).padStart(64, '0'));
    const filter: NostrFilter = {
      kinds: [1],
      authors,
      since: 1700000000,
      limit: 50,
    };

    const decomposed = decomposeFilterForUpstream(filter);
    // 114 authors with max 30 per chunk: 30 + 30 + 30 + 24 = 4 chunks
    expect(decomposed).toHaveLength(4);

    expect(decomposed[0]!.authors).toHaveLength(30);
    expect(decomposed[1]!.authors).toHaveLength(30);
    expect(decomposed[2]!.authors).toHaveLength(30);
    expect(decomposed[3]!.authors).toHaveLength(24);

    // Verify all chunks preserve kinds, since, limit
    for (const subFilter of decomposed) {
      expect(subFilter.kinds).toEqual([1]);
      expect(subFilter.since).toBe(1700000000);
      expect(subFilter.limit).toBe(50);
    }

    // Verify all 114 authors are covered without loss or duplicate
    const allAuthors = decomposed.flatMap((f) => f.authors ?? []);
    expect(allAuthors).toEqual(authors);
  });

  it('decomposes 65 kinds into chunks of <= 10 kinds', () => {
    const kinds = Array.from({ length: 65 }, (_, i) => i);
    const filter: NostrFilter = {
      kinds,
      limit: 100,
    };

    const decomposed = decomposeFilterForUpstream(filter);
    // 65 kinds with max 10 per chunk: 10*6 + 5 = 7 chunks
    expect(decomposed).toHaveLength(7);

    for (let i = 0; i < 6; i++) {
      expect(decomposed[i]!.kinds).toHaveLength(10);
    }
    expect(decomposed[6]!.kinds).toHaveLength(5);

    const allKinds = decomposed.flatMap((f) => f.kinds ?? []);
    expect(allKinds).toEqual(kinds);
  });

  it('decomposes user feed payload (114 authors + 65 kinds + since + limit: 0)', () => {
    const authors = Array.from({ length: 114 }, (_, i) => i.toString(16).padStart(64, '0'));
    const kinds = Array.from({ length: 65 }, (_, i) => i);
    const filter: NostrFilter = {
      authors,
      kinds,
      since: 1790212611,
      limit: 0,
    };

    const decomposed = decomposeFilterForUpstream(filter);
    // 4 author chunks x 7 kind chunks = 28 sub-filters
    expect(decomposed).toHaveLength(28);

    for (const sub of decomposed) {
      expect(sub.authors!.length).toBeLessThanOrEqual(DEFAULT_FILTER_CHUNK_LIMITS.maxAuthors);
      expect(sub.kinds!.length).toBeLessThanOrEqual(DEFAULT_FILTER_CHUNK_LIMITS.maxKinds);
      expect(sub.since).toBe(1790212611);
      expect(sub.limit).toBe(0);
    }
  });

  it('decomposes large IDs array into chunks of <= 30 IDs', () => {
    const ids = Array.from({ length: 95 }, (_, i) => i.toString(16).padStart(64, 'f'));
    const filter: NostrFilter = {
      ids,
    };

    const decomposed = decomposeFilterForUpstream(filter);
    // 95 IDs with max 30 per chunk: 30 + 30 + 30 + 5 = 4 chunks
    expect(decomposed).toHaveLength(4);
    expect(decomposed[0]!.ids).toHaveLength(30);
    expect(decomposed[3]!.ids).toHaveLength(5);
  });

  it('decomposes large tag filter arrays into sub-filters', () => {
    const tagValues = Array.from({ length: 75 }, (_, i) => `tag_${i}`);
    const filter: NostrFilter = {
      kinds: [1],
      '#e': tagValues,
    };

    const decomposed = decomposeFilterForUpstream(filter);
    // 75 tag values with max 30 per chunk: 3 chunks
    expect(decomposed).toHaveLength(3);
    expect(decomposed[0]!['#e']).toHaveLength(30);
    expect(decomposed[1]!['#e']).toHaveLength(30);
    expect(decomposed[2]!['#e']).toHaveLength(15);
  });

  it('handles decomposeFiltersForUpstream with multiple filters', () => {
    const authors = Array.from({ length: 60 }, (_, i) => i.toString(16).padStart(64, '0'));
    const filter1: NostrFilter = { kinds: [0], authors };
    const filter2: NostrFilter = { kinds: [1], limit: 10 };

    const decomposed = decomposeFiltersForUpstream([filter1, filter2]);
    // filter1 -> 2 sub-filters (30 + 30), filter2 -> 1 sub-filter
    expect(decomposed).toHaveLength(3);
  });
});
