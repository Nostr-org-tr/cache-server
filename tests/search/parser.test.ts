import { describe, expect, it } from 'vitest';
import { parseNip50Search } from '../../src/search/parser';

describe('NIP-50 Search Query Parser', () => {
  it('parses pure text query correctly without extensions', () => {
    const result = parseNip50Search('bitcoin lightning network');
    expect(result.rawQuery).toBe('bitcoin lightning network');
    expect(result.cleanQuery).toBe('bitcoin lightning network');
    expect(result.extensions).toEqual({});
  });

  it('handles empty and whitespace-only queries gracefully', () => {
    expect(parseNip50Search('')).toEqual({
      rawQuery: '',
      cleanQuery: '',
      extensions: {},
    });
    expect(parseNip50Search('   ')).toEqual({
      rawQuery: '',
      cleanQuery: '',
      extensions: {},
    });
  });

  it('extracts include:spam flag correctly', () => {
    const result = parseNip50Search('nostr relay include:spam');
    expect(result.cleanQuery).toBe('nostr relay');
    expect(result.extensions.includeSpam).toBe(true);
  });

  it('extracts domain:<domain> extension correctly', () => {
    const result = parseNip50Search('wallets domain:nostr.org.tr');
    expect(result.cleanQuery).toBe('wallets');
    expect(result.extensions.domain).toBe('nostr.org.tr');
  });

  it('extracts language:<iso> extension correctly', () => {
    const result = parseNip50Search('haberler language:tr');
    expect(result.cleanQuery).toBe('haberler');
    expect(result.extensions.language).toBe('tr');

    const result2 = parseNip50Search('news lang:en');
    expect(result2.cleanQuery).toBe('news');
    expect(result2.extensions.language).toBe('en');
  });

  it('extracts sentiment extension correctly', () => {
    const pos = parseNip50Search('bullish sentiment:positive');
    expect(pos.cleanQuery).toBe('bullish');
    expect(pos.extensions.sentiment).toBe('positive');

    const neg = parseNip50Search('bearish sentiment:negative');
    expect(neg.cleanQuery).toBe('bearish');
    expect(neg.extensions.sentiment).toBe('negative');

    const neu = parseNip50Search('market sentiment:neutral');
    expect(neu.cleanQuery).toBe('market');
    expect(neu.extensions.sentiment).toBe('neutral');
  });

  it('extracts nsfw extension correctly', () => {
    const nsfwTrue = parseNip50Search('art nsfw:true');
    expect(nsfwTrue.cleanQuery).toBe('art');
    expect(nsfwTrue.extensions.nsfw).toBe(true);

    const nsfwFalse = parseNip50Search('family photos nsfw:false');
    expect(nsfwFalse.cleanQuery).toBe('family photos');
    expect(nsfwFalse.extensions.nsfw).toBe(false);
  });

  it('safely ignores unknown extensions while preserving text query per NIP-50', () => {
    const result = parseNip50Search('awesome apps custom:filter unknown:123');
    expect(result.cleanQuery).toBe('awesome apps');
    expect(result.extensions).toEqual({});
  });

  it('parses complex combined query with multiple extensions', () => {
    const query = 'decentralized social language:en domain:damus.io nsfw:false include:spam';
    const result = parseNip50Search(query);
    expect(result.cleanQuery).toBe('decentralized social');
    expect(result.extensions).toEqual({
      language: 'en',
      domain: 'damus.io',
      nsfw: false,
      includeSpam: true,
    });
  });
});
