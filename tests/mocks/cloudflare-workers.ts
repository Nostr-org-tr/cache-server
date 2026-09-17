export interface MockWebSocketTagMap {
  [key: string]: WebSocket[];
}

export class MockDurableObjectState implements DurableObjectState {
  id: DurableObjectId = {
    toString: () => 'mock-do-id',
    equals: () => true,
    name: 'mock-do',
  };
  storage: DurableObjectStorage = {} as DurableObjectStorage;
  props: unknown = undefined;
  facets: DurableObjectFacets = {} as DurableObjectFacets;
  private websockets: WebSocket[] = [];

  private tagsMap: Map<WebSocket, string[]> = new Map();

  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  setHibernatableWebSocketEventTimeout(_timeoutMs?: number): void {}
  getHibernatableWebSocketEventTimeout(): null {
    return null;
  }
  abort(_reason?: unknown): void {}

  waitUntil(_promise: Promise<unknown>): void {
    // No-op for mock
  }

  acceptWebSocket(ws: WebSocket, tags?: string[]): void {
    this.websockets.push(ws);
    if (tags) {
      this.tagsMap.set(ws, tags);
    }
  }

  getWebSockets(tag?: string): WebSocket[] {
    if (!tag) {
      return [...this.websockets];
    }
    return this.websockets.filter((ws) => {
      const tags = this.tagsMap.get(ws);
      return tags && tags.includes(tag);
    });
  }

  getTags(ws: WebSocket): string[] {
    return this.tagsMap.get(ws) ?? [];
  }


  setWebSocketAutoResponse(_maybeReqResp?: unknown): void {}
  getWebSocketAutoResponse(): null {
    return null;
  }
  getWebSocketAutoResponseTimestamp(_ws: WebSocket): null {
    return null;
  }
  async setAlarm(_scheduledTime: number | Date): Promise<void> {}
  async getAlarm(): Promise<number | null> {
    return null;
  }
  async deleteAlarm(): Promise<void> {}
}

export class DurableObject<Env = unknown> {
  ctx: DurableObjectState;
  env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

// Polyfill Response for Cloudflare Workers 101 Switching Protocols in Node test runner
const OriginalResponse = globalThis.Response;

class WorkersResponse extends OriginalResponse {
  override webSocket: WebSocket | null = null;
  private _status?: number | undefined;

  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: WebSocket | null }) {
    if (init && init.status === 101) {
      super(null, { ...init, status: 200 });
      this._status = 101;
      this.webSocket = init.webSocket ?? null;
    } else {
      super(body, init);
      if (init && init.webSocket) {
        this.webSocket = init.webSocket;
      }
    }
  }

  override get status(): number {
    return this._status ?? super.status;
  }
}

if (typeof globalThis !== 'undefined' && globalThis.Response && (globalThis.Response as unknown) !== WorkersResponse) {
  globalThis.Response = WorkersResponse as unknown as typeof Response;
}



