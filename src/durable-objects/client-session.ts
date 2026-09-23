import { DurableObject } from 'cloudflare:workers';
import { putMetadataToKv } from '../cache';
import { verifyEventCrypto } from '../crypto';
import {
  countEvents,
  loadOperatorModerationRules,
  purgeModeratedEntities,
  queryEventsHybrid,
  querySearchEvents,
  saveEvent,
  saveEventsBatch,
} from '../db';
import { indexEventsBatchVector, indexEventVector } from '../search';
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
import {
  createEmptyModerationRuleset,
  extractModerationRulesFromEvents,
  inspectEventModeration,
  type ModerationRuleset,
  RATE_LIMIT_DEFAULTS,
  SlidingWindowLimiter,
} from '../security';
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
  private moderationRuleset: ModerationRuleset;
  private moderationLoaded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.subscriptions = new Map<string, NostrFilter[]>();
    this.sentEventIds = new Map<string, Set<string>>();
    this.moderationRuleset = createEmptyModerationRuleset();

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
   * Lazily loads operator moderation rules (kind 10000 and 1984) from D1.
   */
  private async ensureModerationLoaded(): Promise<void> {
    if (this.moderationLoaded) {
      return;
    }
    if (this.env.RELAY_PUBKEY) {
      try {
        this.moderationRuleset = await loadOperatorModerationRules(
          this.env.DB,
          this.env.RELAY_PUBKEY
        );
      } catch (err) {
        console.error('Failed to load operator moderation rules:', err);
      }
    }
    this.moderationLoaded = true;
  }

  /**
   * Sets or overrides active moderation ruleset (primarily for testing and simulation).
   */
  public setModerationRuleset(ruleset: ModerationRuleset): void {
    this.moderationRuleset = ruleset;
    this.moderationLoaded = true;
  }

  /**
   * Returns active moderation ruleset.
   */
  public getModerationRuleset(): ModerationRuleset {
    return this.moderationRuleset;
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
    // 0. Ensure operator moderation rules are loaded
    await this.ensureModerationLoaded();

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

        const kv = this.env.ENABLE_KV_CACHE === 'false' ? undefined : this.env.CACHE_KV;

        // 1. Check for NIP-50 search filters vs standard subscription filters
        const searchFilters = filters.filter((f) => Boolean(f.search && f.search.trim().length > 0));
        const standardFilters = filters.filter((f) => !f.search || f.search.trim().length === 0);

        const storedEvents: NostrEvent[] = [];

        // 1a. Query NIP-50 Vector Search Engine (preserves similarity score descending order)
        for (const sFilter of searchFilters) {
          const searchResults = await querySearchEvents(
            this.env.DB,
            this.env,
            sFilter,
            {
              maxLimit: MAX_QUERY_LIMIT,
            }
          );
          storedEvents.push(...searchResults);
        }

        // 1b. Query standard filters via multi-tier L0/L1/D1 hybrid resolver
        if (standardFilters.length > 0) {
          const standardResults = await queryEventsHybrid(
            this.env.DB,
            kv,
            standardFilters,
            {
              maxLimit: MAX_QUERY_LIMIT,
            }
          );
          storedEvents.push(...standardResults);
        }

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
              kv
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
            const modResult = inspectEventModeration(event, this.moderationRuleset);
            if (!modResult.allowed) {
              return;
            }
            if (!sentSet.has(event.id)) {
              ws.send(formatEventMessage(subId, event));
              sentSet.add(event.id);
            }
          }
        );

        // 5. Emit EOSE to client once all upstream relays complete or time out
        ws.send(formatEoseMessage(subId));

        // 6. Asynchronously persist newly pulled non-ephemeral, non-moderated events into D1 and L0 memory / L1 KV, plus background vector indexing
        if (pullResult.events.length > 0) {
          const nonEphemeral = pullResult.events.filter(
            (e) =>
              !(e.kind >= 20000 && e.kind < 30000) &&
              inspectEventModeration(e, this.moderationRuleset).allowed
          );
          if (nonEphemeral.length > 0) {
            await saveEventsBatch(this.env.DB, nonEphemeral, kv);

            // Non-blocking background vector indexing
            if (this.env.AI && this.env.VECTOR_INDEX && this.env.VECTOR_SEARCH_ENABLED !== 'false') {
              void indexEventsBatchVector(
                this.env.AI,
                this.env.VECTOR_INDEX,
                nonEphemeral,
                this.env.VECTOR_EMBEDDING_MODEL
              ).catch((err) => console.error('Background vector batch indexing error:', err));
            }
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

        // 4. If operator publishes kind 10000 (mute list) or kind 1984 (report), hot-reload moderation rules and trigger retroactive purge
        if (isOperator && (event.kind === 10000 || event.kind === 1984)) {
          const updatedRules = extractModerationRulesFromEvents([event], event.pubkey);
          this.moderationRuleset = {
            blockedPubkeys: new Set([
              ...this.moderationRuleset.blockedPubkeys,
              ...updatedRules.blockedPubkeys,
            ]),
            blockedEventIds: new Set([
              ...this.moderationRuleset.blockedEventIds,
              ...updatedRules.blockedEventIds,
            ]),
            bannedWordsAndDomains: Array.from(
              new Set([
                ...this.moderationRuleset.bannedWordsAndDomains,
                ...updatedRules.bannedWordsAndDomains,
              ])
            ),
            bannedHashtags: new Set([
              ...this.moderationRuleset.bannedHashtags,
              ...updatedRules.bannedHashtags,
            ]),
          };

          const kv = this.env.ENABLE_KV_CACHE === 'false' ? undefined : this.env.CACHE_KV;
          void purgeModeratedEntities(
            this.env.DB,
            kv,
            this.env.VECTOR_INDEX,
            this.moderationRuleset
          ).catch((err) => console.error('Background moderation purge error:', err));
        }

        // 5. Enforce strict moderation policies (NIP-36, NIP-32, Operator Rules)
        const modResult = inspectEventModeration(event, this.moderationRuleset);
        if (!modResult.allowed) {
          ws.send(
            formatOkMessage(
              event.id,
              false,
              modResult.reason || 'blocked: content policy violation'
            )
          );
          return;
        }

        const isEphemeral = event.kind >= 20000 && event.kind < 30000;

        if (!isEphemeral) {
          const kv = this.env.ENABLE_KV_CACHE === 'false' ? undefined : this.env.CACHE_KV;
          // Persist to D1 storage, in-memory cache, and selectively warm metadata in KV
          await saveEvent(this.env.DB, event);
          if (kv) {
            void putMetadataToKv(kv, event);
          }

          // Non-blocking background vector indexing
          if (this.env.AI && this.env.VECTOR_INDEX && this.env.VECTOR_SEARCH_ENABLED !== 'false') {
            void indexEventVector(
              this.env.AI,
              this.env.VECTOR_INDEX,
              event,
              this.env.VECTOR_EMBEDDING_MODEL
            ).catch((err) => console.error('Background vector indexing error:', err));
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
