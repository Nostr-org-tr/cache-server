import { verifyEventCrypto } from '../crypto';
import { formatCloseMessage, formatReqMessage, parseRelayMessage } from '../protocol';
import type { NostrEvent, NostrFilter } from '../types/nostr';
import type { UpstreamRelayStatus } from '../types/upstream';

export type WebSocketFactory = (url: string) => Promise<WebSocket> | WebSocket;

export interface UpstreamRelayClientOptions {
  webSocketFactory?: WebSocketFactory | undefined;
}

export interface UpstreamClientSubscribeCallbacks {
  onEvent: (event: NostrEvent, isLive: boolean) => void;
  onEose: () => void;
  onError: (error: Error) => void;
}

/**
 * Default WebSocket factory for Cloudflare Workers environment.
 * Initiates an outbound HTTP Upgrade request and accepts the resulting WebSocket.
 */
export async function defaultWebSocketFactory(targetUrl: string): Promise<WebSocket> {
  const httpUrl = targetUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
  const response = await fetch(httpUrl, {
    headers: {
      Upgrade: 'websocket',
    },
  });

  const ws = response.webSocket;
  if (!ws) {
    throw new Error(
      `Failed to establish WebSocket connection to ${targetUrl}: HTTP ${response.status} ${response.statusText}`
    );
  }

  ws.accept();
  return ws;
}

/**
 * UpstreamRelayClient manages an outbound WebSocket connection to a single Nostr relay,
 * supporting both initial historical sync and continuous live event streaming.
 */
export class UpstreamRelayClient {
  public readonly url: string;
  private ws: WebSocket | null = null;
  private status: UpstreamRelayStatus = 'idle';
  private webSocketFactory: WebSocketFactory;
  private subId: string | null = null;
  private isEose = false;
  private isAborted = false;

  constructor(url: string, options?: UpstreamRelayClientOptions) {
    this.url = url;
    this.webSocketFactory = options?.webSocketFactory ?? defaultWebSocketFactory;
  }

  public getStatus(): UpstreamRelayStatus {
    return this.status;
  }

  public isInitialEoseReceived(): boolean {
    return this.isEose;
  }

  /**
   * Connects to the upstream relay, sends a REQ subscription, and streams verified events.
   * Continues streaming live events after initial EOSE until explicitly closed.
   */
  public subscribe(
    subId: string,
    filters: NostrFilter[],
    callbacks: UpstreamClientSubscribeCallbacks
  ): void {
    this.subId = subId;
    this.status = 'connecting';
    this.isEose = false;
    this.isAborted = false;

    const onConnected = (ws: WebSocket): void => {
      if (this.isAborted || this.status === 'closed') {
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
          }
        } catch {
          // Ignore close errors during abort
        }
        return;
      }

      this.ws = ws;

      const onOpenHandler = (): void => {
        if (this.isAborted || this.status === 'closed') return;
        this.status = 'connected';
        try {
          const reqMessage = formatReqMessage(subId, filters);
          ws.send(reqMessage);
        } catch (err) {
          this.status = 'error';
          callbacks.onError(err instanceof Error ? err : new Error(String(err)));
          this.close();
        }
      };

      const onMessageHandler = (event: MessageEvent | { data: string | ArrayBuffer }): void => {
        if (this.isAborted || this.status === 'closed') return;
        const raw =
          typeof event.data === 'string'
            ? event.data
            : new TextDecoder().decode(event.data as ArrayBuffer);

        const parsed = parseRelayMessage(raw);
        if (!parsed.ok) {
          return;
        }

        const msg = parsed.value;
        const verb = msg[0];

        if (verb === 'EVENT') {
          const receivedSubId = msg[1];
          const nostrEvent = msg[2];

          if (receivedSubId === this.subId) {
            const cryptoCheck = verifyEventCrypto(nostrEvent);
            if (cryptoCheck.valid) {
              callbacks.onEvent(nostrEvent, this.isEose);
            }
          }
        } else if (verb === 'EOSE') {
          const receivedSubId = msg[1];
          if (receivedSubId === this.subId && !this.isEose) {
            this.isEose = true;
            this.status = 'live';
            callbacks.onEose();
          }
        } else if (verb === 'CLOSED') {
          const receivedSubId = msg[1];
          const reason = typeof msg[2] === 'string' ? msg[2] : '';
          if (receivedSubId === this.subId) {
            const isError = /^(error|blocked|restricted|rate-limited|invalid):/i.test(reason);
            if (isError) {
              this.status = 'error';
              callbacks.onError(
                new Error(`Upstream ${this.url} closed subscription with error: ${reason}`)
              );
            } else {
              if (!this.isEose) {
                this.isEose = true;
                this.status = 'closed';
                callbacks.onEose();
              }
            }
          }
        } else if (verb === 'NOTICE') {
          const noticeMsg = typeof msg[1] === 'string' ? msg[1] : '';
          if (/^(error|blocked|rate-limited):/i.test(noticeMsg)) {
            console.warn(`Upstream ${this.url} NOTICE:`, noticeMsg);
          }
        }
      };

      const onErrorHandler = (event: Event | unknown): void => {
        if (this.status !== 'closed' && !this.isAborted) {
          this.status = 'error';
          const errorMsg =
            event &&
            typeof event === 'object' &&
            'message' in event &&
            typeof event.message === 'string'
              ? event.message
              : `WebSocket error on upstream ${this.url}`;
          callbacks.onError(new Error(errorMsg));
        }
      };

      const onCloseHandler = (): void => {
        if (this.status === 'connecting' || this.status === 'connected') {
          this.status = 'closed';
          if (!this.isEose && !this.isAborted) {
            this.isEose = true;
            callbacks.onEose();
          }
        } else {
          this.status = 'closed';
        }
      };

      // Attach standard event listeners
      ws.addEventListener('open', onOpenHandler);
      ws.addEventListener('message', onMessageHandler);
      ws.addEventListener('error', onErrorHandler);
      ws.addEventListener('close', onCloseHandler);

      // In case the socket was synchronously or already opened (e.g. via fetch WebSocket upgrade)
      if (ws.readyState === WebSocket.OPEN) {
        onOpenHandler();
      }
    };

    try {
      const socketOrPromise = this.webSocketFactory(this.url);
      if (socketOrPromise instanceof Promise) {
        socketOrPromise
          .then((ws) => onConnected(ws))
          .catch((err) => {
            if (!this.isAborted && this.status !== 'closed') {
              this.status = 'error';
              callbacks.onError(err instanceof Error ? err : new Error(String(err)));
            }
          });
      } else {
        onConnected(socketOrPromise);
      }
    } catch (err) {
      if (!this.isAborted) {
        this.status = 'error';
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Sends a CLOSE message for the active subscription over the WebSocket connection without terminating the socket.
   */
  public closeSubscription(): void {
    if (this.subId && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(formatCloseMessage(this.subId));
      } catch {
        // Ignore send errors on close
      }
    }
    this.subId = null;
  }

  /**
   * Gracefully closes the subscription and terminates the WebSocket connection.
   */
  public close(): void {
    this.isAborted = true;
    if (!this.ws) {
      this.status = 'closed';
      return;
    }

    this.closeSubscription();

    try {
      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
    } catch {
      // Ignore close errors during teardown
    }

    this.status = 'closed';
    this.ws = null;
  }
}

