import { describe, expect, it } from 'vitest';
import {
  filterValidRelayUrls,
  validateAndNormalizeRelayUrl,
} from '../../src/upstream/url-validator';

describe('Upstream URL Validator & SSRF Guard', () => {
  describe('validateAndNormalizeRelayUrl', () => {
    it('accepts valid public wss:// relay URLs', () => {
      expect(validateAndNormalizeRelayUrl('wss://relay.damus.io')).toBe('wss://relay.damus.io');
      expect(validateAndNormalizeRelayUrl('wss://nos.lol/')).toBe('wss://nos.lol');
      expect(validateAndNormalizeRelayUrl('wss://relay.nostr.band/path')).toBe(
        'wss://relay.nostr.band/path'
      );
      expect(validateAndNormalizeRelayUrl('  wss://eden.nostr.land  ')).toBe(
        'wss://eden.nostr.land'
      );
    });

    it('rejects invalid or empty URL strings', () => {
      expect(validateAndNormalizeRelayUrl('')).toBeNull();
      expect(validateAndNormalizeRelayUrl('not a url')).toBeNull();
      expect(validateAndNormalizeRelayUrl('http://example.com')).toBeNull();
      expect(validateAndNormalizeRelayUrl('https://example.com')).toBeNull();
      expect(validateAndNormalizeRelayUrl('ftp://example.com')).toBeNull();
    });

    it('rejects unencrypted ws:// by default unless explicitly allowed', () => {
      expect(validateAndNormalizeRelayUrl('ws://relay.damus.io')).toBeNull();
      expect(
        validateAndNormalizeRelayUrl('ws://relay.damus.io', { allowInsecureWs: true })
      ).toBe('ws://relay.damus.io');
    });

    it('blocks localhost, .local, and .internal domains (SSRF protection)', () => {
      expect(validateAndNormalizeRelayUrl('wss://localhost')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://sub.localhost')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://my-service.local')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://app.internal')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://metadata.google.internal')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://instance-data')).toBeNull();
    });

    it('blocks private IPv4 addresses (SSRF protection)', () => {
      // Loopback (127.0.0.0/8)
      expect(validateAndNormalizeRelayUrl('wss://127.0.0.1')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://127.0.0.2')).toBeNull();

      // Private Class A (10.0.0.0/8)
      expect(validateAndNormalizeRelayUrl('wss://10.0.0.1')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://10.254.1.1')).toBeNull();

      // Private Class B (172.16.0.0/12)
      expect(validateAndNormalizeRelayUrl('wss://172.16.0.1')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://172.31.255.254')).toBeNull();

      // Private Class C (192.168.0.0/16)
      expect(validateAndNormalizeRelayUrl('wss://192.168.1.1')).toBeNull();

      // Cloud Metadata & Link-Local (169.254.169.254, 169.254.0.0/16)
      expect(validateAndNormalizeRelayUrl('wss://169.254.169.254')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://169.254.1.1')).toBeNull();

      // Carrier NAT & Multicast & Reserved
      expect(validateAndNormalizeRelayUrl('wss://100.64.0.1')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://224.0.0.1')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://240.0.0.1')).toBeNull();
    });

    it('blocks private and loopback IPv6 addresses', () => {
      expect(validateAndNormalizeRelayUrl('wss://[::1]')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://[fc00::1]')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://[fd12:3456:789a::1]')).toBeNull();
      expect(validateAndNormalizeRelayUrl('wss://[fe80::1]')).toBeNull();
    });
  });

  describe('filterValidRelayUrls', () => {
    it('filters invalid URLs and removes duplicates', () => {
      const candidates = [
        'wss://relay.damus.io',
        'wss://127.0.0.1',
        'wss://relay.damus.io/',
        'http://nos.lol',
        'wss://nos.lol',
        'wss://localhost',
        'wss://relay.nostr.band',
      ];

      const result = filterValidRelayUrls(candidates);
      expect(result).toEqual([
        'wss://relay.damus.io',
        'wss://nos.lol',
        'wss://relay.nostr.band',
      ]);
    });
  });
});
