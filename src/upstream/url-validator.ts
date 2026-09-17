/**
 * URL Validator & SSRF Guard for Upstream Nostr Relays
 */

export interface UrlValidationOptions {
  /**
   * Allow unencrypted ws:// connections (useful for local integration testing).
   * Default: false (only wss:// allowed).
   */
  allowInsecureWs?: boolean;
}

/**
 * Checks whether an IPv4 address string falls into a reserved or private range.
 */
function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }

  const [a, b] = parts;
  if (a === undefined || b === undefined) {
    return false;
  }

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (Private network)
  if (a === 10) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (Private network: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (Private network)
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 (Multicast)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (Reserved)
  if (a >= 240) return true;

  return false;
}

/**
 * Checks whether an IPv6 address is private, loopback, or link-local.
 */
function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');

  if (normalized === '::' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  // Unique local addresses (fc00::/7)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  // Link-local addresses (fe80::/10)
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }

  return false;
}

const FORBIDDEN_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  '169.254.169.254',
]);

/**
 * Validates and normalizes a candidate upstream Nostr WebSocket URL.
 * Returns the normalized URL string if valid, or null if invalid / unsafe.
 */
export function validateAndNormalizeRelayUrl(
  rawUrl: string,
  options?: UrlValidationOptions
): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  const allowInsecure = options?.allowInsecureWs ?? false;
  const protocol = parsed.protocol.toLowerCase();

  if (protocol !== 'wss:' && (!allowInsecure || protocol !== 'ws:')) {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return null;
  }

  // Check forbidden exact hostnames
  if (FORBIDDEN_HOSTNAMES.has(hostname)) {
    return null;
  }

  // Check forbidden suffixes (.local, .localhost, .internal)
  if (
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return null;
  }

  // Check private / reserved IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    if (isPrivateOrReservedIpv4(hostname)) {
      return null;
    }
  }

  // Check private / reserved IPv6
  if (hostname.includes(':')) {
    if (isPrivateOrReservedIpv6(hostname)) {
      return null;
    }
  }

  // Strip trailing slashes on root path for consistency (e.g. wss://nos.lol/ -> wss://nos.lol)
  let normalized = parsed.toString();
  if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
    normalized = `${parsed.protocol}//${parsed.host}`;
  }

  return normalized;
}

/**
 * Validates an array of candidate relay URLs, removing duplicates and invalid entries.
 */
export function filterValidRelayUrls(
  urls: string[],
  options?: UrlValidationOptions
): string[] {
  const seen = new Set<string>();
  const valid: string[] = [];

  for (const raw of urls) {
    const normalized = validateAndNormalizeRelayUrl(raw, options);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      valid.push(normalized);
    }
  }

  return valid;
}
