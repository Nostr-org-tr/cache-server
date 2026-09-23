import type { NostrEvent } from '../types/nostr';

/**
 * NIP-50 Query Extensions
 */
export interface Nip50Extensions {
  includeSpam?: boolean | undefined;
  domain?: string | undefined;
  language?: string | undefined;
  sentiment?: 'negative' | 'neutral' | 'positive' | undefined;
  nsfw?: boolean | undefined;
}

/**
 * Parsed NIP-50 Search Query Object
 */
export interface Nip50ParsedQuery {
  rawQuery: string;
  cleanQuery: string;
  extensions: Nip50Extensions;
}

/**
 * Result item from Vectorize index query
 */
export interface VectorSearchResult {
  id: string;
  score: number;
}

/**
 * Formatted author metadata for search result presentation
 */
export interface SearchResultAuthor {
  pubkey: string;
  name?: string | undefined;
  displayName?: string | undefined;
  nip05?: string | undefined;
  picture?: string | undefined;
}

/**
 * Enhanced Search Result Item for Web UI and API consumption
 */
export interface SearchResultItem {
  event: NostrEvent;
  score: number;
  njumpUrl: string;
  author?: SearchResultAuthor | undefined;
  title?: string | undefined;
  summary?: string | undefined;
}

/**
 * JSON Response schema for GET /api/search
 */
export interface SearchApiResponse {
  query: string;
  count: number;
  tookMs: number;
  results: SearchResultItem[];
}
