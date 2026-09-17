/**
 * Mock WebSocket implementation for simulating upstream relays in unit tests.
 */
export class MockClientWebSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  public url: string;
  public readyState: number = MockClientWebSocket.CONNECTING;
  public sentMessages: string[] = [];
  public listeners: Map<string, Array<(...args: any[]) => void>> = new Map();

  public onopen: ((event: any) => void) | null = null;
  public onmessage: ((event: any) => void) | null = null;
  public onerror: ((event: any) => void) | null = null;
  public onclose: ((event: any) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    // Simulate async connection open
    setTimeout(() => {
      if (this.readyState === MockClientWebSocket.CONNECTING) {
        this.readyState = MockClientWebSocket.OPEN;
        this.emit('open', {});
        if (this.onopen) this.onopen({});
      }
    }, 10);
  }

  public addEventListener(type: string, listener: (...args: any[]) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  public removeEventListener(type: string, listener: (...args: any[]) => void): void {
    const list = this.listeners.get(type);
    if (list) {
      const idx = list.indexOf(listener);
      if (idx !== -1) list.splice(idx, 1);
    }
  }

  public send(data: string | ArrayBuffer): void {
    if (this.readyState !== MockClientWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.sentMessages.push(str);
  }

  public close(_code?: number, _reason?: string): void {
    if (this.readyState === MockClientWebSocket.CLOSED) return;
    this.readyState = MockClientWebSocket.CLOSED;
    this.emit('close', {});
    if (this.onclose) this.onclose({});
  }

  /**
   * Helper for tests to simulate incoming server message.
   */
  public simulateServerMessage(data: string): void {
    const event = { data };
    this.emit('message', event);
    if (this.onmessage) this.onmessage(event);
  }

  /**
   * Helper for tests to simulate server error.
   */
  public simulateServerError(errorMsg: string): void {
    const event = { message: errorMsg };
    this.emit('error', event);
    if (this.onerror) this.onerror(event);
  }

  private emit(type: string, event: any): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const h of handlers) {
        try {
          h(event);
        } catch (err) {
          console.error('EMIT ERROR in listener:', err);
        }
      }
    }
  }
}

/**
 * Creates a mock WebSocket factory that automatically replies with EOSE on REQ subscriptions.
 */
export function createAutoEoseWebSocketFactory(): (url: string) => WebSocket {
  return (url: string): WebSocket => {
    const mockWs = new MockClientWebSocket(url);
    const origSend = mockWs.send.bind(mockWs);

    mockWs.send = (data: string | ArrayBuffer): void => {
      origSend(data);
      const raw = typeof data === 'string' ? data : new TextDecoder().decode(data);
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed[0] === 'REQ') {
          const subId = parsed[1] as string;
          queueMicrotask(() => {
            if (mockWs.readyState === MockClientWebSocket.OPEN) {
              mockWs.simulateServerMessage(JSON.stringify(['EOSE', subId]));
            }
          });
        }
      } catch {
        // Ignore parse errors in mock handler
      }
    };

    return mockWs as unknown as WebSocket;
  };
}

