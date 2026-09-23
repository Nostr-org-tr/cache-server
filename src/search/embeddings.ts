import type { NostrEvent } from '../types/nostr';

export const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const MAX_EMBEDDING_TEXT_LENGTH = 1000;

const URL_REGEX = /https?:\/\/[^\s]+|nostr:[a-zA-Z0-9]+/gi;

/**
 * Validates if the given text has sufficient substantive content for vector indexing.
 * Strips URLs, Nostr URIs, emojis, and symbols to ensure meaningful semantic searchability.
 */
export function isSubstantiveText(text: string, minSubstantiveChars = 8): boolean {
  if (!text || typeof text !== 'string') {
    return false;
  }

  // Remove URLs and Nostr entity URIs
  const textWithoutUrls = text.replace(URL_REGEX, '').trim();
  if (textWithoutUrls.length === 0) {
    return false;
  }

  // Extract alphanumeric / letter / number characters (Unicode aware)
  const lettersAndDigits = textWithoutUrls.replace(/[^\p{L}\p{N}]/gu, '');
  return lettersAndDigits.length >= minSubstantiveChars;
}

/**
 * Extracts normalized, structured searchable text from a Nostr event based on kind semantics.
 * Focuses on Kind 0 (Profiles), Kind 1 (Notes), Kind 9802 (Highlights), and Kind 30023 (Articles).
 * Filters out low-quality, empty, or pure-media/URL events to optimize vector storage and AI compute costs.
 */
export function extractSearchableText(event: NostrEvent): string | null {
  if (!event || typeof event.content !== 'string') {
    return null;
  }

  // Never index ephemeral events
  if (event.kind >= 20000 && event.kind < 30000) {
    return null;
  }

  switch (event.kind) {
    // Kind 0: Metadata / Profile
    case 0: {
      try {
        const metadata = JSON.parse(event.content) as Record<string, unknown>;
        const parts: string[] = [];
        if (typeof metadata['display_name'] === 'string' && metadata['display_name'].trim().length > 0) {
          parts.push(`Display Name: ${metadata['display_name'].trim()}`);
        }
        if (typeof metadata['name'] === 'string' && metadata['name'].trim().length > 0) {
          parts.push(`Name: ${metadata['name'].trim()}`);
        }
        if (typeof metadata['about'] === 'string' && metadata['about'].trim().length > 0) {
          parts.push(`About: ${metadata['about'].trim()}`);
        }
        if (typeof metadata['nip05'] === 'string' && metadata['nip05'].trim().length > 0) {
          parts.push(`NIP-05: ${metadata['nip05'].trim()}`);
        }
        const combined = parts.join(' | ');
        if (!isSubstantiveText(combined, 3)) {
          return null;
        }
        return combined.slice(0, MAX_EMBEDDING_TEXT_LENGTH);
      } catch {
        const trimmed = event.content.trim();
        if (!isSubstantiveText(trimmed, 3)) {
          return null;
        }
        return trimmed.slice(0, MAX_EMBEDDING_TEXT_LENGTH);
      }
    }

    // Kind 1: Short Text Note
    case 1: {
      const trimmed = event.content.trim();
      if (!isSubstantiveText(trimmed, 8)) {
        return null;
      }
      return trimmed.slice(0, MAX_EMBEDDING_TEXT_LENGTH);
    }

    // Kind 30023: Long-form Article
    case 30023: {
      const parts: string[] = [];
      let title: string | undefined;
      let summary: string | undefined;

      if (Array.isArray(event.tags)) {
        for (const tag of event.tags) {
          if (Array.isArray(tag) && tag.length >= 2) {
            if (tag[0] === 'title' && typeof tag[1] === 'string') {
              title = tag[1].trim();
            } else if (tag[0] === 'summary' && typeof tag[1] === 'string') {
              summary = tag[1].trim();
            }
          }
        }
      }

      if (title) parts.push(`Title: ${title}`);
      if (summary) parts.push(`Summary: ${summary}`);
      if (event.content.trim().length > 0) {
        parts.push(`Content: ${event.content.trim()}`);
      }

      const combined = parts.join('\n');
      if (!isSubstantiveText(combined, 8)) {
        return null;
      }
      return combined.slice(0, MAX_EMBEDDING_TEXT_LENGTH);
    }

    // Kind 9802: Highlight
    case 9802: {
      const parts: string[] = [];
      if (event.content.trim().length > 0) {
        parts.push(`Highlight: ${event.content.trim()}`);
      }
      if (Array.isArray(event.tags)) {
        for (const tag of event.tags) {
          if (Array.isArray(tag) && tag.length >= 2 && tag[0] === 'context' && typeof tag[1] === 'string') {
            parts.push(`Context: ${tag[1].trim()}`);
          }
        }
      }
      const combined = parts.join(' | ');
      if (!isSubstantiveText(combined, 8)) {
        return null;
      }
      return combined.slice(0, MAX_EMBEDDING_TEXT_LENGTH);
    }

    // Generic fallback for other persistent text kinds
    default: {
      const trimmed = event.content.trim();
      if (!isSubstantiveText(trimmed, 8)) {
        return null;
      }
      return trimmed.slice(0, MAX_EMBEDDING_TEXT_LENGTH);
    }
  }
}

/**
 * Generates dense vector embeddings using Cloudflare Workers AI.
 */
export async function generateEmbeddings(
  ai: Ai,
  texts: string[],
  model: string = DEFAULT_EMBEDDING_MODEL
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  // Filter out empty texts
  const validTexts = texts.map((t) => t.trim().slice(0, MAX_EMBEDDING_TEXT_LENGTH));
  
  try {
    const response = await ai.run(model as any, {
      text: validTexts,
    }) as { data?: number[][] | number[] };

    if (!response || !response.data) {
      return [];
    }

    // Handle nested 2D array or single 1D vector
    if (Array.isArray(response.data)) {
      if (response.data.length > 0 && typeof response.data[0] === 'number') {
        return [response.data as number[]];
      }
      return response.data as number[][];
    }

    return [];
  } catch (error) {
    console.error('Failed to generate embeddings from Workers AI:', error);
    return [];
  }
}
