import { describe, it, expect } from 'vitest';
import { validateEventStructure, validateFilter } from '../../src/protocol/validator';

describe('Event & Filter Validator', () => {
  const validEvent = {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1700000000,
    kind: 1,
    tags: [['e', 'c'.repeat(64)], ['p', 'd'.repeat(64)]],
    content: 'Testing validator',
    sig: 'e'.repeat(128),
  };

  describe('Event Structure Validation', () => {
    it('approves structurally valid Nostr event', () => {
      const result = validateEventStructure(validEvent);
      expect(result.valid).toBe(true);
    });

    it('rejects event with non-hex ID or wrong length', () => {
      const resultShort = validateEventStructure({ ...validEvent, id: '1234' });
      expect(resultShort.valid).toBe(false);

      const resultNonHex = validateEventStructure({ ...validEvent, id: 'z'.repeat(64) });
      expect(resultNonHex.valid).toBe(false);
    });

    it('rejects event with negative timestamp or float kind', () => {
      const resultTimestamp = validateEventStructure({ ...validEvent, created_at: -10 });
      expect(resultTimestamp.valid).toBe(false);

      const resultKind = validateEventStructure({ ...validEvent, kind: 1.5 });
      expect(resultKind.valid).toBe(false);
    });

    it('rejects event with malformed tags', () => {
      const resultTagNotArray = validateEventStructure({ ...validEvent, tags: 'not-an-array' });
      expect(resultTagNotArray.valid).toBe(false);

      const resultTagElementNotString = validateEventStructure({
        ...validEvent,
        tags: [['e', 12345]],
      });
      expect(resultTagElementNotString.valid).toBe(false);
    });

    it('rejects non-object inputs', () => {
      expect(validateEventStructure(null).valid).toBe(false);
      expect(validateEventStructure(undefined).valid).toBe(false);
      expect(validateEventStructure('string').valid).toBe(false);
      expect(validateEventStructure([]).valid).toBe(false);
    });
  });

  describe('Filter Validation', () => {
    it('approves valid Nostr filters', () => {
      const filter1 = {
        ids: ['a'.repeat(64), 'b'.repeat(16)],
        authors: ['c'.repeat(64)],
        kinds: [0, 1, 30023],
        since: 1700000000,
        until: 1700100000,
        limit: 100,
        '#e': ['d'.repeat(64)],
        '#p': ['e'.repeat(64)],
        '#d': ['my-identifier'],
      };

      const result = validateFilter(filter1);
      expect(result.valid).toBe(true);
    });

    it('rejects filter with non-hex ids or authors', () => {
      const resultId = validateFilter({ ids: ['xyz123'] });
      expect(resultId.valid).toBe(false);

      const resultAuthor = validateFilter({ authors: ['not_hex'] });
      expect(resultAuthor.valid).toBe(false);
    });

    it('rejects filter with negative bounds', () => {
      expect(validateFilter({ since: -1 }).valid).toBe(false);
      expect(validateFilter({ until: -5 }).valid).toBe(false);
      expect(validateFilter({ limit: -10 }).valid).toBe(false);
      expect(validateFilter({ kinds: [-1] }).valid).toBe(false);
    });

    it('rejects invalid tag query values', () => {
      const result = validateFilter({ '#e': [123] });
      expect(result.valid).toBe(false);
    });
  });
});
