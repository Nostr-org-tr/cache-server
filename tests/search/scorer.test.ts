import { describe, expect, it } from 'vitest';
import {
  calibrateVectorScore,
  computeHybridScore,
  computeLexicalScore,
  getEventSearchableFields,
  VECTOR_NOISE_FLOOR,
} from '../../src/search/scorer';
import type { NostrEvent } from '../../src/types/nostr';

describe('Search Relevance Scorer & Calibration', () => {
  const dummyPubkey = '46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a';
  const dummyId = 'cf86126a74f8191b6d042eb7fe2cd976f0646ab04218c05c75cdd4f698d694ac';

  const emreProfileEvent: NostrEvent = {
    id: dummyId,
    pubkey: dummyPubkey,
    created_at: 1789987053,
    kind: 0,
    tags: [
      ['client', 'Ditto'],
      ['published_at', '1789987053'],
    ],
    content: JSON.stringify({
      about: "I am a veteran Full-Stack Engineer, Open Source Contributor, and Web Generalist.\nBuilding Nostr tools:\n- https://nostr.emre.xyz\n- https://photo.emre.xyz\n- https://snips.emre.xyz\n- https://nostr.org.tr\n- https://rehber.dev",
      banner: 'https://media.nostr.org.tr/banner.jpg',
      display_name: 'Emre Yilmaz',
      lud16: 'delirehberi@emre.xyz',
      name: 'delirehberi',
      nip05: 'delirehberi@emre.xyz',
      picture: 'https://emre.xyz/me.jpg',
      website: 'https://emre.xyz',
      bot: false,
    }),
    sig: '557fb121e3ac5eb6815776c05ee4e800ef470692783cae1f1320d81658f6363873e333ad7507d16e1f29e9d0cad4d0a43ddd50aa53f74217935c72870d87cb31',
  };

  const cringeNoteEvent: NostrEvent = {
    id: '548adce3286af7d10af757f5c50e8e65a020bb6f9c07069857b02da1eb86bb84',
    pubkey: '32e1827635450ebb3c5a7d12c1f8e7b2b514439ac10a67eef3d9fd9c5c68e245',
    created_at: 1790176920,
    kind: 1,
    tags: [
      ['client', 'Damus Notedeck'],
      ['e', '3f7140b087a56945ec39114162eded977b0c478298cf17b99c3137beb6255de7', '', 'root'],
    ],
    content: 'ur cringe',
    sig: 'b0e87f0039216d430bdba99e93f99260fc9838ffaefb1aa9f9b2e9d1f93b703be19786ec96cf09c69f208cf801542448480aa908c5f0aae5c0a097a0ce044014',
  };

  describe('getEventSearchableFields', () => {
    it('extracts primary and secondary fields for Kind 0', () => {
      const fields = getEventSearchableFields(emreProfileEvent);
      expect(fields.primaryFields).toContain('Emre Yilmaz');
      expect(fields.primaryFields).toContain('delirehberi');
      expect(fields.primaryFields).toContain('delirehberi@emre.xyz');
      expect(fields.secondaryFields).toEqual(
        expect.arrayContaining([expect.stringContaining('veteran Full-Stack Engineer')])
      );
    });

    it('extracts primary fields for Kind 1 note', () => {
      const fields = getEventSearchableFields(cringeNoteEvent);
      expect(fields.primaryFields).toEqual(['ur cringe']);
      expect(fields.secondaryFields).toEqual([]);
    });

    it('extracts title and summary as primary fields for Kind 30023 article', () => {
      const articleEvent: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 30023,
        tags: [
          ['title', 'Building Nostr Relays with TypeScript'],
          ['summary', 'Deep dive into Cloudflare D1 and Durable Objects architecture.'],
          ['t', 'nostr'],
        ],
        content: '# Introduction\nNostr is an open protocol.',
        sig: 'f'.repeat(128),
      };

      const fields = getEventSearchableFields(articleEvent);
      expect(fields.primaryFields).toContain('Building Nostr Relays with TypeScript');
      expect(fields.primaryFields).toContain('Deep dive into Cloudflare D1 and Durable Objects architecture.');
      expect(fields.primaryFields).toContain('nostr');
      expect(fields.secondaryFields).toContain('# Introduction\nNostr is an open protocol.');
    });
  });

  describe('computeLexicalScore', () => {
    it('returns near-perfect match (>= 0.95) when query matches Kind 0 display_name', () => {
      const score = computeLexicalScore(emreProfileEvent, 'emre');
      expect(score).toBeGreaterThanOrEqual(0.95);
    });

    it('returns perfect 1.0 match when query exactly equals field', () => {
      const score = computeLexicalScore(emreProfileEvent, 'delirehberi');
      expect(score).toBe(1.0);
    });

    it('returns 0 when query terms are completely absent', () => {
      const score = computeLexicalScore(cringeNoteEvent, 'emre');
      expect(score).toBe(0);
    });

    it('scores multi-word queries proportionally', () => {
      const score = computeLexicalScore(emreProfileEvent, 'emre full-stack');
      expect(score).toBeGreaterThanOrEqual(0.85);
    });
  });

  describe('calibrateVectorScore', () => {
    it('returns 0 for vector scores at or below the noise floor (<= 0.55)', () => {
      expect(calibrateVectorScore(0.42)).toBe(0);
      expect(calibrateVectorScore(0.43)).toBe(0);
      expect(calibrateVectorScore(VECTOR_NOISE_FLOOR)).toBe(0);
    });

    it('scales linearly for vector scores above the noise floor', () => {
      const calibrated075 = calibrateVectorScore(0.775); // midpoint of 0.55 .. 1.0 is 0.775
      expect(calibrated075).toBeCloseTo(0.5, 1);

      const calibrated100 = calibrateVectorScore(1.0);
      expect(calibrated100).toBe(1.0);
    });
  });

  describe('computeHybridScore (End-to-End User Scenario)', () => {
    it('ranks Emre Yilmaz profile with high score and completely filters out "ur cringe"', () => {
      // User case: query "emre"
      // Emre profile: vector score was diluted to 0.42, but has exact lexical match
      const emreScore = computeHybridScore(emreProfileEvent, 'emre', 0.42);
      expect(emreScore).toBeGreaterThanOrEqual(0.95); // ~95% match

      // Cringe note: vector score was 0.43 (below pure semantic cutoff 0.62), has 0 lexical match
      const cringeScore = computeHybridScore(cringeNoteEvent, 'emre', 0.43);
      expect(cringeScore).toBe(0); // 0% match / dropped!
    });

    it('allows strong pure semantic matches without lexical overlap if above threshold', () => {
      const noteEvent: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: 'Decentralized distributed ledger network with lightning fast settlement',
        sig: 'f'.repeat(128),
      };

      // Semantic query "bitcoin scaling" with strong vector similarity 0.85 (above 0.62 threshold)
      const score = computeHybridScore(noteEvent, 'bitcoin scaling', 0.85);
      expect(score).toBeGreaterThan(0.5);
    });

    it('combines lexical and semantic scores when both are strong', () => {
      const noteEvent: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: 'Nostr protocol enables censorship-resistant communication across relays.',
        sig: 'f'.repeat(128),
      };

      const score = computeHybridScore(noteEvent, 'nostr protocol', 0.80);
      expect(score).toBeGreaterThanOrEqual(0.90);
    });
  });
});
