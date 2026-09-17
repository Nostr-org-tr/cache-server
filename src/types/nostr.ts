/**
 * Canonical Nostr Event Interface (NIP-01)
 */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Unsigned Nostr Event Interface (prior to ID and signature computation)
 */
export interface UnsignedNostrEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * NIP-01 Subscription Filter
 */
export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  search?: string;
  [key: `#${string}`]: string[] | undefined;
}

/**
 * NIP-01 Client Inbound Messages
 */
export type ClientReqMessage = ['REQ', string, ...NostrFilter[]];
export type ClientEventMessage = ['EVENT', NostrEvent];
export type ClientCloseMessage = ['CLOSE', string];
export type ClientCountMessage = ['COUNT', string, ...NostrFilter[]];

export type ClientMessage =
  | ClientReqMessage
  | ClientEventMessage
  | ClientCloseMessage
  | ClientCountMessage;

/**
 * NIP-01 / NIP-20 Relay Outbound Messages
 */
export type RelayEventMessage = ['EVENT', string, NostrEvent];
export type RelayOkMessage = ['OK', string, boolean, string];
export type RelayEoseMessage = ['EOSE', string];
export type RelayClosedMessage = ['CLOSED', string, string];
export type RelayNoticeMessage = ['NOTICE', string];
export type RelayCountMessage = ['COUNT', string, { count: number }];

export type RelayMessage =
  | RelayEventMessage
  | RelayOkMessage
  | RelayEoseMessage
  | RelayClosedMessage
  | RelayNoticeMessage
  | RelayCountMessage;

/**
 * Validation and Parsing Result Types
 */
export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * NIP-11 Relay Information Document
 */
export interface Nip11RelayInformation {
  name: string;
  description: string;
  pubkey: string;
  contact: string;
  supported_nips: number[];
  software: string;
  version: string;
  limitation?: {
    max_message_length?: number;
    max_subscriptions?: number;
    max_filters?: number;
    max_limit?: number;
    max_event_tags?: number;
    max_content_length?: number;
    min_pow_difficulty?: number;
    auth_required?: boolean;
    payment_required?: boolean;
    restricted_writes?: boolean;
  };
}
