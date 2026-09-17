import type {
  NostrEvent,
  RelayClosedMessage,
  RelayCountMessage,
  RelayEoseMessage,
  RelayEventMessage,
  RelayNoticeMessage,
  RelayOkMessage,
} from '../types/nostr';

/**
 * Formats a NIP-01 EVENT relay response message.
 */
export function formatEventMessage(subId: string, event: NostrEvent): string {
  const msg: RelayEventMessage = ['EVENT', subId, event];
  return JSON.stringify(msg);
}

/**
 * Formats a NIP-20 OK command result relay response message.
 */
export function formatOkMessage(eventId: string, accepted: boolean, message: string = ''): string {
  const msg: RelayOkMessage = ['OK', eventId, accepted, message];
  return JSON.stringify(msg);
}

/**
 * Formats a NIP-01 EOSE (End of Stored Events) relay response message.
 */
export function formatEoseMessage(subId: string): string {
  const msg: RelayEoseMessage = ['EOSE', subId];
  return JSON.stringify(msg);
}

/**
 * Formats a NIP-01 CLOSED subscription termination relay response message.
 */
export function formatClosedMessage(subId: string, message: string): string {
  const msg: RelayClosedMessage = ['CLOSED', subId, message];
  return JSON.stringify(msg);
}

/**
 * Formats a NIP-01 NOTICE relay response message.
 */
export function formatNoticeMessage(message: string): string {
  const msg: RelayNoticeMessage = ['NOTICE', message];
  return JSON.stringify(msg);
}

/**
 * Formats a NIP-45 COUNT relay response message.
 */
export function formatCountMessage(subId: string, count: number): string {
  const msg: RelayCountMessage = ['COUNT', subId, { count }];
  return JSON.stringify(msg);
}

/**
 * Formats a NIP-01 REQ client subscription message (e.g. sent to upstream relays).
 */
export function formatReqMessage(subId: string, filters: import('../types/nostr').NostrFilter[]): string {
  const msg = ['REQ', subId, ...filters];
  return JSON.stringify(msg);
}

/**
 * Formats a NIP-01 CLOSE client message (e.g. sent to upstream relays).
 */
export function formatCloseMessage(subId: string): string {
  const msg = ['CLOSE', subId];
  return JSON.stringify(msg);
}
