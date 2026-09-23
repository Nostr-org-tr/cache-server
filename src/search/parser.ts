import type { Nip50Extensions, Nip50ParsedQuery } from './types';

/**
 * Parses a raw NIP-50 search query string into free text and structured extension directives.
 *
 * Supported extensions:
 * - include:spam -> turns off spam filtering
 * - domain:<domain> -> matches pubkey NIP-05 domain
 * - language:<iso-code> -> matches language
 * - sentiment:<negative|neutral|positive> -> sentiment filter
 * - nsfw:<true|false> -> content warning filter
 *
 * Any unknown `key:value` tokens are safely omitted from clean query per NIP-50 spec.
 */
export function parseNip50Search(rawQuery: string): Nip50ParsedQuery {
  if (!rawQuery || typeof rawQuery !== 'string') {
    return {
      rawQuery: '',
      cleanQuery: '',
      extensions: {},
    };
  }

  const trimmed = rawQuery.trim();
  if (trimmed.length === 0) {
    return {
      rawQuery: '',
      cleanQuery: '',
      extensions: {},
    };
  }

  const tokens = trimmed.split(/\s+/);
  const textWords: string[] = [];
  const extensions: Nip50Extensions = {};

  for (const token of tokens) {
    // Check for include:spam flag
    if (token.toLowerCase() === 'include:spam') {
      extensions.includeSpam = true;
      continue;
    }

    const colonIndex = token.indexOf(':');
    if (colonIndex > 0 && colonIndex < token.length - 1) {
      const key = token.slice(0, colonIndex).toLowerCase();
      const val = token.slice(colonIndex + 1);

      switch (key) {
        case 'domain': {
          if (val.length > 0) {
            extensions.domain = val.toLowerCase();
          }
          break;
        }
        case 'language':
        case 'lang': {
          if (val.length >= 2) {
            extensions.language = val.toLowerCase().slice(0, 5);
          }
          break;
        }
        case 'sentiment': {
          const lowerVal = val.toLowerCase();
          if (lowerVal === 'negative' || lowerVal === 'neutral' || lowerVal === 'positive') {
            extensions.sentiment = lowerVal;
          }
          break;
        }
        case 'nsfw': {
          const lowerVal = val.toLowerCase();
          if (lowerVal === 'true' || lowerVal === '1' || lowerVal === 'yes') {
            extensions.nsfw = true;
          } else if (lowerVal === 'false' || lowerVal === '0' || lowerVal === 'no') {
            extensions.nsfw = false;
          }
          break;
        }
        default: {
          // Unknown extension directive: ignore per NIP-50
          break;
        }
      }
    } else {
      textWords.push(token);
    }
  }

  return {
    rawQuery: trimmed,
    cleanQuery: textWords.join(' '),
    extensions,
  };
}
