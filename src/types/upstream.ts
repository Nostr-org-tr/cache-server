import type { NostrEvent, NostrFilter } from './nostr';

/**
 * Lifecycle status of an individual upstream relay connection.
 */
export type UpstreamRelayStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'eose'
  | 'live'
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
 * Callbacks for persistent live subscriptions across upstream relays.
 */
export interface UpstreamLiveCallbacks {
  /** Invoked whenever an event is received and cryptographically verified (initial or live) */
  onEvent: (event: NostrEvent, isInitial: boolean) => void;
  /** Invoked when all upstream relays reach initial EOSE (or initial sync timeout fires) */
  onInitialEose?: ((timedOut: boolean) => void) | undefined;
  /** Invoked when an individual upstream relay completes initial sync EOSE */
  onRelayEose?: ((url: string) => void) | undefined;
  /** Invoked if an upstream relay encounters an error or rejection */
  onError?: ((url: string, error: Error) => void) | undefined;
}


/**
 * Options for establishing persistent live upstream subscriptions.
 */
export interface UpstreamSubscribeOptions {
  subId: string;
  filters: NostrFilter[];
  relayUrls?: string[] | undefined;
  initialSyncTimeoutMs?: number | undefined;
  maxRelays?: number | undefined;
}

/**
 * Control handle for managing and tearing down an active live upstream subscription.
 */
export interface UpstreamSubscriptionHandle {
  subId: string;
  close: () => void;
  isInitialEoseComplete: () => boolean;
}

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

