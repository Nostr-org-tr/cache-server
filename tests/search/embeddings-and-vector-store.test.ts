import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EMBEDDING_MODEL,
  extractSearchableText,
  generateEmbeddings,
  isSubstantiveText,
} from '../../src/search/embeddings';
import { buildNjumpUrl, extractAuthorMetadata } from '../../src/search/engine';
import {
  deleteEventVectors,
  indexEventsBatchVector,
  indexEventVector,
  queryVectorIndex,
  upsertVectorsWithRetry,
} from '../../src/search/vector-store';
import type { NostrEvent } from '../../src/types/nostr';

describe('Search Embeddings & Vector Store', () => {
  const dummyPubkey = '46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a';
  const dummyId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  describe('isSubstantiveText', () => {
    it('returns true for substantive text with letters and digits', () => {
      expect(isSubstantiveText('Hello Nostr world! Decentralized relay.')).toBe(true);
      expect(isSubstantiveText('Lightning network payment settled in 2s')).toBe(true);
      expect(isSubstantiveText('Check out this photo: https://image.nostr.build/123.jpg')).toBe(true);
    });

    it('returns false for pure image and media URLs', () => {
      expect(isSubstantiveText('https://image.nostr.build/12345.jpg')).toBe(false);
      expect(isSubstantiveText('https://image.nostr.build/123.jpg https://nostr.build/456.png')).toBe(false);
      expect(isSubstantiveText('http://example.com/video.mp4')).toBe(false);
    });

    it('returns false for pure nostr URI references', () => {
      expect(isSubstantiveText('nostr:nevent1qqs234892374982374982374982374')).toBe(false);
      expect(isSubstantiveText('nostr:note1z978yjh987yhj987yhj987y')).toBe(false);
      expect(isSubstantiveText('nostr:npub1234567890abcdef')).toBe(false);
    });

    it('returns false for ultra-short or emoji/symbol-only text', () => {
      expect(isSubstantiveText('gm')).toBe(false);
      expect(isSubstantiveText('gn')).toBe(false);
      expect(isSubstantiveText('⚡')).toBe(false);
      expect(isSubstantiveText('👍👍👍')).toBe(false);
      expect(isSubstantiveText('  !  ')).toBe(false);
      expect(isSubstantiveText('')).toBe(false);
    });
  });

  describe('extractSearchableText', () => {
    it('extracts structured text from Kind 0 metadata profile', () => {
      const event: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 0,
        tags: [],
        content: JSON.stringify({
          name: 'alice',
          display_name: 'Alice Nostr',
          about: 'Building decentralized protocols on Nostr.',
          nip05: 'alice@nostr.org.tr',
        }),
        sig: 'f'.repeat(128),
      };

      const extracted = extractSearchableText(event);
      expect(extracted).toContain('Display Name: Alice Nostr');
      expect(extracted).toContain('Name: alice');
      expect(extracted).toContain('About: Building decentralized protocols on Nostr.');
      expect(extracted).toContain('NIP-05: alice@nostr.org.tr');
    });

    it('returns null for empty or non-substantive Kind 0 metadata profile', () => {
      const emptyEvent: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 0,
        tags: [],
        content: JSON.stringify({ name: '', display_name: '', about: '' }),
        sig: 'f'.repeat(128),
      };

      expect(extractSearchableText(emptyEvent)).toBeNull();
    });

    it('extracts content from Kind 1 short note with substantive text', () => {
      const event: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: 'Hello Nostr world! Lightning network payments are fast.',
        sig: 'f'.repeat(128),
      };

      const extracted = extractSearchableText(event);
      expect(extracted).toBe('Hello Nostr world! Lightning network payments are fast.');
    });

    it('returns null for image-only or low-quality Kind 1 notes', () => {
      const imageNote: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: 'https://image.nostr.build/a1b2c3d4e5f6.jpg',
        sig: 'f'.repeat(128),
      };

      const gmNote: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: 'gm ⚡',
        sig: 'f'.repeat(128),
      };

      expect(extractSearchableText(imageNote)).toBeNull();
      expect(extractSearchableText(gmNote)).toBeNull();
    });

    it('extracts title, summary, and content from Kind 30023 article', () => {
      const event: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 30023,
        tags: [
          ['d', 'nostr-guide'],
          ['title', 'Comprehensive Guide to Nostr'],
          ['summary', 'An overview of NIP protocols and relays'],
        ],
        content: '# Chapter 1\nRelays and Clients communication.',
        sig: 'f'.repeat(128),
      };

      const extracted = extractSearchableText(event);
      expect(extracted).toContain('Title: Comprehensive Guide to Nostr');
      expect(extracted).toContain('Summary: An overview of NIP protocols and relays');
      expect(extracted).toContain('Content: # Chapter 1\nRelays and Clients communication.');
    });

    it('extracts content and context from Kind 9802 highlight', () => {
      const event: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 9802,
        tags: [['context', 'Decentralized Nostr architecture']],
        content: 'Decentralization enables censorship resistance across relays.',
        sig: 'f'.repeat(128),
      };

      const extracted = extractSearchableText(event);
      expect(extracted).toContain('Highlight: Decentralization enables censorship resistance across relays.');
      expect(extracted).toContain('Context: Decentralized Nostr architecture');
    });

    it('returns null for ephemeral events (Kind 20000..29999)', () => {
      const event: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 22242,
        tags: [],
        content: 'ephemeral ping',
        sig: 'f'.repeat(128),
      };

      expect(extractSearchableText(event)).toBeNull();
    });
  });

  describe('buildNjumpUrl & author metadata', () => {
    it('builds valid njump URL for kind 0 profile', () => {
      const event: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 0,
        tags: [],
        content: JSON.stringify({ name: 'alice' }),
        sig: 'f'.repeat(128),
      };

      const url = buildNjumpUrl(event);
      expect(url).toMatch(/^https:\/\/njump\.me\/npub1/);
    });

    it('builds valid njump URL for kind 1 note', () => {
      const event: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: 'test note',
        sig: 'f'.repeat(128),
      };

      const url = buildNjumpUrl(event);
      expect(url).toMatch(/^https:\/\/njump\.me\/note1/);
    });

    it('extracts author metadata correctly', () => {
      const event: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 0,
        tags: [],
        content: JSON.stringify({
          name: 'bob',
          display_name: 'Bob Marley',
          nip05: 'bob@example.com',
          picture: 'https://example.com/pic.jpg',
        }),
        sig: 'f'.repeat(128),
      };

      const author = extractAuthorMetadata(event);
      expect(author.name).toBe('bob');
      expect(author.displayName).toBe('Bob Marley');
      expect(author.nip05).toBe('bob@example.com');
      expect(author.picture).toBe('https://example.com/pic.jpg');
    });
  });

  describe('Vectorize Operations with Mocked AI & Index', () => {
    it('generates embeddings via Workers AI', async () => {
      const mockVector = [0.12, 0.34, 0.56];
      const mockAi = {
        run: vi.fn().mockResolvedValue({ data: [mockVector] }),
      } as unknown as Ai;

      const embeddings = await generateEmbeddings(mockAi, ['test text']);
      expect(embeddings).toEqual([mockVector]);
      expect(mockAi.run).toHaveBeenCalledWith(DEFAULT_EMBEDDING_MODEL, {
        text: ['test text'],
      });
    });

    it('indexes single event in Vectorize', async () => {
      const mockVector = [0.1, 0.2, 0.3];
      const mockAi = {
        run: vi.fn().mockResolvedValue({ data: [mockVector] }),
      } as unknown as Ai;
      const mockVectorIndex = {
        upsert: vi.fn().mockResolvedValue({ count: 1 }),
      } as unknown as VectorizeIndex;

      const event: NostrEvent = {
        id: dummyId,
        pubkey: dummyPubkey,
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: 'Bitcoin is digital gold',
        sig: 'f'.repeat(128),
      };

      const success = await indexEventVector(mockAi, mockVectorIndex, event);
      expect(success).toBe(true);
      expect(mockVectorIndex.upsert).toHaveBeenCalledWith([
        {
          id: dummyId,
          values: mockVector,
          metadata: {
            kind: 1,
            pubkey: dummyPubkey,
            created_at: 1700000000,
          },
        },
      ]);
    });

    it('batch indexes multiple events in Vectorize', async () => {
      const mockVectors = [[0.1, 0.2], [0.3, 0.4]];
      const mockAi = {
        run: vi.fn().mockResolvedValue({ data: mockVectors }),
      } as unknown as Ai;
      const mockVectorIndex = {
        upsert: vi.fn().mockResolvedValue({ count: 2 }),
      } as unknown as VectorizeIndex;

      const events: NostrEvent[] = [
        {
          id: dummyId,
          pubkey: dummyPubkey,
          created_at: 1700000000,
          kind: 1,
          tags: [],
          content: 'First substantive decentralized note',
          sig: 'f'.repeat(128),
        },
        {
          id: 'b'.repeat(64),
          pubkey: dummyPubkey,
          created_at: 1700000001,
          kind: 1,
          tags: [],
          content: 'Second substantive decentralized note',
          sig: 'f'.repeat(128),
        },
      ];

      const count = await indexEventsBatchVector(mockAi, mockVectorIndex, events);
      expect(count).toBe(2);
      expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);
    });

    it('batch indexes valid events while skipping low quality and image events', async () => {
      const mockVector = [[0.1, 0.2]];
      const mockAi = {
        run: vi.fn().mockResolvedValue({ data: mockVector }),
      } as unknown as Ai;
      const mockVectorIndex = {
        upsert: vi.fn().mockResolvedValue({ count: 1 }),
      } as unknown as VectorizeIndex;

      const events: NostrEvent[] = [
        {
          id: '1'.repeat(64),
          pubkey: dummyPubkey,
          created_at: 1700000000,
          kind: 1,
          tags: [],
          content: 'https://image.nostr.build/test.png', // skipped (image only)
          sig: 'f'.repeat(128),
        },
        {
          id: '2'.repeat(64),
          pubkey: dummyPubkey,
          created_at: 1700000001,
          kind: 1,
          tags: [],
          content: 'gm', // skipped (too short)
          sig: 'f'.repeat(128),
        },
        {
          id: '3'.repeat(64),
          pubkey: dummyPubkey,
          created_at: 1700000002,
          kind: 1,
          tags: [],
          content: 'Substantive note about Nostr censorship resistance', // indexed
          sig: 'f'.repeat(128),
        },
      ];

      const count = await indexEventsBatchVector(mockAi, mockVectorIndex, events);
      expect(count).toBe(1);
      expect(mockVectorIndex.upsert).toHaveBeenCalledWith([
        {
          id: '3'.repeat(64),
          values: [0.1, 0.2],
          metadata: {
            kind: 1,
            pubkey: dummyPubkey,
            created_at: 1700000002,
          },
        },
      ]);
    });

    it('deletes event vectors by ID', async () => {
      const mockVectorIndex = {
        deleteByIds: vi.fn().mockResolvedValue({ count: 2 }),
      } as unknown as VectorizeIndex;

      await deleteEventVectors(mockVectorIndex, [dummyId, 'b'.repeat(64)]);
      expect(mockVectorIndex.deleteByIds).toHaveBeenCalledWith([dummyId, 'b'.repeat(64)]);
    });

    it('queries Vectorize and returns matches sorted by score descending', async () => {
      const mockVector = [0.1, 0.2, 0.3];
      const mockAi = {
        run: vi.fn().mockResolvedValue({ data: [mockVector] }),
      } as unknown as Ai;
      const mockVectorIndex = {
        query: vi.fn().mockResolvedValue({
          count: 2,
          matches: [
            { id: 'id-lower-score', score: 0.72 },
            { id: 'id-higher-score', score: 0.94 },
          ],
        }),
      } as unknown as VectorizeIndex;

      const results = await queryVectorIndex(mockAi, mockVectorIndex, 'bitcoin', 10);
      expect(results.length).toBe(2);
      // Higher score must be first
      expect(results[0]?.id).toBe('id-higher-score');
      expect(results[0]?.score).toBe(0.94);
      expect(results[1]?.id).toBe('id-lower-score');
      expect(results[1]?.score).toBe(0.72);
    });

    it('retries on Vectorize rate limit error (40041 / Too Many Requests) and succeeds', async () => {
      const mockVectorIndex = {
        upsert: vi
          .fn()
          .mockRejectedValueOnce(new Error('VECTOR_UPSERT_ERROR (code = 40041): Too Many Requests'))
          .mockResolvedValueOnce({ count: 1 }),
      } as unknown as VectorizeIndex;

      const vectors = [{ id: 'test-id', values: [0.1, 0.2], metadata: { kind: 1 } }];
      await expect(upsertVectorsWithRetry(mockVectorIndex, vectors, 1)).resolves.toBeUndefined();
      expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(2);
    });

    it('throws error when non-rate-limit error occurs in upsert', async () => {
      const mockVectorIndex = {
        upsert: vi.fn().mockRejectedValueOnce(new Error('FATAL_DATABASE_ERROR')),
      } as unknown as VectorizeIndex;

      const vectors = [{ id: 'test-id', values: [0.1, 0.2], metadata: { kind: 1 } }];
      await expect(upsertVectorsWithRetry(mockVectorIndex, vectors, 1)).rejects.toThrow('FATAL_DATABASE_ERROR');
      expect(mockVectorIndex.upsert).toHaveBeenCalledTimes(1);
    });
  });
});
