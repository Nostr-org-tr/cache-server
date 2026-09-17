import { DurableObject } from 'cloudflare:workers';
import { putEventToKv } from '../cache';
import { verifyEventCrypto } from '../crypto';
import { countEvents, queryEventsHybrid, saveEvent, saveEventsBatch } from '../db';
import {
  formatClosedMessage,
  formatCountMessage,
  formatEoseMessage,
  formatEventMessage,
  formatNoticeMessage,
  formatOkMessage,
  matchFilters,
  parseClientMessage,
} from '../protocol';
import { RATE_LIMIT_DEFAULTS, SlidingWindowLimiter } from '../security';
import type { Env } from '../types/env';
import type { NostrEvent, NostrFilter } from '../types/nostr';
import {
  extractRelayHintsFromFilters,
  filterValidRelayUrls,
  resolveAuthorRelaysFromD1,
  UpstreamPoolManager,
  type WebSocketFactory,
} from '../upstream';

const MAX_SUBSCRIPTIONS = 20;
const MAX_FILTERS_PER_SUB = 10;
const MAX_QUERY_LIMIT = 500;

/**
 * ClientSession Durable Object
 *
 * Manages stateful client WebSocket lifecycle, active subscription registry,
 * per-subscription event deduplication, local D1 cache queries,
 * transparent upstream pull-through caching, and live event broadcasting.
 */
export class ClientSession extends DurableObject<Env> {
  private subscriptions: Map<string, NostrFilter[]>;
  private sentEventIds: Map<string, Set<string>>;
  private poolManager: UpstreamPoolManager;
  private sessionCustomRelays: string[] | null = null;
  private sessionMessageLimiter: SlidingWindowLimiter;
  private pubkeyWriteLimiter: SlidingWindowLimiter;
  private clientIp = '127.0.0.1';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.subscriptions = new Map<string, NostrFilter[]>();
    this.sentEventIds = new Map<string, Set<string>>();

    const sessionMsgLimit = env.RATE_LIMIT_MSG_PER_WINDOW
      ? Number.parseInt(env.RATE_LIMIT_MSG_PER_WINDOW, 10)
      : RATE_LIMIT_DEFAULTS.SESSION_MSG_LIMIT;
    this.sessionMessageLimiter = new SlidingWindowLimiter({
      maxRequests: sessionMsgLimit,
      windowMs: RATE_LIMIT_DEFAULTS.SESSION_MSG_WINDOW_MS,
    });

    const pubkeyWriteLimit = env.RATE_LIMIT_PUBKEY_WRITES_PER_MIN
      ? Number.parseInt(env.RATE_LIMIT_PUBKEY_WRITES_PER_MIN, 10)
      : RATE_LIMIT_DEFAULTS.PUBKEY_WRITE_LIMIT;
    this.pubkeyWriteLimiter = new SlidingWindowLimiter({
      maxRequests: pubkeyWriteLimit,
      windowMs: RATE_LIMIT_DEFAULTS.PUBKEY_WRITE_WINDOW_MS,
    });

    const defaultRelays = env.UPSTREAM_RELAYS
      ? env.UPSTREAM_RELAYS.split(',').map((r) => r.trim())
      : undefined;
    const defaultTimeoutMs = env.UPSTREAM_TIMEOUT_MS
      ? Number.parseInt(env.UPSTREAM_TIMEOUT_MS, 10)
      : undefined;

    this.poolManager = new UpstreamPoolManager({
      defaultRelays,
      defaultTimeoutMs,
    });
  }

  /**
   * Returns the client IP recorded during WebSocket handshake.
   */
  public getClientIp(): string {
    return this.clientIp;
  }

  /**
   * Allows injecting a custom WebSocket factory for testing or simulation.
   */
  public setWebSocketFactory(factory: WebSocketFactory): void {
    const defaultRelays = this.env.UPSTREAM_RELAYS
      ? this.env.UPSTREAM_RELAYS.split(',').map((r) => r.trim())
      : undefined;
    const defaultTimeoutMs = this.env.UPSTREAM_TIMEOUT_MS
      ? Number.parseInt(this.env.UPSTREAM_TIMEOUT_MS, 10)
      : undefined;

    this.poolManager = new UpstreamPoolManager(
      {
        defaultRelays,
        defaultTimeoutMs,
      },
      { webSocketFactory: factory }
    );
  }

  /**
   * Handles incoming HTTP requests to upgrade to a WebSocket connection.
   */
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket Upgrade', {
        status: 426,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Upgrade: 'websocket',
        },
      });
    }

    // Extract client IP
    this.clientIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      '127.0.0.1';

    // Parse custom relays parameter if provided (e.g. ?relays=wss://relay.damus.io,wss://nos.lol)
    try {
      const url = new URL(request.url);
      const relaysParam = url.searchParams.get('relays');
      if (relaysParam) {
        const parsed = filterValidRelayUrls(relaysParam.split(','));
        if (parsed.length > 0) {
          this.sessionCustomRelays = parsed;
        }
      }
    } catch {
      // Ignore URL parsing errors on custom relays
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = [webSocketPair[0], webSocketPair[1]];

    this.ctx.acceptWebSocket(server, ['client']);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * WebSocket message handler invoked via Cloudflare Hibernation API.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // 1. Enforce per-session message throughput rate limit
    const sessionRateResult = this.sessionMessageLimiter.check('msg');
    if (!sessionRateResult.allowed) {
      ws.send(
        formatNoticeMessage('rate-limited: message throughput exceeded, please slow down')
      );
      return;
    }

    const rawData = typeof message === 'string' ? message : new TextDecoder().decode(message);

    const parseResult = parseClientMessage(rawData);
    if (!parseResult.ok) {
      ws.send(formatNoticeMessage(`error: ${parseResult.error}`));
      return;
    }

    const clientMsg = parseResult.value;
    const messageType = clientMsg[0];

    switch (messageType) {
      case 'CLOSE': {
        const subId = clientMsg[1];
        this.poolManager.abort(subId);
        this.subscriptions.delete(subId);
        this.sentEventIds.delete(subId);
        ws.send(formatClosedMessage(subId, 'subscription closed'));
        return;
      }

      case 'REQ': {
        const subId = clientMsg[1];
        const filters = clientMsg.slice(2) as NostrFilter[];

        if (!this.subscriptions.has(subId) && this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
          ws.send(formatClosedMessage(subId, 'rate-limited: maximum active subscriptions exceeded'));
          return;
        }

        if (filters.length > MAX_FILTERS_PER_SUB) {
          ws.send(
            formatClosedMessage(
              subId,
              `error: maximum ${MAX_FILTERS_PER_SUB} filters per subscription exceeded`
            )
          );
          return;
        }

        this.subscriptions.set(subId, filters);
        const sentSet = new Set<string>();
        this.sentEventIds.set(subId, sentSet);

        // 1. Query L1 KV cache and/or local D1 for matching events
        const storedEvents = await queryEventsHybrid(
          this.env.DB,
          this.env.CACHE_KV,
          filters,
          {
            maxLimit: MAX_QUERY_LIMIT,
          }
        );

        // 2. Stream matching cached events to client with deduplication
        for (const event of storedEvents) {
          if (!sentSet.has(event.id)) {
            ws.send(formatEventMessage(subId, event));
            sentSet.add(event.id);
          }
        }

        // 3. Resolve target upstream relays
        let targetRelays: string[] | undefined;
        if (this.sessionCustomRelays && this.sessionCustomRelays.length > 0) {
          targetRelays = this.sessionCustomRelays;
        } else {
          // Extract author pubkeys for NIP-65 dynamic resolution
          const authorPubkeys: string[] = [];
          for (const filter of filters) {
            if (Array.isArray(filter.authors)) {
              authorPubkeys.push(...filter.authors);
            }
          }

          const [authorRelays, filterHints] = await Promise.all([
            resolveAuthorRelaysFromD1(
              this.env.DB,
              authorPubkeys,
              undefined,
              this.env.CACHE_KV
            ),
            Promise.resolve(extractRelayHintsFromFilters(filters)),
          ]);

          const combined = [...authorRelays, ...filterHints];
          if (combined.length > 0) {
            targetRelays = filterValidRelayUrls(combined);
          }
        }

        // 4. Perform parallel upstream pull-through
        const pullResult = await this.poolManager.pullEvents(
          {
            subId,
            filters,
            relayUrls: targetRelays,
          },
          (event: NostrEvent) => {
            if (!sentSet.has(event.id)) {
              ws.send(formatEventMessage(subId, event));
              sentSet.add(event.id);
            }
          }
        );

        // 5. Emit EOSE to client once all upstream relays complete or time out
        ws.send(formatEoseMessage(subId));

        // 6. Asynchronously persist newly pulled non-ephemeral events into D1 and L1 KV
        if (pullResult.events.length > 0) {
          const nonEphemeral = pullResult.events.filter(
            (e) => !(e.kind >= 20000 && e.kind < 30000)
          );
          if (nonEphemeral.length > 0) {
            await saveEventsBatch(this.env.DB, nonEphemeral, this.env.CACHE_KV);
          }
        }

        return;
      }

      case 'EVENT': {
        const event = clientMsg[1];

        // 1. Check direct write permissions (Read-Only Mode)
        const allowDirectWrites = this.env.ALLOW_DIRECT_WRITES === 'true';
        const isOperator =
          Boolean(this.env.RELAY_PUBKEY) &&
          this.env.RELAY_PUBKEY?.toLowerCase() === event.pubkey.toLowerCase();

        if (!allowDirectWrites && !isOperator) {
          ws.send(
            formatOkMessage(
              event.id,
              false,
              'blocked: this relay operates in read-only caching mode'
            )
          );
          return;
        }

        // 2. Check pubkey write rate limit
        const pubkeyRateResult = this.pubkeyWriteLimiter.check(event.pubkey);
        if (!pubkeyRateResult.allowed) {
          const retrySeconds = Math.ceil(pubkeyRateResult.retryAfterMs / 1000);
          ws.send(
            formatOkMessage(
              event.id,
              false,
              `rate-limited: pubkey write frequency exceeded (retry in ${retrySeconds}s)`
            )
          );
          return;
        }

        // 3. Verify cryptographic signature and hash
        const cryptoResult = verifyEventCrypto(event);
        if (!cryptoResult.valid) {
          ws.send(formatOkMessage(event.id, false, `invalid: ${cryptoResult.reason}`));
          return;
        }

        const isEphemeral = event.kind >= 20000 && event.kind < 30000;

        if (!isEphemeral) {
          // Persist to D1 storage and warm L1 KV cache
          await saveEvent(this.env.DB, event);
          if (this.env.CACHE_KV) {
            void putEventToKv(this.env.CACHE_KV, event);
          }
        }

        // Broadcast to active subscriptions matching filter criteria
        for (const [subId, filters] of this.subscriptions.entries()) {
          if (matchFilters(filters, event)) {
            const sentSet = this.sentEventIds.get(subId);
            if (sentSet && !sentSet.has(event.id)) {
              ws.send(formatEventMessage(subId, event));
              sentSet.add(event.id);
            }
          }
        }

        ws.send(formatOkMessage(event.id, true, ''));
        return;
      }

      case 'COUNT': {
        const subId = clientMsg[1];
        const filters = clientMsg.slice(2) as NostrFilter[];
        const count = await countEvents(this.env.DB, filters);
        ws.send(formatCountMessage(subId, count));
        return;
      }
    }
  }

  /**
   * WebSocket close lifecycle hook.
   */
  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    this.poolManager.abortAll();
    this.subscriptions.clear();
    this.sentEventIds.clear();
    this.sessionMessageLimiter.clear();
    this.pubkeyWriteLimiter.clear();
  }

  /**
   * WebSocket error handler.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : 'Unknown WebSocket error';
    try {
      ws.send(formatNoticeMessage(`error: ${errorMsg}`));
    } catch {
      // Socket may already be closed
    }
  }
}
