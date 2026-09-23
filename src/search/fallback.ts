import { rowToNostrEvent } from '../db/classifier';
import type { EventRow } from '../db/types';
import type { NostrEvent, NostrFilter } from '../types/nostr';
import type { Nip50ParsedQuery } from './types';

/**
 * Computes a simple relevance match score (0.0 to 1.0) for a text query against event content.
 */
export function calculateTextMatchScore(content: string, cleanQuery: string): number {
  if (!content || !cleanQuery) return 0;
  const lowerContent = content.toLowerCase();
  const lowerQuery = cleanQuery.toLowerCase();

  // Exact phrase match
  if (lowerContent.includes(lowerQuery)) {
    return 0.95;
  }

  const terms = lowerQuery.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return 0;

  let matchedTerms = 0;
  for (const term of terms) {
    if (lowerContent.includes(term)) {
      matchedTerms++;
    }
  }

  return matchedTerms > 0 ? (matchedTerms / terms.length) * 0.8 : 0;
}

/**
 * Fallback SQL-based search for offline/test environments when Vectorize or Workers AI bindings are unavailable.
 * Completely parameterized to guarantee 0 SQL injection.
 */
export async function queryEventsFallbackSearch(
  db: D1Database,
  filter: NostrFilter,
  parsedSearch: Nip50ParsedQuery,
  limit = 20
): Promise<Array<{ event: NostrEvent; score: number }>> {
  const cleanQuery = parsedSearch.cleanQuery.trim();
  if (cleanQuery.length === 0) {
    return [];
  }

  const whereClauses: string[] = [];
  const params: (string | number)[] = [];

  // 1. Kinds filter
  if (filter.kinds && filter.kinds.length > 0) {
    const placeholders = filter.kinds.map(() => '?').join(', ');
    whereClauses.push(`kind IN (${placeholders})`);
    params.push(...filter.kinds);
  }

  // 2. Authors filter
  if (filter.authors && filter.authors.length > 0) {
    const placeholders = filter.authors.map(() => '?').join(', ');
    whereClauses.push(`pubkey IN (${placeholders})`);
    params.push(...filter.authors);
  }

  // 3. Since/until
  if (filter.since !== undefined) {
    whereClauses.push('created_at >= ?');
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    whereClauses.push('created_at <= ?');
    params.push(filter.until);
  }

  // 4. Content LIKE terms matching
  const searchTerms = cleanQuery.split(/\s+/).filter((t) => t.length > 0);
  if (searchTerms.length > 0) {
    const termClauses: string[] = [];
    for (const term of searchTerms) {
      termClauses.push('raw_event LIKE ?');
      params.push(`%${term}%`);
    }
    whereClauses.push(`(${termClauses.join(' OR ')})`);
  }

  const resolvedLimit = Math.max(1, Math.min(filter.limit ?? limit, 100));
  params.push(resolvedLimit * 2); // Fetch 2x limit to score and re-rank

  let sql = 'SELECT id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded FROM events';
  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';

  const results = await db.prepare(sql).bind(...params).all<EventRow>();
  if (!results.results || results.results.length === 0) {
    return [];
  }

  const scoredList: Array<{ event: NostrEvent; score: number }> = [];

  for (const row of results.results) {
    const event = rowToNostrEvent(row);
    const score = calculateTextMatchScore(event.content, cleanQuery);
    if (score > 0) {
      scoredList.push({ event, score });
    }
  }

  // Sort descending by score
  scoredList.sort((a, b) => b.score - a.score);

  return scoredList.slice(0, resolvedLimit);
}
