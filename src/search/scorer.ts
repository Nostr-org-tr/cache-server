import type { NostrEvent } from '../types/nostr';

/**
 * Noise floor threshold for dense vector similarity (cosine similarity with BAAI/bge-m3).
 * Below this threshold, vector similarity represents uncorrelated embedding noise.
 */
export const VECTOR_NOISE_FLOOR = 0.55;

/**
 * Threshold for accepting a pure semantic match without any lexical keyword overlap.
 */
export const MIN_PURE_VECTOR_THRESHOLD = 0.62;

/**
 * Extracts searchable text sections and priority fields from a Nostr event.
 */
export interface EventSearchableFields {
  primaryFields: string[];
  secondaryFields: string[];
  allText: string;
}

/**
 * Normalizes and extracts structured text fields from an event for lexical scoring.
 */
export function getEventSearchableFields(event: NostrEvent): EventSearchableFields {
  const primaryFields: string[] = [];
  const secondaryFields: string[] = [];

  if (!event || typeof event.content !== 'string') {
    return { primaryFields, secondaryFields, allText: '' };
  }

  switch (event.kind) {
    // Kind 0: Metadata / Profile
    case 0: {
      try {
        const metadata = JSON.parse(event.content) as Record<string, unknown>;
        if (typeof metadata['display_name'] === 'string' && metadata['display_name'].trim().length > 0) {
          primaryFields.push(metadata['display_name'].trim());
        }
        if (typeof metadata['name'] === 'string' && metadata['name'].trim().length > 0) {
          primaryFields.push(metadata['name'].trim());
        }
        if (typeof metadata['nip05'] === 'string' && metadata['nip05'].trim().length > 0) {
          primaryFields.push(metadata['nip05'].trim());
        }
        if (typeof metadata['about'] === 'string' && metadata['about'].trim().length > 0) {
          secondaryFields.push(metadata['about'].trim());
        }
        if (typeof metadata['website'] === 'string' && metadata['website'].trim().length > 0) {
          secondaryFields.push(metadata['website'].trim());
        }
      } catch {
        secondaryFields.push(event.content.trim());
      }
      break;
    }

    // Kind 30023: Long-form Article
    case 30023: {
      if (Array.isArray(event.tags)) {
        for (const tag of event.tags) {
          if (Array.isArray(tag) && tag.length >= 2) {
            if (tag[0] === 'title' && typeof tag[1] === 'string' && tag[1].trim().length > 0) {
              primaryFields.push(tag[1].trim());
            } else if (tag[0] === 'summary' && typeof tag[1] === 'string' && tag[1].trim().length > 0) {
              primaryFields.push(tag[1].trim());
            }
          }
        }
      }
      if (event.content.trim().length > 0) {
        secondaryFields.push(event.content.trim());
      }
      break;
    }

    // Kind 9802: Highlight
    case 9802: {
      if (event.content.trim().length > 0) {
        primaryFields.push(event.content.trim());
      }
      if (Array.isArray(event.tags)) {
        for (const tag of event.tags) {
          if (Array.isArray(tag) && tag.length >= 2 && tag[0] === 'context' && typeof tag[1] === 'string') {
            secondaryFields.push(tag[1].trim());
          }
        }
      }
      break;
    }

    // Kind 1 Notes and others
    default: {
      if (event.content.trim().length > 0) {
        primaryFields.push(event.content.trim());
      }
      break;
    }
  }

  // Also include any topic or hashtag tags
  if (Array.isArray(event.tags)) {
    for (const tag of event.tags) {
      if (Array.isArray(tag) && tag.length >= 2 && (tag[0] === 't' || tag[0] === 'hashtag') && typeof tag[1] === 'string') {
        primaryFields.push(tag[1].trim());
      }
    }
  }

  const allText = [...primaryFields, ...secondaryFields].join(' ');
  return { primaryFields, secondaryFields, allText };
}

/**
 * Computes exact & token-based lexical match score (0.0 to 1.0).
 * Heavily boosts exact phrase matches in primary identity fields (name, display_name, title).
 */
export function computeLexicalScore(event: NostrEvent, cleanQuery: string): number {
  const query = cleanQuery.trim().toLowerCase();
  if (query.length === 0) {
    return 0;
  }

  const { primaryFields, secondaryFields, allText } = getEventSearchableFields(event);
  if (allText.length === 0) {
    return 0;
  }

  const lowerPrimary = primaryFields.map((f) => f.toLowerCase());
  const lowerSecondary = secondaryFields.map((f) => f.toLowerCase());

  // 1. Exact match in primary field (e.g. searching "emre" and display_name is "Emre Yilmaz" or name is "emre")
  for (const field of lowerPrimary) {
    if (field === query) {
      return 1.0; // Perfect match
    }
    if (field.includes(query)) {
      // Word boundary match inside primary field gets 0.95, substring gets 0.90
      const isWordBoundary = new RegExp(`(^|\\b|\\s|@|_)${escapeRegExp(query)}(\\b|\\s|@|\\.|_)`, 'i').test(field);
      return isWordBoundary ? 0.96 : 0.90;
    }
  }

  // 2. Exact match in secondary field (e.g. in about section or body)
  for (const field of lowerSecondary) {
    if (field.includes(query)) {
      const isWordBoundary = new RegExp(`(^|\\b|\\s|@|_)${escapeRegExp(query)}(\\b|\\s|@|\\.|_)`, 'i').test(field);
      return isWordBoundary ? 0.92 : 0.85;
    }
  }

  // 3. Multi-term query matching
  const terms = query.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length <= 1) {
    // Single term not found in any field
    return 0;
  }

  let matchedTermsPrimary = 0;
  let matchedTermsSecondary = 0;

  for (const term of terms) {
    if (lowerPrimary.some((f) => f.includes(term))) {
      matchedTermsPrimary++;
    } else if (lowerSecondary.some((f) => f.includes(term))) {
      matchedTermsSecondary++;
    }
  }

  const totalMatched = matchedTermsPrimary + matchedTermsSecondary;
  if (totalMatched === 0) {
    return 0;
  }

  const coverageRatio = totalMatched / terms.length;
  // If all terms are present in primary/secondary fields
  if (coverageRatio === 1.0) {
    return matchedTermsPrimary > 0 ? 0.90 : 0.82;
  }

  // Partial match: scale down by coverage ratio
  return coverageRatio * (matchedTermsPrimary > 0 ? 0.70 : 0.55);
}

/**
 * Calibrates dense vector cosine similarity by removing background noise and scaling.
 */
export function calibrateVectorScore(rawCosineScore: number): number {
  if (typeof rawCosineScore !== 'number' || isNaN(rawCosineScore) || rawCosineScore <= VECTOR_NOISE_FLOOR) {
    return 0;
  }

  // Scale from [VECTOR_NOISE_FLOOR, 1.0] -> [0.0, 1.0]
  const normalized = (rawCosineScore - VECTOR_NOISE_FLOOR) / (1.0 - VECTOR_NOISE_FLOOR);
  return Math.max(0, Math.min(1.0, normalized));
}

/**
 * Unified Hybrid Relevance Scorer.
 * Combines lexical exact matching with calibrated dense vector semantic similarity.
 * Drops vector noise results when there is zero lexical overlap and vector similarity is below threshold.
 */
export function computeHybridScore(
  event: NostrEvent,
  cleanQuery: string,
  rawVectorScore?: number
): number {
  const lexicalScore = computeLexicalScore(event, cleanQuery);
  const rawVector = typeof rawVectorScore === 'number' ? rawVectorScore : 0;
  const calibratedVector = calibrateVectorScore(rawVector);

  // Hard rejection: Zero lexical match and vector score below pure semantic threshold
  if (lexicalScore === 0 && rawVector < MIN_PURE_VECTOR_THRESHOLD) {
    return 0;
  }

  // Case 1: Both lexical and semantic matches present
  if (lexicalScore > 0 && calibratedVector > 0) {
    // Start with lexical baseline, reinforced by calibrated semantic similarity
    const combined = lexicalScore + (1.0 - lexicalScore) * calibratedVector * 0.6;
    return Math.min(1.0, Math.round(combined * 10000) / 10000);
  }

  // Case 2: Pure lexical match (missing in Vectorize or vector score not generated)
  if (lexicalScore > 0) {
    return Math.round(lexicalScore * 10000) / 10000;
  }

  // Case 3: Pure high-confidence semantic match without exact keyword (rawVector >= MIN_PURE_VECTOR_THRESHOLD)
  if (calibratedVector > 0) {
    const semanticOnlyScore = calibratedVector * 0.80;
    return Math.round(semanticOnlyScore * 10000) / 10000;
  }

  return 0;
}

/**
 * Escapes characters for safe regular expression generation.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
