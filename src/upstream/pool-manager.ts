import type { NostrEvent } from '../types/nostr';
import type {
  UpstreamEventCallback,
  UpstreamPoolConfig,
  UpstreamPullOptions,
  UpstreamPullResult,
} from '../types/upstream';
import { UpstreamRelayClient, type WebSocketFactory } from './relay-client';
import { filterValidRelayUrls } from './url-validator';

export const DEFAULT_UPSTREAM_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 5000;
export const MAX_CONCURRENT_RELAYS = 5;

interface ActivePullContext {
  subId: string;
  clients: UpstreamRelayClient[];
  timerId: ReturnType<typeof setTimeout> | null;
  cleanup: () => void;
}

/**
 * UpstreamPoolManager coordinates parallel upstream relay queries,
 * cross-relay deduplication, EOSE aggregation, timeouts, and teardown.
 */
export class UpstreamPoolManager {
  private defaultRelays: string[];
  private defaultTimeoutMs: number;
  private maxConcurrentRelays: number;
  private webSocketFactory?: WebSocketFactory | undefined;
  private activePulls: Map<string, ActivePullContext>;

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
    this.activePulls = new Map<string, ActivePullContext>();
  }

  /**
   * Pulls events from the upstream relay pool in parallel for a given subscription.
   */
  public async pullEvents(
    options: UpstreamPullOptions,
    onEvent: UpstreamEventCallback
  ): Promise<UpstreamPullResult> {
    const startTime = Date.now();
    const { subId, filters } = options;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const maxRelays = options.maxRelays ?? this.maxConcurrentRelays;

    // Abort any prior pull on this subscription ID before starting a new one
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

    if (targetUrls.length === 0 || filters.length === 0) {
      return {
        subId,
        events: [],
        relaysQueried: [],
        relaysSuccessful: [],
        relaysFailed: [],
        durationMs: Date.now() - startTime,
        timedOut: false,
      };
    }

    const collectedEvents: NostrEvent[] = [];
    const seenEventIds = new Set<string>();
    const relaysSuccessful = new Set<string>();
    const relaysFailed = new Set<string>();

    return new Promise<UpstreamPullResult>((resolve) => {
      let isResolved = false;
      const clients: UpstreamRelayClient[] = [];

      const cleanup = (): void => {
        if (context.timerId !== null) {
          clearTimeout(context.timerId);
          context.timerId = null;
        }
        for (const client of clients) {
          client.close();
        }
        this.activePulls.delete(subId);
      };

      const finish = (timedOut: boolean): void => {
        if (isResolved) return;
        isResolved = true;
        cleanup();

        resolve({
          subId,
          events: collectedEvents,
          relaysQueried: targetUrls,
          relaysSuccessful: Array.from(relaysSuccessful),
          relaysFailed: Array.from(relaysFailed),
          durationMs: Date.now() - startTime,
          timedOut,
        });
      };

      const checkAllCompleted = (): void => {
        const totalCompleted = relaysSuccessful.size + relaysFailed.size;
        if (totalCompleted >= targetUrls.length) {
          finish(false);
        }
      };

      // Set global timeout timer
      const timerId = setTimeout(() => {
        finish(true);
      }, timeoutMs);

      const context: ActivePullContext = {
        subId,
        clients,
        timerId,
        cleanup,
      };

      this.activePulls.set(subId, context);

      // Launch parallel connections
      for (const url of targetUrls) {
        const client = new UpstreamRelayClient(url, {
          webSocketFactory: this.webSocketFactory,
        });
        clients.push(client);

        client.subscribe(subId, filters, {
          onEvent: (event: NostrEvent) => {
            if (!seenEventIds.has(event.id)) {
              seenEventIds.add(event.id);
              collectedEvents.push(event);
              try {
                onEvent(event);
              } catch {
                // Ignore client callback errors
              }
            }
          },
          onEose: () => {
            relaysSuccessful.add(url);
            checkAllCompleted();
          },
          onError: () => {
            relaysFailed.add(url);
            checkAllCompleted();
          },
        });
      }
    });
  }

  /**
   * Aborts and terminates upstream connections for a specific subscription ID.
   */
  public abort(subId: string): void {
    const context = this.activePulls.get(subId);
    if (context) {
      context.cleanup();
    }
  }

  /**
   * Aborts and terminates all active upstream connections across all subscriptions.
   */
  public abortAll(): void {
    for (const [subId] of this.activePulls) {
      this.abort(subId);
    }
  }

  /**
   * Returns the count of currently active subscription pulls.
   */
  public activePullCount(): number {
    return this.activePulls.size;
  }
}
