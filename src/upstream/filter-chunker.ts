import type { NostrFilter } from '../types/nostr';

export interface FilterChunkLimits {
  /** Maximum number of authors per sub-filter (default: 30) */
  maxAuthors?: number;
  /** Maximum number of kinds per sub-filter (default: 10) */
  maxKinds?: number;
  /** Maximum number of IDs per sub-filter (default: 30) */
  maxIds?: number;
  /** Maximum number of tag values per tag query in a sub-filter (default: 30) */
  maxTags?: number;
  /** Maximum total generated sub-filters per filter (default: 50) */
  maxSubFilters?: number;
}

export const DEFAULT_FILTER_CHUNK_LIMITS: Required<FilterChunkLimits> = {
  maxAuthors: 30,
  maxKinds: 10,
  maxIds: 30,
  maxTags: 30,
  maxSubFilters: 50,
};

/**
 * Splits an array into chunks of a given maximum size.
 */
function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (items.length === 0 || chunkSize <= 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Decomposes a single NIP-01 filter into one or more compliant sub-filters
 * that do not exceed upstream relay capacity limits (authors, kinds, IDs, tags).
 */
export function decomposeFilterForUpstream(
  filter: NostrFilter,
  customLimits?: FilterChunkLimits
): NostrFilter[] {
  const limits: Required<FilterChunkLimits> = {
    ...DEFAULT_FILTER_CHUNK_LIMITS,
    ...customLimits,
  };

  const hasLargeAuthors = Boolean(filter.authors && filter.authors.length > limits.maxAuthors);
  const hasLargeKinds = Boolean(filter.kinds && filter.kinds.length > limits.maxKinds);
  const hasLargeIds = Boolean(filter.ids && filter.ids.length > limits.maxIds);

  // Check for large tag arrays
  let hasLargeTags = false;
  for (const [key, val] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(val) && val.length > limits.maxTags) {
      hasLargeTags = true;
      break;
    }
  }

  // Fast path: No chunking needed
  if (!hasLargeAuthors && !hasLargeKinds && !hasLargeIds && !hasLargeTags) {
    return [{ ...filter }];
  }

  // Extract base filter scalar fields
  const baseScalars: Partial<NostrFilter> = {};
  if (filter.since !== undefined) baseScalars.since = filter.since;
  if (filter.until !== undefined) baseScalars.until = filter.until;
  if (filter.limit !== undefined) baseScalars.limit = filter.limit;
  if (filter.search !== undefined) baseScalars.search = filter.search;

  // Extract tag queries
  const normalTags: Record<string, string[]> = {};
  const chunkedTags: Record<string, string[][]> = {};

  for (const [key, val] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(val)) {
      if (val.length > limits.maxTags) {
        chunkedTags[key] = chunkArray(val, limits.maxTags);
      } else {
        normalTags[key] = [...val];
      }
    }
  }

  // 1. Chunk IDs if present
  const idChunks = filter.ids && filter.ids.length > 0
    ? chunkArray(filter.ids, limits.maxIds)
    : null;

  // 2. Chunk Authors if present
  const authorChunks = filter.authors && filter.authors.length > 0
    ? chunkArray(filter.authors, limits.maxAuthors)
    : null;

  // 3. Chunk Kinds if present
  const kindChunks = filter.kinds && filter.kinds.length > 0
    ? chunkArray(filter.kinds, limits.maxKinds)
    : null;

  const resultFilters: NostrFilter[] = [];

  // If IDs are the primary selector
  if (idChunks && idChunks.length > 0) {
    for (const idChunk of idChunks) {
      const subFilter: NostrFilter = {
        ...baseScalars,
        ...normalTags,
        ids: idChunk,
      };
      if (filter.authors) subFilter.authors = [...filter.authors];
      if (filter.kinds) subFilter.kinds = [...filter.kinds];
      resultFilters.push(subFilter);
      if (resultFilters.length >= limits.maxSubFilters) break;
    }
    return resultFilters;
  }

  // Cross-product of Authors and Kinds
  const aList = authorChunks && authorChunks.length > 0 ? authorChunks : [filter.authors];
  const kList = kindChunks && kindChunks.length > 0 ? kindChunks : [filter.kinds];

  for (const aChunk of aList) {
    for (const kChunk of kList) {
      const subFilter: NostrFilter = {
        ...baseScalars,
        ...normalTags,
      };
      if (aChunk !== undefined) subFilter.authors = aChunk;
      if (kChunk !== undefined) subFilter.kinds = kChunk;

      // If there are chunked tags, apply first chunk or distribute
      const tagEntries = Object.entries(chunkedTags);
      if (tagEntries.length === 0) {
        resultFilters.push(subFilter);
      } else {
        // Distribute tag chunks
        for (const [tagKey, tagChunksList] of tagEntries) {
          for (const tChunk of tagChunksList) {
            resultFilters.push({
              ...subFilter,
              [tagKey]: tChunk,
            });
            if (resultFilters.length >= limits.maxSubFilters) break;
          }
          if (resultFilters.length >= limits.maxSubFilters) break;
        }
      }

      if (resultFilters.length >= limits.maxSubFilters) break;
    }
    if (resultFilters.length >= limits.maxSubFilters) break;
  }

  return resultFilters.length > 0 ? resultFilters : [{ ...filter }];
}

/**
 * Decomposes an array of NIP-01 filters into compliant sub-filters for upstream querying.
 */
export function decomposeFiltersForUpstream(
  filters: NostrFilter[],
  customLimits?: FilterChunkLimits
): NostrFilter[] {
  const decomposed: NostrFilter[] = [];
  for (const filter of filters) {
    const subFilters = decomposeFilterForUpstream(filter, customLimits);
    decomposed.push(...subFilters);
  }
  return decomposed;
}
