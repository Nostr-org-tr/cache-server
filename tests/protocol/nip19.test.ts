import { describe, expect, it } from 'vitest';
import {
  decodeNpub,
  encodeBech32,
  encodeNpub,
  shortenNpub,
} from '../../src/protocol/nip19';

describe('NIP-19 npub encoding & decoding', () => {
  // Jack Dorsey's well-known Nostr pubkey
  const JACK_HEX = '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2';
  const JACK_NPUB = 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m';

  // Fiatjaf's well-known Nostr pubkey
  const FIATJAF_HEX = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d';
  const FIATJAF_NPUB = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6';

  // Zeroed pubkey
  const ZERO_HEX = '0000000000000000000000000000000000000000000000000000000000000000';

  it('encodes Jack Dorsey hex pubkey to correct npub', () => {
    const npub = encodeNpub(JACK_HEX);
    expect(npub).toBe(JACK_NPUB);
  });

  it('decodes Jack Dorsey npub back to exact hex pubkey', () => {
    const hex = decodeNpub(JACK_NPUB);
    expect(hex).toBe(JACK_HEX);
  });

  it('encodes Fiatjaf hex pubkey to correct npub', () => {
    const npub = encodeNpub(FIATJAF_HEX);
    expect(npub).toBe(FIATJAF_NPUB);
  });

  it('decodes Fiatjaf npub back to exact hex pubkey', () => {
    const hex = decodeNpub(FIATJAF_NPUB);
    expect(hex).toBe(FIATJAF_HEX);
  });

  it('roundtrips zeroed pubkey', () => {
    const npub = encodeNpub(ZERO_HEX);
    expect(npub.startsWith('npub1')).toBe(true);
    expect(decodeNpub(npub)).toBe(ZERO_HEX);
  });

  it('returns normalized lowercase npub when input is already a valid npub', () => {
    expect(encodeNpub(JACK_NPUB)).toBe(JACK_NPUB);
    expect(encodeNpub(JACK_NPUB.toUpperCase())).toBe(JACK_NPUB);
  });

  it('rejects invalid hex public keys', () => {
    expect(() => encodeNpub('1234')).toThrow(/Invalid hex public key/);
    expect(() => encodeNpub('g'.repeat(64))).toThrow(/Invalid hex public key/);
    expect(() => encodeNpub('')).toThrow(/Invalid hex public key/);
    // @ts-expect-error test runtime validation
    expect(() => encodeNpub(null)).toThrow(/must be a string/);
  });

  it('rejects invalid npub strings', () => {
    const noteBech32 = encodeBech32('note', new Uint8Array(32));
    expect(() => decodeNpub(noteBech32)).toThrow(/Invalid HRP/);
    expect(() => decodeNpub('npub1invalidchecksum0000000000000000000000000000000000000000000000')).toThrow(/Invalid Bech32/);
    expect(() => decodeNpub('npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63M')).toThrow(/Mixed-case/);
  });

  it('shortens npub accurately', () => {
    const shortened = shortenNpub(JACK_HEX);
    expect(shortened).toBe('npub1sg6pl…0uf63m');
    expect(shortened.startsWith('npub1')).toBe(true);
  });

  it('shortens existing npub string directly', () => {
    const shortened = shortenNpub(JACK_NPUB, 10, 6);
    expect(shortened).toBe('npub1sg6pl…0uf63m');
  });

  it('handles invalid or non-hex string gracefully in shortenNpub', () => {
    expect(shortenNpub('short')).toBe('short');
    expect(shortenNpub('')).toBe('');
    expect(shortenNpub('invalid_long_string_that_is_not_hex_or_npub_1234567890')).toContain('…');
  });
});
