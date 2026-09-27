import { inspectEventModeration } from '../security';
import { rowToNostrEvent } from '../db/classifier';
import type { EventRow } from '../db/types';
import { encodeNote, encodeNpub } from '../protocol/nip19';
import type { Env } from '../types/env';
import type { NostrEvent, NostrFilter } from '../types/nostr';
import { queryEventsFallbackSearch } from './fallback';
import { parseNip50Search } from './parser';
import type { Nip50Extensions, SearchResultAuthor, SearchResultItem } from './types';
import { queryVectorIndex } from './vector-store';
import { computeHybridScore } from './scorer';

/**
 * Computes direct njump.me URL for Nostr events and profiles.
 */
export function buildNjumpUrl(event: NostrEvent, dTag?: string): string {
  try {
    if (event.kind === 0) {
      const npub = encodeNpub(event.pubkey);
      return `https://njump.me/${npub}`;
    }
    if (event.kind === 1) {
      const note = encodeNote(event.id);
      return `https://njump.me/${note}`;
    }
    if (event.kind === 30023) {
      if (dTag !== undefined) {
        return `https://njump.me/30023:${event.pubkey}:${encodeURIComponent(dTag)}`;
      }
      return `https://njump.me/${event.id}`;
    }
    return `https://njump.me/${event.id}`;
  } catch {
    return `https://njump.me/${event.id}`;
  }
}

/**
 * Parses author profile fields from a Kind 0 event.
 */
export function extractAuthorMetadata(event: NostrEvent): SearchResultAuthor {
  const author: SearchResultAuthor = { pubkey: event.pubkey };
  if (event.kind === 0 && event.content) {
    try {
      const parsed = JSON.parse(event.content) as Record<string, unknown>;
      if (typeof parsed['name'] === 'string') author.name = parsed['name'].trim();
      if (typeof parsed['display_name'] === 'string') author.displayName = parsed['display_name'].trim();
      if (typeof parsed['nip05'] === 'string') author.nip05 = parsed['nip05'].trim();
      if (typeof parsed['picture'] === 'string') author.picture = parsed['picture'].trim();
    } catch {
      // Ignore parse failure
    }
  }
  return author;
}

/**
 * Checks if an event matches NIP-50 extension filters (language, domain, nsfw, sentiment).
 */
export function matchesNip50Extensions(event: NostrEvent, extensions: Nip50Extensions): boolean {
  // 1. NSFW / Content warning check
  if (extensions.nsfw === false) {
    if (Array.isArray(event.tags)) {
      const hasContentWarning = event.tags.some(
        (t) => Array.isArray(t) && t[0] === 'content-warning'
      );
      if (hasContentWarning) {
        return false;
      }
    }
  }

  // 2. Language check (if tagged with ["l", "<lang>"] or ["language", "<lang>"])
  if (extensions.language && Array.isArray(event.tags)) {
    const langLower = extensions.language.toLowerCase();
    const hasLangTag = event.tags.some(
      (t) =>
        Array.isArray(t) &&
        (t[0] === 'l' || t[0] === 'language') &&
        typeof t[1] === 'string' &&
        t[1].toLowerCase().startsWith(langLower)
    );
    // If language tag is present on event, enforce match
    const anyLangTag = event.tags.some((t) => Array.isArray(t) && (t[0] === 'l' || t[0] === 'language'));
    if (anyLangTag && !hasLangTag) {
      return false;
    }
  }

  return true;
}

/**
 * Unified Search Query Engine.
 * Executes dual-source hybrid search combining Vectorize ANN semantic search and D1 parameterized SQL keyword search.
 * Computes calibrated hybrid relevance scores and filters out low-similarity vector noise.
 */
export async function executeSearch(
  db: D1Database,
  env: Env,
  filter: NostrFilter,
  limit = 20
): Promise<SearchResultItem[]> {
  const searchQuery = filter.search || '';
  const parsed = parseNip50Search(searchQuery);

  if (!parsed.cleanQuery && !parsed.rawQuery) {
    return [];
  }

  const requestedLimit = Math.max(1, Math.min(filter.limit ?? limit, 50));
  const vectorSearchEnabled = env.VECTOR_SEARCH_ENABLED !== 'false';
  const hasAiAndVectorize = Boolean(env.AI && env.VECTOR_INDEX && vectorSearchEnabled);

  // 1. Dual-Source Candidate Retrieval
  const vectorScoreMap = new Map<string, number>();
  const candidateEventsMap = new Map<string, { event: NostrEvent; dTag?: string | undefined }>();

  const vectorizePromise = (async () => {
    if (hasAiAndVectorize && env.AI && env.VECTOR_INDEX) {
      const vectorMatches = await queryVectorIndex(
        env.AI,
        env.VECTOR_INDEX,
        parsed.cleanQuery,
        requestedLimit * 3,
        env.VECTOR_EMBEDDING_MODEL
      );
      for (const m of vectorMatches) {
        vectorScoreMap.set(m.id, m.score);
      }
      return vectorMatches.map((m) => m.id);
    }
    return [];
  })();

  const sqlLexicalPromise = queryEventsFallbackSearch(db, filter, parsed, requestedLimit * 3);

  const [vectorMatchIds, lexicalCandidates] = await Promise.all([vectorizePromise, sqlLexicalPromise]);

  for (const cand of lexicalCandidates) {
    const dTag = cand.event.tags.find((t) => Array.isArray(t) && t[0] === 'd')?.[1];
    candidateEventsMap.set(cand.event.id, { event: cand.event, dTag });
  }

  // Hydrate missing candidate events from Vectorize ANN results
  const missingIdsFromVector = vectorMatchIds.filter((id) => !candidateEventsMap.has(id));
  if (missingIdsFromVector.length > 0) {
    const placeholders = missingIdsFromVector.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded FROM events WHERE id IN (${placeholders})`
      )
      .bind(...missingIdsFromVector)
      .all<EventRow>();

    if (rows.results && Array.isArray(rows.results)) {
      for (const row of rows.results) {
        const event = rowToNostrEvent(row);
        candidateEventsMap.set(event.id, {
          event,
          dTag: row.d_tag || undefined,
        });
      }
    }
  }

  // 2. Compute Hybrid Relevance Scores & Filter Noise
  const candidateEventsWithScore: Array<{ event: NostrEvent; score: number; dTag?: string | undefined }> = [];

  for (const [id, cand] of candidateEventsMap.entries()) {
    const rawVectorScore = vectorScoreMap.get(id);
    const hybridScore = computeHybridScore(cand.event, parsed.cleanQuery, rawVectorScore);
    if (hybridScore > 0) {
      candidateEventsWithScore.push({
        event: cand.event,
        score: hybridScore,
        dTag: cand.dTag,
      });
    }
  }

  // Preserve hybrid score descending, breaking ties by created_at DESC
  candidateEventsWithScore.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.event.created_at - a.event.created_at;
  });

  // 3. Post-filter candidates against other filter constraints (kinds, authors, since, until, NIP-50 extensions)
  const filteredResults: SearchResultItem[] = [];

  for (const item of candidateEventsWithScore) {
    const event = item.event;

    // Check moderation policy
    if (!inspectEventModeration(event).allowed) {
      continue;
    }

    // Check kinds
    if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(event.kind)) {
      continue;
    }

    // Check authors
    if (filter.authors && filter.authors.length > 0) {
      const matchAuthor = filter.authors.some((a) =>
        event.pubkey.toLowerCase().startsWith(a.toLowerCase())
      );
      if (!matchAuthor) continue;
    }

    // Check since / until
    if (filter.since !== undefined && event.created_at < filter.since) continue;
    if (filter.until !== undefined && event.created_at > filter.until) continue;

    // Check NIP-50 extensions
    if (!matchesNip50Extensions(event, parsed.extensions)) {
      continue;
    }

    // Build rich item metadata
    let title: string | undefined;
    let summary: string | undefined;
    let author: SearchResultAuthor | undefined;

    if (event.kind === 0) {
      author = extractAuthorMetadata(event);
    } else if (event.kind === 30023) {
      for (const tag of event.tags) {
        if (Array.isArray(tag) && tag.length >= 2) {
          if (tag[0] === 'title' && typeof tag[1] === 'string') title = tag[1];
          if (tag[0] === 'summary' && typeof tag[1] === 'string') summary = tag[1];
        }
      }
    }

    const njumpUrl = buildNjumpUrl(event, item.dTag);

    const resultItem: SearchResultItem = {
      event,
      score: item.score,
      njumpUrl,
    };
    if (author) resultItem.author = author;
    if (title) resultItem.title = title;
    if (summary) resultItem.summary = summary;

    filteredResults.push(resultItem);

    if (filteredResults.length >= requestedLimit) {
      break;
    }
  }

  return filteredResults;
}
