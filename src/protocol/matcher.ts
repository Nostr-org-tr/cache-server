import type { NostrEvent, NostrFilter } from '../types/nostr';

/**
 * Checks if a Nostr event matches a single NIP-01 filter.
 *
 * All specified conditions in the filter must be satisfied (AND condition).
 */
export function matchFilter(filter: NostrFilter, event: NostrEvent): boolean {
  // 1. Check event ID / ID prefix matching
  if (filter.ids && filter.ids.length > 0) {
    const eventIdLower = event.id.toLowerCase();
    const matched = filter.ids.some((idPrefix) =>
      eventIdLower.startsWith(idPrefix.toLowerCase())
    );
    if (!matched) {
      return false;
    }
  }

  // 2. Check author / author pubkey prefix matching
  if (filter.authors && filter.authors.length > 0) {
    const pubkeyLower = event.pubkey.toLowerCase();
    const matched = filter.authors.some((authorPrefix) =>
      pubkeyLower.startsWith(authorPrefix.toLowerCase())
    );
    if (!matched) {
      return false;
    }
  }

  // 3. Check kind matching
  if (filter.kinds && filter.kinds.length > 0) {
    if (!filter.kinds.includes(event.kind)) {
      return false;
    }
  }

  // 4. Check time boundaries: since
  if (filter.since !== undefined) {
    if (event.created_at < filter.since) {
      return false;
    }
  }

  // 5. Check time boundaries: until
  if (filter.until !== undefined) {
    if (event.created_at > filter.until) {
      return false;
    }
  }

  // 6. Check generic and single-letter tag filters: `#e`, `#p`, `#d`, `#t`, etc.
  for (const [key, filterValues] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(filterValues) && filterValues.length > 0) {
      const tagName = key.slice(1);
      const valuesSet = new Set(filterValues);

      const hasMatchingTag = event.tags.some(
        (tag) => tag.length >= 2 && tag[0] === tagName && valuesSet.has(tag[1])
      );

      if (!hasMatchingTag) {
        return false;
      }
    }
  }

  // 7. Check NIP-50 search field matching for live events
  if (filter.search && filter.search.trim().length > 0) {
    const rawContent = (event.content || '').toLowerCase();
    const query = filter.search.toLowerCase();
    const searchTerms = query.split(/\s+/).filter((t) => t.length > 0 && !t.includes(':'));
    
    // All clean text search terms should match the live event content
    for (const term of searchTerms) {
      if (!rawContent.includes(term)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Checks if a Nostr event matches any of the given NIP-01 filters.
 *
 * An event matches if at least one filter in the array is satisfied (OR condition).
 */
export function matchFilters(filters: NostrFilter[], event: NostrEvent): boolean {
  if (filters.length === 0) {
    return false;
  }

  return filters.some((filter) => matchFilter(filter, event));
}
