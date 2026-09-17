import { validateEventStructure, validateFilter } from './validator';
import type {
  ClientCloseMessage,
  ClientCountMessage,
  ClientEventMessage,
  ClientMessage,
  ClientReqMessage,
  NostrEvent,
  NostrFilter,
  ParseResult,
  RelayClosedMessage,
  RelayCountMessage,
  RelayEoseMessage,
  RelayEventMessage,
  RelayMessage,
  RelayNoticeMessage,
  RelayOkMessage,
} from '../types/nostr';

export const MAX_MESSAGE_PAYLOAD_SIZE = 65536; // 64 KB

/**
 * Parses and validates an inbound client Nostr message.
 */
export function parseClientMessage(
  raw: string,
  maxPayloadSize: number = MAX_MESSAGE_PAYLOAD_SIZE
): ParseResult<ClientMessage> {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Message payload must be a string' };
  }

  if (raw.length > maxPayloadSize) {
    return {
      ok: false,
      error: `Message payload exceeds maximum allowed size of ${maxPayloadSize} bytes`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Invalid JSON payload' };
  }

  if (!Array.isArray(parsed) || parsed.length < 2) {
    return { ok: false, error: 'Message must be a JSON array with at least 2 elements' };
  }

  const verb = parsed[0];
  if (typeof verb !== 'string') {
    return { ok: false, error: 'Message verb must be a string' };
  }

  const normalizedVerb = verb.toUpperCase();

  switch (normalizedVerb) {
    case 'REQ': {
      const subId = parsed[1];
      if (typeof subId !== 'string' || subId.length === 0) {
        return { ok: false, error: 'REQ message must contain a non-empty subscription ID string' };
      }

      const filters: NostrFilter[] = [];
      for (let i = 2; i < parsed.length; i++) {
        const item = parsed[i];
        const validation = validateFilter(item);
        if (!validation.valid) {
          return { ok: false, error: `Invalid filter at index ${i - 2}: ${validation.reason}` };
        }
        filters.push(item as NostrFilter);
      }

      const message: ClientReqMessage = ['REQ', subId, ...filters];
      return { ok: true, value: message };
    }

    case 'EVENT': {
      const candidateEvent = parsed[1];
      const validation = validateEventStructure(candidateEvent);
      if (!validation.valid) {
        return { ok: false, error: `Invalid event payload: ${validation.reason}` };
      }

      const message: ClientEventMessage = ['EVENT', candidateEvent as NostrEvent];
      return { ok: true, value: message };
    }

    case 'CLOSE': {
      const subId = parsed[1];
      if (typeof subId !== 'string' || subId.length === 0) {
        return { ok: false, error: 'CLOSE message must contain a non-empty subscription ID string' };
      }

      const message: ClientCloseMessage = ['CLOSE', subId];
      return { ok: true, value: message };
    }

    case 'COUNT': {
      const subId = parsed[1];
      if (typeof subId !== 'string' || subId.length === 0) {
        return { ok: false, error: 'COUNT message must contain a non-empty subscription ID string' };
      }

      const filters: NostrFilter[] = [];
      for (let i = 2; i < parsed.length; i++) {
        const item = parsed[i];
        const validation = validateFilter(item);
        if (!validation.valid) {
          return { ok: false, error: `Invalid filter at index ${i - 2}: ${validation.reason}` };
        }
        filters.push(item as NostrFilter);
      }

      const message: ClientCountMessage = ['COUNT', subId, ...filters];
      return { ok: true, value: message };
    }

    default:
      return { ok: false, error: `Unsupported message verb: ${verb}` };
  }
}

/**
 * Parses and validates an inbound relay Nostr message (e.g. from upstream relays).
 */
export function parseRelayMessage(
  raw: string,
  maxPayloadSize: number = MAX_MESSAGE_PAYLOAD_SIZE
): ParseResult<RelayMessage> {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Relay message payload must be a string' };
  }

  if (raw.length > maxPayloadSize) {
    return {
      ok: false,
      error: `Relay message payload exceeds maximum allowed size of ${maxPayloadSize} bytes`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Invalid JSON payload' };
  }

  if (!Array.isArray(parsed) || parsed.length < 2) {
    return { ok: false, error: 'Relay message must be a JSON array with at least 2 elements' };
  }

  const verb = parsed[0];
  if (typeof verb !== 'string') {
    return { ok: false, error: 'Relay message verb must be a string' };
  }

  const normalizedVerb = verb.toUpperCase();

  switch (normalizedVerb) {
    case 'EVENT': {
      if (parsed.length < 3) {
        return { ok: false, error: 'EVENT relay message must have subscription ID and event' };
      }
      const subId = parsed[1];
      if (typeof subId !== 'string') {
        return { ok: false, error: 'EVENT subscription ID must be a string' };
      }
      const candidateEvent = parsed[2];
      const validation = validateEventStructure(candidateEvent);
      if (!validation.valid) {
        return { ok: false, error: `Invalid event in EVENT message: ${validation.reason}` };
      }

      const message: RelayEventMessage = ['EVENT', subId, candidateEvent as NostrEvent];
      return { ok: true, value: message };
    }

    case 'OK': {
      if (parsed.length < 4) {
        return { ok: false, error: 'OK relay message must have event ID, status, and message' };
      }
      const eventId = parsed[1];
      const accepted = parsed[2];
      const messageText = parsed[3];

      if (typeof eventId !== 'string') {
        return { ok: false, error: 'OK event ID must be a string' };
      }
      if (typeof accepted !== 'boolean') {
        return { ok: false, error: 'OK status must be a boolean' };
      }
      if (typeof messageText !== 'string') {
        return { ok: false, error: 'OK message must be a string' };
      }

      const message: RelayOkMessage = ['OK', eventId, accepted, messageText];
      return { ok: true, value: message };
    }

    case 'EOSE': {
      const subId = parsed[1];
      if (typeof subId !== 'string') {
        return { ok: false, error: 'EOSE subscription ID must be a string' };
      }

      const message: RelayEoseMessage = ['EOSE', subId];
      return { ok: true, value: message };
    }

    case 'CLOSED': {
      if (parsed.length < 3) {
        return { ok: false, error: 'CLOSED relay message must have subscription ID and reason' };
      }
      const subId = parsed[1];
      const reason = parsed[2];

      if (typeof subId !== 'string') {
        return { ok: false, error: 'CLOSED subscription ID must be a string' };
      }
      if (typeof reason !== 'string') {
        return { ok: false, error: 'CLOSED reason must be a string' };
      }

      const message: RelayClosedMessage = ['CLOSED', subId, reason];
      return { ok: true, value: message };
    }

    case 'NOTICE': {
      const messageText = parsed[1];
      if (typeof messageText !== 'string') {
        return { ok: false, error: 'NOTICE message must be a string' };
      }

      const message: RelayNoticeMessage = ['NOTICE', messageText];
      return { ok: true, value: message };
    }

    case 'COUNT': {
      if (parsed.length < 3) {
        return { ok: false, error: 'COUNT relay message must have subscription ID and payload' };
      }
      const subId = parsed[1];
      const countPayload = parsed[2];

      if (typeof subId !== 'string') {
        return { ok: false, error: 'COUNT subscription ID must be a string' };
      }
      if (
        typeof countPayload !== 'object' ||
        countPayload === null ||
        typeof (countPayload as Record<string, unknown>).count !== 'number'
      ) {
        return { ok: false, error: 'COUNT payload must be an object containing "count" number' };
      }

      const message: RelayCountMessage = [
        'COUNT',
        subId,
        { count: (countPayload as { count: number }).count },
      ];
      return { ok: true, value: message };
    }

    default:
      return { ok: false, error: `Unsupported relay message verb: ${verb}` };
  }
}
