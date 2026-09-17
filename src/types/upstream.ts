import type { NostrEvent, NostrFilter } from './nostr';

/**
 * Lifecycle status of an individual upstream relay connection.
 */
export type UpstreamRelayStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'eose'
  | 'closed'
  | 'error';

/**
 * Options for pulling events from upstream relays for a subscription.
 */
export interface UpstreamPullOptions {
  subId: string;
  filters: NostrFilter[];
  relayUrls?: string[] | undefined;
  timeoutMs?: number | undefined;
  maxRelays?: number | undefined;
}

/**
 * Callback for receiving verified, deduplicated Nostr events in real time.
 */
export type UpstreamEventCallback = (event: NostrEvent) => void;

/**
 * Summary of an upstream pull execution.
 */
export interface UpstreamPullResult {
  subId: string;
  events: NostrEvent[];
  relaysQueried: string[];
  relaysSuccessful: string[];
  relaysFailed: string[];
  durationMs: number;
  timedOut: boolean;
}

/**
 * Configuration options for UpstreamPoolManager.
 */
export interface UpstreamPoolConfig {
  defaultRelays?: string[] | undefined;
  defaultTimeoutMs?: number | undefined;
  maxConcurrentRelays?: number | undefined;
}
