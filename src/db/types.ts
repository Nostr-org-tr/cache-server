/**
 * Database schema row for the `events` table in Cloudflare D1.
 */
export interface EventRow {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  d_tag: string | null;
  raw_event: string;
  created_at_recorded: number;
}

/**
 * Database schema row for the `event_tags` table in Cloudflare D1.
 */
export interface EventTagRow {
  event_id: string;
  tag_name: string;
  tag_value: string;
}

/**
 * Classification category of Nostr events according to NIP-01, NIP-09, NIP-16, and NIP-33.
 */
export type EventKindCategory =
  | 'REGULAR'
  | 'REPLACEABLE'
  | 'PARAMETERIZED_REPLACEABLE'
  | 'EPHEMERAL'
  | 'DELETION';

/**
 * Represents a parameterized SQL query safe for prepared statement execution.
 */
export interface ParameterizedQuery {
  sql: string;
  params: (string | number)[];
}

/**
 * Result action of saving an event in the repository.
 */
export type SaveAction = 'inserted' | 'superseded' | 'ignored' | 'deleted';

/**
 * Result of saving an event in the repository.
 */
export interface SaveResult {
  action: SaveAction;
  id: string;
  reason?: string;
}

/**
 * Options for compiling and executing NIP-01 filter queries.
 */
export interface EventFilterQueryOptions {
  defaultLimit?: number;
  maxLimit?: number;
}
