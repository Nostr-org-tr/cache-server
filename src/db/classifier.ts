import type { NostrEvent } from '../types/nostr';
import type { EventKindCategory, EventRow } from './types';

/**
 * Classifies an event kind into its protocol lifecycle category.
 *
 * - Kind 5: NIP-09 Deletion event
 * - Kinds 20000..29999: NIP-16 Ephemeral event (never persisted)
 * - Kinds 0, 3, 10000..19999: NIP-16 Standard Replaceable event (keyed on pubkey + kind)
 * - Kinds 30000..39999: NIP-33 Parameterized Replaceable event (keyed on pubkey + kind + d_tag)
 * - All other kinds: Regular persistent event (immutable, keyed on id)
 */
export function classifyEventKind(kind: number): EventKindCategory {
  if (kind === 5) {
    return 'DELETION';
  }

  if (kind >= 20000 && kind < 30000) {
    return 'EPHEMERAL';
  }

  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) {
    return 'REPLACEABLE';
  }

  if (kind >= 30000 && kind < 40000) {
    return 'PARAMETERIZED_REPLACEABLE';
  }

  return 'REGULAR';
}

/**
 * Extracts the identifier value of the first "d" tag from a Nostr event tag array.
 * Defaults to an empty string ("") if no "d" tag exists or if the tag value is empty.
 */
export function extractDTag(tags: string[][]): string {
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (Array.isArray(tag) && tag.length >= 1 && tag[0] === 'd') {
      return tag.length >= 2 && typeof tag[1] === 'string' ? tag[1] : '';
    }
  }
  return '';
}

/**
 * Extracts unique indexable tag pairs (tag_name, tag_value) for insertion into `event_tags`.
 * Ensures uniqueness to avoid primary key conflicts on composite (event_id, tag_name, tag_value).
 */
export function extractIndexableTags(
  event: NostrEvent
): Array<{ tagName: string; tagValue: string }> {
  const seen = new Set<string>();
  const result: Array<{ tagName: string; tagValue: string }> = [];

  for (let i = 0; i < event.tags.length; i++) {
    const tag = event.tags[i];
    if (
      Array.isArray(tag) &&
      tag.length >= 2 &&
      typeof tag[0] === 'string' &&
      typeof tag[1] === 'string' &&
      tag[0].length > 0 &&
      tag[1].length > 0
    ) {
      const tagName = tag[0];
      const tagValue = tag[1];
      const key = `${tagName}\x1f${tagValue}`;

      if (!seen.has(key)) {
        seen.add(key);
        result.push({ tagName, tagValue });
      }
    }
  }

  return result;
}

/**
 * Converts a database row back into a typed NostrEvent object.
 */
export function rowToNostrEvent(row: EventRow): NostrEvent {
  return JSON.parse(row.raw_event) as NostrEvent;
}

/**
 * Converts a NostrEvent into an EventRow database representation.
 */
export function eventToEventRow(event: NostrEvent, recordedAt?: number): EventRow {
  const category = classifyEventKind(event.kind);
  const dTag = category === 'PARAMETERIZED_REPLACEABLE' ? extractDTag(event.tags) : null;
  const now = recordedAt ?? Math.floor(Date.now() / 1000);

  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    d_tag: dTag,
    raw_event: JSON.stringify(event),
    created_at_recorded: now,
  };
}
