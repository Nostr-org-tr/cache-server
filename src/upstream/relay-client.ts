import { verifyEventCrypto } from '../crypto';
import { formatCloseMessage, formatReqMessage, parseRelayMessage } from '../protocol';
import type { NostrEvent, NostrFilter } from '../types/nostr';
import type { UpstreamRelayStatus } from '../types/upstream';

export type WebSocketFactory = (url: string) => WebSocket;

export interface UpstreamRelayClientOptions {
  webSocketFactory?: WebSocketFactory | undefined;
}

/**
 * UpstreamRelayClient manages an ephemeral outbound WebSocket connection to a single Nostr relay.
 */
export class UpstreamRelayClient {
  public readonly url: string;
  private ws: WebSocket | null = null;
  private status: UpstreamRelayStatus = 'idle';
  private webSocketFactory: WebSocketFactory;
  private subId: string | null = null;

  constructor(url: string, options?: UpstreamRelayClientOptions) {
    this.url = url;
    this.webSocketFactory =
      options?.webSocketFactory ?? ((targetUrl: string) => new WebSocket(targetUrl));
  }

  public getStatus(): UpstreamRelayStatus {
    return this.status;
  }

  /**
   * Connects to the upstream relay, sends a REQ subscription, and streams verified events until EOSE or error.
   */
  public subscribe(
    subId: string,
    filters: NostrFilter[],
    callbacks: {
      onEvent: (event: NostrEvent) => void;
      onEose: () => void;
      onError: (error: Error) => void;
    }
  ): void {
    this.subId = subId;
    this.status = 'connecting';

    try {
      this.ws = this.webSocketFactory(this.url);
    } catch (err) {
      this.status = 'error';
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const ws = this.ws;

    const onOpenHandler = (): void => {
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
            callbacks.onEvent(nostrEvent);
          }
        }
      } else if (verb === 'EOSE') {
        const receivedSubId = msg[1];
        if (receivedSubId === this.subId) {
          this.status = 'eose';
          callbacks.onEose();
        }
      } else if (verb === 'CLOSED') {
        const receivedSubId = msg[1];
        if (receivedSubId === this.subId) {
          this.status = 'eose';
          callbacks.onEose();
        }
      }
    };

    const onErrorHandler = (event: Event | unknown): void => {
      if (this.status !== 'eose' && this.status !== 'closed') {
        this.status = 'error';
        const errorMsg =
          event && typeof event === 'object' && 'message' in event && typeof event.message === 'string'
            ? event.message
            : `WebSocket error on upstream ${this.url}`;
        callbacks.onError(new Error(errorMsg));
      }
    };

    const onCloseHandler = (): void => {
      if (this.status === 'connecting' || this.status === 'connected') {
        this.status = 'closed';
        callbacks.onEose();
      } else {
        this.status = 'closed';
      }
    };

    // Attach standard event listeners
    ws.addEventListener('open', onOpenHandler);
    ws.addEventListener('message', onMessageHandler);
    ws.addEventListener('error', onErrorHandler);
    ws.addEventListener('close', onCloseHandler);

    // In case the socket was synchronously opened already
    if (ws.readyState === WebSocket.OPEN) {
      onOpenHandler();
    }
  }

  /**
   * Gracefully closes the subscription and terminates the WebSocket connection.
   */
  public close(): void {
    if (!this.ws) {
      this.status = 'closed';
      return;
    }

    try {
      if (this.subId && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(formatCloseMessage(this.subId));
      }
    } catch {
      // Ignore send errors during teardown
    }

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
