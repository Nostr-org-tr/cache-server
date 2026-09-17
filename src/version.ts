/**
 * Application Version & Metadata
 * 
 * Auto-synchronized source of truth for runtime versioning across HTTP endpoints,
 * NIP-11 relay documents, telemetry, and logging.
 * Managed via `make version-*` and `scripts/bump-version.ts`.
 */

export const APP_VERSION = '1.2.0';
export const APP_NAME = 'cache.nostr.org.tr';
export const APP_DESCRIPTION =
  'High-Performance Nostr Regional Cache Relay (Read-only cache. Direct writes are not allowed; events are ingested from upstream relays).';
export const APP_REPOSITORY = 'https://github.com/delirehberi/cache.nostr.org.tr';
export const APP_HOMEPAGE = 'https://cache.nostr.org.tr';
export const APP_CONTACT = 'admin@nostr.org.tr';
