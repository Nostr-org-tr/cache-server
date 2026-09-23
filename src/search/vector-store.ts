import { inspectEventModeration } from '../security';
import type { NostrEvent } from '../types/nostr';
import { extractSearchableText, generateEmbeddings } from './embeddings';
import type { VectorSearchResult } from './types';

export const MAX_VECTORIZE_BATCH_SIZE = 50;

/**
 * Indexes a single Nostr event in Cloudflare Vectorize index.
 */
export async function indexEventVector(
  ai: Ai,
  vectorIndex: VectorizeIndex,
  event: NostrEvent,
  model?: string
): Promise<boolean> {
  const moderation = inspectEventModeration(event);
  if (!moderation.allowed) {
    return false;
  }

  const text = extractSearchableText(event);
  if (!text) {
    return false;
  }

  const embeddings = await generateEmbeddings(ai, [text], model);
  if (embeddings.length === 0 || !embeddings[0] || embeddings[0].length === 0) {
    return false;
  }

  try {
    await vectorIndex.upsert([
      {
        id: event.id,
        values: embeddings[0],
        metadata: {
          kind: event.kind,
          pubkey: event.pubkey,
          created_at: event.created_at,
        },
      },
    ]);
    return true;
  } catch (error) {
    console.error(`Failed to upsert vector for event ${event.id}:`, error);
    return false;
  }
}

/**
 * Indexes a batch of Nostr events into Cloudflare Vectorize in safe chunks.
 */
export async function indexEventsBatchVector(
  ai: Ai,
  vectorIndex: VectorizeIndex,
  events: NostrEvent[],
  model?: string
): Promise<number> {
  if (events.length === 0) {
    return 0;
  }

  const validEntries: Array<{ event: NostrEvent; text: string }> = [];
  for (const event of events) {
    if (!inspectEventModeration(event).allowed) {
      continue;
    }
    const text = extractSearchableText(event);
    if (text) {
      validEntries.push({ event, text });
    }
  }

  if (validEntries.length === 0) {
    return 0;
  }

  let totalIndexed = 0;

  for (let i = 0; i < validEntries.length; i += MAX_VECTORIZE_BATCH_SIZE) {
    const chunk = validEntries.slice(i, i + MAX_VECTORIZE_BATCH_SIZE);
    const texts = chunk.map((c) => c.text);
    const embeddings = await generateEmbeddings(ai, texts, model);

    if (embeddings.length === 0) {
      continue;
    }

    const vectors: VectorizeVector[] = [];
    for (let j = 0; j < chunk.length; j++) {
      const entry = chunk[j];
      const vector = embeddings[j];
      if (entry && vector && vector.length > 0) {
        vectors.push({
          id: entry.event.id,
          values: vector,
          metadata: {
            kind: entry.event.kind,
            pubkey: entry.event.pubkey,
            created_at: entry.event.created_at,
          },
        });
      }
    }

    if (vectors.length > 0) {
      try {
        await vectorIndex.upsert(vectors);
        totalIndexed += vectors.length;
      } catch (error) {
        console.error('Failed to batch upsert vectors to Vectorize:', error);
      }
    }
  }

  return totalIndexed;
}

/**
 * Deletes vector records by event IDs from Vectorize.
 */
export async function deleteEventVectors(
  vectorIndex: VectorizeIndex,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const sanitizedIds = ids.filter((id) => typeof id === 'string' && id.length > 0);
  if (sanitizedIds.length === 0) {
    return;
  }

  try {
    for (let i = 0; i < sanitizedIds.length; i += MAX_VECTORIZE_BATCH_SIZE) {
      const chunk = sanitizedIds.slice(i, i + MAX_VECTORIZE_BATCH_SIZE);
      await vectorIndex.deleteByIds(chunk);
    }
  } catch (error) {
    console.error('Failed to delete vectors from Vectorize:', error);
  }
}

/**
 * Performs approximate nearest neighbor (ANN) similarity search on Cloudflare Vectorize.
 * Returns match results sorted strictly by similarity score descending.
 */
export async function queryVectorIndex(
  ai: Ai,
  vectorIndex: VectorizeIndex,
  queryText: string,
  topK = 20,
  model?: string
): Promise<VectorSearchResult[]> {
  if (!queryText || queryText.trim().length === 0) {
    return [];
  }

  const embeddings = await generateEmbeddings(ai, [queryText.trim()], model);
  if (embeddings.length === 0 || !embeddings[0] || embeddings[0].length === 0) {
    return [];
  }

  try {
    const queryResponse = await vectorIndex.query(embeddings[0], {
      topK: Math.max(1, Math.min(topK, 100)),
      returnMetadata: 'indexed',
    });

    if (!queryResponse || !Array.isArray(queryResponse.matches)) {
      return [];
    }

    // Return matches sorted by score DESC
    return queryResponse.matches
      .filter((m) => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => ({
        id: m.id,
        score: typeof m.score === 'number' ? m.score : 0,
      }))
      .sort((a, b) => b.score - a.score);
  } catch (error) {
    console.error('Failed to query Vectorize index:', error);
    return [];
  }
}
