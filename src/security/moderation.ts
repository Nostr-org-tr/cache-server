import type { NostrEvent } from '../types/nostr';

/**
 * Result of inspecting an event against moderation rules.
 */
export interface ModerationResult {
  readonly allowed: boolean;
  readonly isSensitive: boolean;
  readonly reason?: string;
  readonly flagType?:
    | 'nip36'
    | 'nip32'
    | 'banned_pubkey'
    | 'banned_event'
    | 'banned_hashtag'
    | 'banned_content'
    | 'ai_guard';
}

/**
 * Moderation ruleset derived from operator mute lists (NIP-51) and reports (NIP-56).
 */
export interface ModerationRuleset {
  readonly blockedPubkeys: ReadonlySet<string>;
  readonly blockedEventIds: ReadonlySet<string>;
  readonly bannedWordsAndDomains: readonly string[];
  readonly bannedHashtags: ReadonlySet<string>;
}

/**
 * Creates an empty moderation ruleset.
 */
export function createEmptyModerationRuleset(): ModerationRuleset {
  return {
    blockedPubkeys: new Set<string>(),
    blockedEventIds: new Set<string>(),
    bannedWordsAndDomains: [],
    bannedHashtags: new Set<string>(),
  };
}

const SENSITIVE_LABEL_VALUES = new Set([
  'adult',
  'porn',
  'nsfw',
  'nudity',
  'sexual',
  'gore',
  'violence',
  'hate',
  'illegal',
  'content-warning',
]);

/**
 * Checks whether an event contains NIP-36 sensitive/content-warning tags.
 */
export function hasNip36ContentWarning(event: NostrEvent): boolean {
  if (!Array.isArray(event.tags)) {
    return false;
  }
  for (const tag of event.tags) {
    if (Array.isArray(tag) && tag.length > 0 && tag[0] === 'content-warning') {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether an event contains NIP-32 adult or sensitive content labels.
 */
export function hasNip32SensitiveLabel(event: NostrEvent): boolean {
  if (!Array.isArray(event.tags)) {
    return false;
  }
  for (const tag of event.tags) {
    if (!Array.isArray(tag) || tag.length < 2) {
      continue;
    }
    const tagKey = tag[0];
    const tagVal = tag[1]?.toLowerCase();

    // NIP-32 ["L", "<namespace>"] or ["l", "<label>", "<namespace>"]
    if (tagKey === 'L' && tagVal && SENSITIVE_LABEL_VALUES.has(tagVal)) {
      return true;
    }
    if (tagKey === 'l' && tagVal && SENSITIVE_LABEL_VALUES.has(tagVal)) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts moderation rules from operator events (NIP-51 kind:10000, NIP-56 kind:1984).
 * Only events signed by the specified operator pubkey are parsed.
 */
export function extractModerationRulesFromEvents(
  events: NostrEvent[],
  operatorPubkey: string
): ModerationRuleset {
  const normalizedOperator = operatorPubkey.trim().toLowerCase();
  if (!normalizedOperator) {
    return createEmptyModerationRuleset();
  }

  const blockedPubkeys = new Set<string>();
  const blockedEventIds = new Set<string>();
  const bannedWordsAndDomains: string[] = [];
  const bannedHashtags = new Set<string>();

  for (const event of events) {
    if (event.pubkey.toLowerCase() !== normalizedOperator) {
      continue;
    }

    // 1. NIP-51 Mute List (kind 10000)
    if (event.kind === 10000 && Array.isArray(event.tags)) {
      for (const tag of event.tags) {
        if (!Array.isArray(tag) || tag.length < 2) {
          continue;
        }
        const tagType = tag[0];
        const target = tag[1]?.trim();
        if (!target) {
          continue;
        }

        switch (tagType) {
          case 'p':
            blockedPubkeys.add(target.toLowerCase());
            break;
          case 'e':
            blockedEventIds.add(target.toLowerCase());
            break;
          case 'word':
            bannedWordsAndDomains.push(target.toLowerCase());
            break;
          case 't':
            bannedHashtags.add(target.toLowerCase().replace(/^#/, ''));
            break;
        }
      }
    }

    // 2. NIP-56 Report (kind 1984)
    if (event.kind === 1984 && Array.isArray(event.tags)) {
      for (const tag of event.tags) {
        if (!Array.isArray(tag) || tag.length < 2) {
          continue;
        }
        const tagType = tag[0];
        const target = tag[1]?.trim();
        if (!target) {
          continue;
        }

        if (tagType === 'p') {
          blockedPubkeys.add(target.toLowerCase());
        } else if (tagType === 'e') {
          blockedEventIds.add(target.toLowerCase());
        }
      }
    }
  }

  return {
    blockedPubkeys,
    blockedEventIds,
    bannedWordsAndDomains: Array.from(new Set(bannedWordsAndDomains)),
    bannedHashtags,
  };
}

/**
 * Inspects a Nostr event against strict moderation invariants and operator rules.
 */
export function inspectEventModeration(
  event: NostrEvent,
  ruleset?: ModerationRuleset
): ModerationResult {
  // 1. Fast-path: NIP-36 content-warning tag
  if (hasNip36ContentWarning(event)) {
    return {
      allowed: false,
      isSensitive: true,
      reason: 'blocked: content-warning tag present (NIP-36)',
      flagType: 'nip36',
    };
  }

  // 2. Fast-path: NIP-32 adult/nsfw labels
  if (hasNip32SensitiveLabel(event)) {
    return {
      allowed: false,
      isSensitive: true,
      reason: 'blocked: sensitive or adult label present (NIP-32)',
      flagType: 'nip32',
    };
  }

  // 3. Mute lists (kind 10000), Reports (kind 1984), and Deletions (kind 5) define rules/actions and must not self-moderate on their own definition tags
  if (event.kind === 10000 || event.kind === 1984 || event.kind === 5) {
    if (ruleset && ruleset.blockedPubkeys.has(event.pubkey.toLowerCase())) {
      return {
        allowed: false,
        isSensitive: true,
        reason: 'blocked: author pubkey is muted by relay operator',
        flagType: 'banned_pubkey',
      };
    }
    return {
      allowed: true,
      isSensitive: false,
    };
  }

  // 4. Operator Ruleset Checks
  if (ruleset) {
    const authorLower = event.pubkey.toLowerCase();
    if (ruleset.blockedPubkeys.has(authorLower)) {
      return {
        allowed: false,
        isSensitive: true,
        reason: 'blocked: author pubkey is muted by relay operator',
        flagType: 'banned_pubkey',
      };
    }

    const eventIdLower = event.id.toLowerCase();
    if (ruleset.blockedEventIds.has(eventIdLower)) {
      return {
        allowed: false,
        isSensitive: true,
        reason: 'blocked: event id is muted by relay operator',
        flagType: 'banned_event',
      };
    }

    // Check tags for banned hashtags
    if (Array.isArray(event.tags)) {
      for (const tag of event.tags) {
        if (Array.isArray(tag) && tag.length >= 2 && tag[0] === 't') {
          const tagVal = tag[1]?.toLowerCase().replace(/^#/, '');
          if (tagVal && ruleset.bannedHashtags.has(tagVal)) {
            return {
              allowed: false,
              isSensitive: true,
              reason: `blocked: prohibited hashtag #${tagVal}`,
              flagType: 'banned_hashtag',
            };
          }
        }
      }
    }

    // Check content and media tags for banned words / domains
    if (ruleset.bannedWordsAndDomains.length > 0) {
      const lowerContent = (event.content || '').toLowerCase();
      for (const phrase of ruleset.bannedWordsAndDomains) {
        if (phrase && lowerContent.includes(phrase)) {
          return {
            allowed: false,
            isSensitive: true,
            reason: 'blocked: prohibited content or domain pattern',
            flagType: 'banned_content',
          };
        }
      }

      // Also inspect URL tags (e.g. imeta, url, r tags)
      if (Array.isArray(event.tags)) {
        for (const tag of event.tags) {
          if (!Array.isArray(tag)) continue;
          for (const item of tag) {
            if (typeof item !== 'string') continue;
            const lowerItem = item.toLowerCase();
            for (const phrase of ruleset.bannedWordsAndDomains) {
              if (phrase && lowerItem.includes(phrase)) {
                return {
                  allowed: false,
                  isSensitive: true,
                  reason: 'blocked: prohibited URL or domain in tag',
                  flagType: 'banned_content',
                };
              }
            }
          }
        }
      }
    }
  }

  return {
    allowed: true,
    isSensitive: false,
  };
}
