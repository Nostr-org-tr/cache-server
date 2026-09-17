import type { NostrEvent, NostrFilter } from '../types/nostr';
import type { EventFilterQueryOptions, ParameterizedQuery } from './types';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 500;

/**
 * Compiles a NIP-01 subscription filter into a fully parameterized SQLite query.
 *
 * Guarantees zero raw string interpolation of user-supplied data to prevent SQL injection.
 */
export function compileFilterToSql(
  filter: NostrFilter,
  options?: EventFilterQueryOptions
): ParameterizedQuery {
  const whereClauses: string[] = [];
  const params: (string | number)[] = [];

  // 1. Compile 'ids' filter (supports exact 64-char IDs and hex prefixes)
  if (filter.ids && filter.ids.length > 0) {
    const exactIds: string[] = [];
    const prefixIds: string[] = [];

    for (const id of filter.ids) {
      if (id.length === 64) {
        exactIds.push(id.toLowerCase());
      } else if (id.length > 0) {
        prefixIds.push(id.toLowerCase());
      }
    }

    const idConditions: string[] = [];

    if (exactIds.length > 0) {
      const placeholders = exactIds.map(() => '?').join(', ');
      idConditions.push(`id IN (${placeholders})`);
      params.push(...exactIds);
    }

    for (const prefix of prefixIds) {
      idConditions.push(`id LIKE ?`);
      params.push(`${prefix}%`);
    }

    if (idConditions.length === 1) {
      whereClauses.push(idConditions[0] ?? '');
    } else if (idConditions.length > 1) {
      whereClauses.push(`(${idConditions.join(' OR ')})`);
    }
  }

  // 2. Compile 'authors' filter (supports exact 64-char pubkeys and hex prefixes)
  if (filter.authors && filter.authors.length > 0) {
    const exactAuthors: string[] = [];
    const prefixAuthors: string[] = [];

    for (const author of filter.authors) {
      if (author.length === 64) {
        exactAuthors.push(author.toLowerCase());
      } else if (author.length > 0) {
        prefixAuthors.push(author.toLowerCase());
      }
    }

    const authorConditions: string[] = [];

    if (exactAuthors.length > 0) {
      const placeholders = exactAuthors.map(() => '?').join(', ');
      authorConditions.push(`pubkey IN (${placeholders})`);
      params.push(...exactAuthors);
    }

    for (const prefix of prefixAuthors) {
      authorConditions.push(`pubkey LIKE ?`);
      params.push(`${prefix}%`);
    }

    if (authorConditions.length === 1) {
      whereClauses.push(authorConditions[0] ?? '');
    } else if (authorConditions.length > 1) {
      whereClauses.push(`(${authorConditions.join(' OR ')})`);
    }
  }

  // 3. Compile 'kinds' filter
  if (filter.kinds && filter.kinds.length > 0) {
    const placeholders = filter.kinds.map(() => '?').join(', ');
    whereClauses.push(`kind IN (${placeholders})`);
    params.push(...filter.kinds);
  }

  // 4. Compile 'since' boundary
  if (filter.since !== undefined) {
    whereClauses.push(`created_at >= ?`);
    params.push(filter.since);
  }

  // 5. Compile 'until' boundary
  if (filter.until !== undefined) {
    whereClauses.push(`created_at <= ?`);
    params.push(filter.until);
  }

  // 6. Compile generic tag filters: e.g. #e, #p, #d, #t, #a
  for (const [key, filterValues] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(filterValues)) {
      const tagName = key.slice(1);
      if (tagName.length === 0) {
        continue;
      }

      if (filterValues.length === 0) {
        // An empty tag filter array matches nothing
        whereClauses.push('1 = 0');
        continue;
      }

      const placeholders = filterValues.map(() => '?').join(', ');
      whereClauses.push(
        `id IN (SELECT event_id FROM event_tags WHERE tag_name = ? AND tag_value IN (${placeholders}))`
      );
      params.push(tagName, ...filterValues);
    }
  }

  // Calculate limit
  const maxLimit = options?.maxLimit ?? MAX_LIMIT;
  const defaultLimit = options?.defaultLimit ?? DEFAULT_LIMIT;
  const requestedLimit = filter.limit !== undefined ? filter.limit : defaultLimit;
  const resolvedLimit = Math.max(1, Math.min(requestedLimit, maxLimit));

  params.push(resolvedLimit);

  let sql = 'SELECT id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded FROM events';
  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';

  return { sql, params };
}

/**
 * Compiles a NIP-01 filter into a parameterized COUNT(*) query for NIP-45 support.
 */
export function compileCountToSql(filter: NostrFilter): ParameterizedQuery {
  const whereClauses: string[] = [];
  const params: (string | number)[] = [];

  if (filter.ids && filter.ids.length > 0) {
    const exactIds: string[] = [];
    const prefixIds: string[] = [];

    for (const id of filter.ids) {
      if (id.length === 64) {
        exactIds.push(id.toLowerCase());
      } else if (id.length > 0) {
        prefixIds.push(id.toLowerCase());
      }
    }

    const idConditions: string[] = [];
    if (exactIds.length > 0) {
      const placeholders = exactIds.map(() => '?').join(', ');
      idConditions.push(`id IN (${placeholders})`);
      params.push(...exactIds);
    }
    for (const prefix of prefixIds) {
      idConditions.push(`id LIKE ?`);
      params.push(`${prefix}%`);
    }
    if (idConditions.length === 1) {
      whereClauses.push(idConditions[0] ?? '');
    } else if (idConditions.length > 1) {
      whereClauses.push(`(${idConditions.join(' OR ')})`);
    }
  }

  if (filter.authors && filter.authors.length > 0) {
    const exactAuthors: string[] = [];
    const prefixAuthors: string[] = [];

    for (const author of filter.authors) {
      if (author.length === 64) {
        exactAuthors.push(author.toLowerCase());
      } else if (author.length > 0) {
        prefixAuthors.push(author.toLowerCase());
      }
    }

    const authorConditions: string[] = [];
    if (exactAuthors.length > 0) {
      const placeholders = exactAuthors.map(() => '?').join(', ');
      authorConditions.push(`pubkey IN (${placeholders})`);
      params.push(...exactAuthors);
    }
    for (const prefix of prefixAuthors) {
      authorConditions.push(`pubkey LIKE ?`);
      params.push(`${prefix}%`);
    }
    if (authorConditions.length === 1) {
      whereClauses.push(authorConditions[0] ?? '');
    } else if (authorConditions.length > 1) {
      whereClauses.push(`(${authorConditions.join(' OR ')})`);
    }
  }

  if (filter.kinds && filter.kinds.length > 0) {
    const placeholders = filter.kinds.map(() => '?').join(', ');
    whereClauses.push(`kind IN (${placeholders})`);
    params.push(...filter.kinds);
  }

  if (filter.since !== undefined) {
    whereClauses.push(`created_at >= ?`);
    params.push(filter.since);
  }

  if (filter.until !== undefined) {
    whereClauses.push(`created_at <= ?`);
    params.push(filter.until);
  }

  for (const [key, filterValues] of Object.entries(filter)) {
    if (key.startsWith('#') && Array.isArray(filterValues)) {
      const tagName = key.slice(1);
      if (tagName.length === 0) {
        continue;
      }
      if (filterValues.length === 0) {
        whereClauses.push('1 = 0');
        continue;
      }
      const placeholders = filterValues.map(() => '?').join(', ');
      whereClauses.push(
        `id IN (SELECT event_id FROM event_tags WHERE tag_name = ? AND tag_value IN (${placeholders}))`
      );
      params.push(tagName, ...filterValues);
    }
  }

  let sql = 'SELECT COUNT(*) as count FROM events';
  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  return { sql, params };
}

/**
 * Compiles deletion queries for a NIP-09 Kind 5 deletion event.
 *
 * Strict security invariant: only deletes events where events.pubkey == deletionEvent.pubkey.
 */
export function compileDeletionQueries(deletionEvent: NostrEvent): ParameterizedQuery[] {
  const queries: ParameterizedQuery[] = [];
  const referencedIds: string[] = [];

  for (const tag of deletionEvent.tags) {
    if (!Array.isArray(tag) || tag.length < 2) {
      continue;
    }

    const tagName = tag[0];
    const tagVal = tag[1];

    if (tagName === 'e' && typeof tagVal === 'string' && tagVal.length > 0) {
      referencedIds.push(tagVal.toLowerCase());
    } else if (tagName === 'a' && typeof tagVal === 'string') {
      // Coordinate format: <kind>:<pubkey>:<d_tag>
      const parts = tagVal.split(':');
      if (parts.length >= 2 && parts[0] !== undefined && parts[1] !== undefined) {
        const targetKind = parseInt(parts[0], 10);
        const targetPubkey = parts[1].toLowerCase();
        const targetDTag = parts.slice(2).join(':'); // handles d_tag with colons

        if (!isNaN(targetKind) && targetPubkey === deletionEvent.pubkey.toLowerCase()) {
          queries.push({
            sql: 'DELETE FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ?',
            params: [targetPubkey, targetKind, targetDTag],
          });
        }
      }
    }
  }

  if (referencedIds.length > 0) {
    const placeholders = referencedIds.map(() => '?').join(', ');
    queries.push({
      sql: `DELETE FROM events WHERE id IN (${placeholders}) AND pubkey = ?`,
      params: [...referencedIds, deletionEvent.pubkey.toLowerCase()],
    });
  }

  return queries;
}
