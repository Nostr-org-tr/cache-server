import type { NostrEvent } from '../types/nostr';
import type {
  UpstreamEventCallback,
  UpstreamLiveCallbacks,
  UpstreamPoolConfig,
  UpstreamPullOptions,
  UpstreamPullResult,
  UpstreamSubscribeOptions,
  UpstreamSubscriptionHandle,
} from '../types/upstream';
import { decomposeFiltersForUpstream } from './filter-chunker';
import { UpstreamRelayClient, type WebSocketFactory } from './relay-client';
import { filterValidRelayUrls } from './url-validator';

export const DEFAULT_UPSTREAM_RELAYS = [
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://relay.ditto.pub',
  'wss://relay.emre.xyz',
  'wss://relay.nostr.org.tr',
];

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 5000;
export const MAX_CONCURRENT_RELAYS = 5;

interface ActiveSubscriptionContext {
  subId: string;
  clients: UpstreamRelayClient[];
  initialSyncTimerId: ReturnType<typeof setTimeout> | null;
  isInitialSyncComplete: boolean;
  cleanup: () => void;
}

/**
 * UpstreamPoolManager coordinates parallel upstream relay queries,
 * cross-relay deduplication, EOSE aggregation, timeouts, persistent live streaming, and teardown.
 */
export class UpstreamPoolManager {
  private defaultRelays: string[];
  private defaultTimeoutMs: number;
  private maxConcurrentRelays: number;
  private webSocketFactory?: WebSocketFactory | undefined;
  private activeSubscriptions: Map<string, ActiveSubscriptionContext>;

  constructor(
    config?: UpstreamPoolConfig | undefined,
    options?: { webSocketFactory?: WebSocketFactory | undefined } | undefined
  ) {
    this.defaultRelays =
      config?.defaultRelays && config.defaultRelays.length > 0
        ? filterValidRelayUrls(config.defaultRelays)
        : DEFAULT_UPSTREAM_RELAYS;
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
    this.maxConcurrentRelays = config?.maxConcurrentRelays ?? MAX_CONCURRENT_RELAYS;
    this.webSocketFactory = options?.webSocketFactory;
    this.activeSubscriptions = new Map<string, ActiveSubscriptionContext>();
  }

  /**
   * Establishes a persistent live subscription across upstream relays with initial EOSE aggregation.
   * Relays stream historical events up to initial EOSE, and continue streaming real-time live events.
   */
  public subscribeLive(
    options: UpstreamSubscribeOptions,
    callbacks: UpstreamLiveCallbacks
  ): UpstreamSubscriptionHandle {
    const { subId, filters } = options;
    const timeoutMs = options.initialSyncTimeoutMs ?? this.defaultTimeoutMs;
    const maxRelays = options.maxRelays ?? this.maxConcurrentRelays;

    // Abort any prior subscription on this subscription ID before starting a new one
    this.abort(subId);

    // Resolve candidate relay URLs
    let candidateUrls =
      options.relayUrls && options.relayUrls.length > 0
        ? filterValidRelayUrls(options.relayUrls)
        : this.defaultRelays;

    if (candidateUrls.length === 0) {
      candidateUrls = this.defaultRelays;
    }

    const targetUrls = candidateUrls.slice(0, maxRelays);
    const upstreamFilters = decomposeFiltersForUpstream(filters);

    if (targetUrls.length === 0 || upstreamFilters.length === 0) {
      if (callbacks.onInitialEose) {
        queueMicrotask(() => callbacks.onInitialEose?.(false));
      }
      return {

        subId,
        close: () => {},
        isInitialEoseComplete: () => true,
      };
    }

    const seenEventIds = new Set<string>();
    const relaysCompletedInitialSync = new Set<string>();
    const clients: UpstreamRelayClient[] = [];

    let isCleanedUp = false;

    const cleanup = (): void => {
      if (isCleanedUp) return;
      isCleanedUp = true;

      if (context.initialSyncTimerId !== null) {
        clearTimeout(context.initialSyncTimerId);
        context.initialSyncTimerId = null;
      }

      for (const client of clients) {
        client.close();
      }

      this.activeSubscriptions.delete(subId);
    };

    const completeInitialSync = (timedOut: boolean): void => {
      if (context.isInitialSyncComplete || isCleanedUp) return;
      context.isInitialSyncComplete = true;

      if (context.initialSyncTimerId !== null) {
        clearTimeout(context.initialSyncTimerId);
        context.initialSyncTimerId = null;
      }

      try {
        callbacks.onInitialEose?.(timedOut);
      } catch {
        // Ignore client callback errors
      }
    };

    const checkAllInitialSyncCompleted = (): void => {
      if (relaysCompletedInitialSync.size >= targetUrls.length) {
        completeInitialSync(false);
      }
    };

    // Set fallback timer for initial sync phase (in case one relay is slow to emit EOSE)
    const initialSyncTimerId = setTimeout(() => {
      completeInitialSync(true);
    }, timeoutMs);

    const context: ActiveSubscriptionContext = {
      subId,
      clients,
      initialSyncTimerId,
      isInitialSyncComplete: false,
      cleanup,
    };

    this.activeSubscriptions.set(subId, context);

    // Launch parallel connections to target relays
    for (const url of targetUrls) {
      const client = new UpstreamRelayClient(url, {
        webSocketFactory: this.webSocketFactory,
      });
      clients.push(client);

      client.subscribe(subId, upstreamFilters, {
        onEvent: (event: NostrEvent, isLive: boolean) => {
          if (!seenEventIds.has(event.id)) {
            seenEventIds.add(event.id);
            try {
              const isInitial = !context.isInitialSyncComplete && !isLive;
              callbacks.onEvent(event, isInitial);
            } catch {
              // Ignore callback errors
            }
          }
        },
        onEose: () => {
          relaysCompletedInitialSync.add(url);
          try {
            callbacks.onRelayEose?.(url);
          } catch {
            // Ignore callback error
          }
          checkAllInitialSyncCompleted();
        },
        onError: (error: Error) => {
          relaysCompletedInitialSync.add(url);
          try {
            callbacks.onError?.(url, error);
          } catch {
            // Ignore error callback issues
          }
          checkAllInitialSyncCompleted();
        },
      });
    }

    return {
      subId,
      close: cleanup,
      isInitialEoseComplete: () => context.isInitialSyncComplete,
    };
  }

  /**
   * Pulls events from the upstream relay pool in parallel for a given subscription and terminates on EOSE.
   */
  public async pullEvents(
    options: UpstreamPullOptions,
    onEvent: UpstreamEventCallback
  ): Promise<UpstreamPullResult> {
    const startTime = Date.now();
    const { subId } = options;
    const collectedEvents: NostrEvent[] = [];
    const relaysSuccessful = new Set<string>();
    const relaysFailed = new Set<string>();

    let candidateUrls =
      options.relayUrls && options.relayUrls.length > 0
        ? filterValidRelayUrls(options.relayUrls)
        : this.defaultRelays;

    if (candidateUrls.length === 0) {
      candidateUrls = this.defaultRelays;
    }
    const maxRelays = options.maxRelays ?? this.maxConcurrentRelays;
    const targetUrls = candidateUrls.slice(0, maxRelays);

    return new Promise<UpstreamPullResult>((resolve) => {
      let isResolved = false;

      const handle = this.subscribeLive(
        {
          subId,
          filters: options.filters,
          relayUrls: options.relayUrls,
          initialSyncTimeoutMs: options.timeoutMs,
          maxRelays: options.maxRelays,
        },
        {
          onEvent: (event: NostrEvent) => {
            collectedEvents.push(event);
            try {
              onEvent(event);
            } catch {
              // Ignore callback errors
            }
          },
          onRelayEose: (url: string) => {
            relaysSuccessful.add(url);
          },
          onInitialEose: (timedOut: boolean) => {
            if (isResolved) return;
            isResolved = true;
            handle.close();
            resolve({
              subId,
              events: collectedEvents,
              relaysQueried: targetUrls,
              relaysSuccessful: Array.from(relaysSuccessful),
              relaysFailed: Array.from(relaysFailed),
              durationMs: Date.now() - startTime,
              timedOut,
            });
          },
          onError: (url: string) => {
            relaysFailed.add(url);
          },
        }
      );
    });
  }


  /**
   * Aborts and terminates upstream connections for a specific subscription ID.
   */
  public abort(subId: string): void {
    const context = this.activeSubscriptions.get(subId);
    if (context) {
      context.cleanup();
    }
  }

  /**
   * Aborts and terminates all active upstream connections across all subscriptions.
   */
  public abortAll(): void {
    for (const [subId] of this.activeSubscriptions) {
      this.abort(subId);
    }
  }

  /**
   * Returns the count of currently active subscriptions.
   */
  public activeSubscriptionCount(): number {
    return this.activeSubscriptions.size;
  }

  /**
   * Alias for activeSubscriptionCount for backwards compatibility.
   */
  public activePullCount(): number {
    return this.activeSubscriptions.size;
  }
}

