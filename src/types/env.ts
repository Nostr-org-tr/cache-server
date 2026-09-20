import type { ClientSession } from '../durable-objects/client-session';

/**
 * Cloudflare Worker Environment Bindings & Variables
 */
export interface Env {
  DB: D1Database;
  CACHE_KV?: KVNamespace;
  CLIENT_SESSION: DurableObjectNamespace<ClientSession>;
  RELAY_NAME?: string;
  RELAY_DESCRIPTION?: string;
  RELAY_PUBKEY?: string;
  RELAY_CONTACT?: string;
  UPSTREAM_RELAYS?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  RATE_LIMIT_IP_HANDSHAKE_PER_MIN?: string;
  RATE_LIMIT_MSG_PER_WINDOW?: string;
  RATE_LIMIT_PUBKEY_WRITES_PER_MIN?: string;
  ALLOW_DIRECT_WRITES?: string;
  READ_ONLY?: string;
  ENABLE_KV_CACHE?: string;
}
