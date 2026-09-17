import { isHex, verifyEventCrypto } from '../crypto/validator';
import type { NostrEvent, ValidationResult } from '../types/nostr';

export interface ValidationLimits {
  /** Maximum number of tags allowed per event (default: 100) */
  maxEventTags?: number;
  /** Maximum character length for event content (default: 65536) */
  maxContentLength?: number;
  /** Maximum allowed future timestamp skew in seconds (default: 900 / 15 mins) */
  maxFutureSkewSeconds?: number;
  /** Maximum character length per tag item (default: 1024) */
  maxTagItemLength?: number;
}

export const DEFAULT_VALIDATION_LIMITS: Required<ValidationLimits> = {
  maxEventTags: 100,
  maxContentLength: 65536,
  maxFutureSkewSeconds: 900,
  maxTagItemLength: 1024,
};

/**
 * Validates the structural integrity of a candidate Nostr event.
 */
export function validateEventStructure(
  candidate: unknown,
  customLimits?: ValidationLimits,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): ValidationResult {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { valid: false, reason: 'Event must be a JSON object' };
  }

  const limits = { ...DEFAULT_VALIDATION_LIMITS, ...customLimits };
  const e = candidate as Record<string, unknown>;

  if (typeof e.id !== 'string' || !isHex(e.id, 64)) {
    return { valid: false, reason: 'Invalid or missing "id": must be a 64-character hex string' };
  }

  if (typeof e.pubkey !== 'string' || !isHex(e.pubkey, 64)) {
    return { valid: false, reason: 'Invalid or missing "pubkey": must be a 64-character hex string' };
  }

  if (typeof e.created_at !== 'number' || !Number.isInteger(e.created_at) || e.created_at < 0) {
    return { valid: false, reason: 'Invalid or missing "created_at": must be a non-negative integer' };
  }

  // Reject events too far in the future
  if (e.created_at > nowSeconds + limits.maxFutureSkewSeconds) {
    return {
      valid: false,
      reason: `Event "created_at" is too far in the future (max drift: ${limits.maxFutureSkewSeconds}s)`,
    };
  }

  if (typeof e.kind !== 'number' || !Number.isInteger(e.kind) || e.kind < 0) {
    return { valid: false, reason: 'Invalid or missing "kind": must be a non-negative integer' };
  }

  if (!Array.isArray(e.tags)) {
    return { valid: false, reason: 'Invalid or missing "tags": must be an array' };
  }

  if (e.tags.length > limits.maxEventTags) {
    return {
      valid: false,
      reason: `Event exceeds maximum allowed tags count of ${limits.maxEventTags}`,
    };
  }

  for (let i = 0; i < e.tags.length; i++) {
    const tag = e.tags[i];
    if (!Array.isArray(tag)) {
      return { valid: false, reason: `Tag at index ${i} must be an array of strings` };
    }
    for (let j = 0; j < tag.length; j++) {
      if (typeof tag[j] !== 'string') {
        return { valid: false, reason: `Tag element at index [${i}][${j}] must be a string` };
      }
      if ((tag[j] as string).length > limits.maxTagItemLength) {
        return {
          valid: false,
          reason: `Tag element at index [${i}][${j}] exceeds maximum length of ${limits.maxTagItemLength}`,
        };
      }
    }
  }

  if (typeof e.content !== 'string') {
    return { valid: false, reason: 'Invalid or missing "content": must be a string' };
  }

  if (e.content.length > limits.maxContentLength) {
    return {
      valid: false,
      reason: `Event content exceeds maximum allowed length of ${limits.maxContentLength} characters`,
    };
  }

  if (typeof e.sig !== 'string' || !isHex(e.sig, 128)) {
    return { valid: false, reason: 'Invalid or missing "sig": must be a 128-character hex string' };
  }

  return { valid: true };
}

/**
 * Validates a NIP-01 subscription filter object.
 */
export function validateFilter(candidate: unknown): ValidationResult {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return { valid: false, reason: 'Filter must be a JSON object' };
  }

  const f = candidate as Record<string, unknown>;

  if (f.ids !== undefined) {
    if (!Array.isArray(f.ids) || !f.ids.every((id) => typeof id === 'string' && isHex(id))) {
      return { valid: false, reason: 'Filter "ids" must be an array of hexadecimal strings' };
    }
  }

  if (f.authors !== undefined) {
    if (!Array.isArray(f.authors) || !f.authors.every((a) => typeof a === 'string' && isHex(a))) {
      return { valid: false, reason: 'Filter "authors" must be an array of hexadecimal strings' };
    }
  }

  if (f.kinds !== undefined) {
    if (!Array.isArray(f.kinds) || !f.kinds.every((k) => typeof k === 'number' && Number.isInteger(k) && k >= 0)) {
      return { valid: false, reason: 'Filter "kinds" must be an array of non-negative integers' };
    }
  }

  if (f.since !== undefined) {
    if (typeof f.since !== 'number' || !Number.isInteger(f.since) || f.since < 0) {
      return { valid: false, reason: 'Filter "since" must be a non-negative integer' };
    }
  }

  if (f.until !== undefined) {
    if (typeof f.until !== 'number' || !Number.isInteger(f.until) || f.until < 0) {
      return { valid: false, reason: 'Filter "until" must be a non-negative integer' };
    }
  }

  if (f.limit !== undefined) {
    if (typeof f.limit !== 'number' || !Number.isInteger(f.limit) || f.limit < 0) {
      return { valid: false, reason: 'Filter "limit" must be a non-negative integer' };
    }
  }

  if (f.search !== undefined) {
    if (typeof f.search !== 'string') {
      return { valid: false, reason: 'Filter "search" must be a string' };
    }
  }

  // Validate tag query fields: e.g. "#e", "#p", "#d"
  for (const [key, val] of Object.entries(f)) {
    if (key.startsWith('#')) {
      if (!Array.isArray(val) || !val.every((item) => typeof item === 'string')) {
        return { valid: false, reason: `Filter tag query "${key}" must be an array of strings` };
      }
    }
  }

  return { valid: true };
}

/**
 * Performs full validation of a Nostr event:
 * 1. Structural schema validation.
 * 2. Cryptographic ID and BIP-340 signature verification.
 */
export function validateEvent(
  candidate: unknown,
  customLimits?: ValidationLimits,
  nowSeconds?: number
): ValidationResult {
  const structureResult = validateEventStructure(candidate, customLimits, nowSeconds);
  if (!structureResult.valid) {
    return structureResult;
  }

  return verifyEventCrypto(candidate as NostrEvent);
}
