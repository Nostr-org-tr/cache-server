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
 * Result of inspecting an event against storage/persistence policies.
 */
export interface StoragePolicyResult {
  readonly recordable: boolean;
  readonly reason?: string;
  readonly classification:
    | 'standard_event'
    | 'encrypted_public_kind'
    | 'chunk_file_protocol'
    | 'raw_binary_blob'
    | 'app_data_dump';
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

const PUBLIC_TEXT_KINDS = new Set([1, 6, 7, 1111, 9802, 30023]);

const CHUNK_PROTOCOL_HASHTAG_PREFIXES = [
  'hpp',
  'hpp-',
  'hpp_seed',
  'seed-',
  'file-chunk',
  'file_chunk',
  'packet-stream',
  'packet_stream',
  'torrent-chunk',
  'torrent_chunk',
  'blob-chunk',
  'blob_chunk',
  'chunk-stream',
  'chunk_stream',
];

const CHUNK_PROTOCOL_KEYWORDS = [
  'hpp_seed',
  'hpp/1',
  'hpp_seed/1',
  'nostr_chunk',
  'file_chunk',
  'packet_stream',
];

/**
 * Checks whether an event is a chunked file transfer, packet stream, or torrent/HPP protocol.
 */
export function isChunkOrPacketProtocol(event: NostrEvent): boolean {
  if (!Array.isArray(event.tags) && typeof event.content !== 'string') {
    return false;
  }

  // 1. Tag-based inspection
  let hasChunkIndexTag = false;
  let hasChunkCountTag = false;
  let hasFileHashTag = false;

  if (Array.isArray(event.tags)) {
    for (const tag of event.tags) {
      if (!Array.isArray(tag) || tag.length < 2) continue;
      const tagKey = tag[0];
      const tagVal = (tag[1] || '').trim().toLowerCase();

      if (tagKey === 't') {
        const cleanTag = tagVal.replace(/^#/, '');
        for (const prefix of CHUNK_PROTOCOL_HASHTAG_PREFIXES) {
          if (cleanTag === prefix || cleanTag.startsWith(prefix)) {
            return true;
          }
        }
      } else if (tagKey === 'i' || tagKey === 'chunk_index' || tagKey === 'chunk') {
        hasChunkIndexTag = true;
      } else if (tagKey === 'n' || tagKey === 'chunk_count' || tagKey === 'total_chunks' || tagKey === 'total') {
        hasChunkCountTag = true;
      } else if (tagKey === 'x' || tagKey === 'file_hash' || tagKey === 'sha256') {
        hasFileHashTag = true;
      }
    }
  }

  // Combined chunk tag fingerprint (e.g. ['x', hash], ['i', index], ['n', count])
  if (hasChunkIndexTag && (hasChunkCountTag || hasFileHashTag)) {
    return true;
  }

  // 2. Content-based JSON packet protocol inspection
  const trimmedContent = (event.content || '').trim();
  if (trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmedContent) as Record<string, unknown>;
      if (typeof parsed === 'object' && parsed !== null) {
        // Check for protocol field e.g. "protocol": "HPP_SEED/1"
        if (typeof parsed.protocol === 'string') {
          const protoLower = parsed.protocol.toLowerCase();
          for (const kw of CHUNK_PROTOCOL_KEYWORDS) {
            if (protoLower.includes(kw)) {
              return true;
            }
          }
          if (
            protoLower.startsWith('hpp') ||
            protoLower.startsWith('chunk') ||
            protoLower.startsWith('packet')
          ) {
            return true;
          }
        }

        // Check for chunk_index / chunk_count / data blob combinations
        if (
          ('chunk_index' in parsed || 'chunk' in parsed || 'i' in parsed) &&
          ('chunk_count' in parsed || 'total_chunks' in parsed || 'n' in parsed || 'data' in parsed)
        ) {
          return true;
        }

        // Check for sha256 + data + base64 chunk payload
        if (
          'sha256' in parsed &&
          'data' in parsed &&
          (parsed.encoding === 'base64' || typeof parsed.data === 'string')
        ) {
          return true;
        }
      }
    } catch {
      // Not valid JSON, continue with substring checks below
    }
  }

  const lowerContent = trimmedContent.toLowerCase();
  for (const kw of CHUNK_PROTOCOL_KEYWORDS) {
    if (lowerContent.includes(`"protocol":"${kw}`) || lowerContent.includes(`"protocol": "${kw}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether an event in a public note kind contains encrypted payload ciphertext.
 * Legitimate encrypted kinds are Kind 4 (NIP-04), Kind 1059 (Gift Wrap), Kind 14 (NIP-17 DM).
 */
export function isEncryptedPayloadInPublicKind(event: NostrEvent): boolean {
  if (!PUBLIC_TEXT_KINDS.has(event.kind)) {
    return false;
  }

  const content = (event.content || '').trim();
  if (!content) {
    return false;
  }

  // Check NIP-04 ciphertext format: `<base64>?iv=<base64>` without whitespace
  if (content.includes('?iv=')) {
    const parts = content.split('?iv=');
    if (parts.length === 2) {
      const [ciphertext, iv] = parts;
      if (
        ciphertext &&
        iv &&
        !/\s/.test(ciphertext) &&
        !/\s/.test(iv) &&
        ciphertext.length >= 16 &&
        iv.length >= 16 &&
        /^[A-Za-z0-9+/=]+$/.test(ciphertext) &&
        /^[A-Za-z0-9+/=]+$/.test(iv)
      ) {
        return true;
      }
    }
  }

  // Check explicit encryption tags in public note kinds
  if (Array.isArray(event.tags)) {
    for (const tag of event.tags) {
      if (!Array.isArray(tag) || tag.length < 1) continue;
      const tagKey = tag[0]?.toLowerCase();
      const tagVal = tag[1]?.toLowerCase() || '';
      if (
        tagKey === 'encrypted' ||
        (tagKey === 'encoding' && (tagVal === 'nip04' || tagVal === 'nip44'))
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Checks whether a public note kind contains monolithic raw binary/base64/hex data dumps or app data dumps.
 */
export function isRawBinaryOrAppBlob(event: NostrEvent): boolean {
  if (!PUBLIC_TEXT_KINDS.has(event.kind)) {
    return false;
  }

  const content = (event.content || '').trim();
  if (!content) {
    return false;
  }

  // Monolithic data URIs embedded directly in notes
  if (
    content.startsWith('data:application/') ||
    content.startsWith('data:image/') ||
    content.startsWith('data:video/') ||
    content.startsWith('data:audio/')
  ) {
    if (content.includes(';base64,') && content.length > 200) {
      return true;
    }
  }

  // Monolithic continuous base64 string (>300 chars, no whitespace or line breaks)
  if (content.length > 300 && !/\s/.test(content)) {
    if (/^[A-Za-z0-9+/=]{300,}$/.test(content)) {
      return true;
    }
  }

  // Monolithic continuous hex string (>256 chars, no whitespace)
  if (content.length > 256 && !/\s/.test(content)) {
    if (/^[0-9a-fA-F]{256,}$/.test(content)) {
      return true;
    }
  }

  // App data state dumps in Kind 1
  if (content.startsWith('{') && content.endsWith('}')) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed === 'object' && parsed !== null) {
        if (
          'app_data' in parsed ||
          'app_state' in parsed ||
          'db_dump' in parsed ||
          'sqlite_dump' in parsed
        ) {
          return true;
        }
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  return false;
}

/**
 * Inspects whether an event conforms to cache relay storage/recording policy.
 */
export function inspectEventStoragePolicy(event: NostrEvent): StoragePolicyResult {
  if (isChunkOrPacketProtocol(event)) {
    return {
      recordable: false,
      reason: 'unrecordable: chunked binary file or packet transfer protocol',
      classification: 'chunk_file_protocol',
    };
  }

  if (isEncryptedPayloadInPublicKind(event)) {
    return {
      recordable: false,
      reason: 'unrecordable: encrypted payload in public note kind',
      classification: 'encrypted_public_kind',
    };
  }

  if (isRawBinaryOrAppBlob(event)) {
    return {
      recordable: false,
      reason: 'unrecordable: raw binary, data URI, or application state dump',
      classification: 'raw_binary_blob',
    };
  }

  return {
    recordable: true,
    classification: 'standard_event',
  };
}

/**
 * Convenience helper to determine if an event should be recorded in persistent cache storage (D1/KV/Vectorize).
 */
export function isRecordableEvent(event: NostrEvent): boolean {
  return inspectEventStoragePolicy(event).recordable;
}
