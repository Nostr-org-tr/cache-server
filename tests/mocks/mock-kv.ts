/**
 * In-memory Mock implementation of Cloudflare KVNamespace for unit and integration testing.
 */
interface KVEntry {
  value: string;
  expiresAt: number | undefined;
}

export class MockKVNamespace {
  private store = new Map<string, KVEntry>();

  async get(key: string, options?: unknown): Promise<any> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    // Check expiration if set
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    const type = typeof options === 'string' ? options : (options as { type?: string } | undefined)?.type ?? 'text';

    if (type === 'json') {
      try {
        return JSON.parse(entry.value);
      } catch {
        return null;
      }
    }

    if (type === 'arrayBuffer') {
      return new TextEncoder().encode(entry.value).buffer;
    }

    return entry.value;
  }

  async getWithMetadata<Metadata = unknown>(
    key: string,
    options?: unknown
  ): Promise<{ value: any; metadata: Metadata | null }> {
    const val = await this.get(key, options);
    return { value: val, metadata: null };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: {
      expiration?: number | undefined;
      expirationTtl?: number | undefined;
      metadata?: any;
    }
  ): Promise<void> {
    let stringValue = '';
    if (typeof value === 'string') {
      stringValue = value;
    } else if (value instanceof ArrayBuffer) {
      stringValue = new TextDecoder().decode(value);
    } else if (ArrayBuffer.isView(value)) {
      stringValue = new TextDecoder().decode(value);
    } else {
      stringValue = String(value);
    }

    let expiresAt: number | undefined;
    if (options?.expirationTtl !== undefined) {
      expiresAt = Date.now() + options.expirationTtl * 1000;
    } else if (options?.expiration !== undefined) {
      expiresAt = options.expiration * 1000;
    }

    this.store.set(key, { value: stringValue, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: {
    prefix?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<any> {
    const prefix = options?.prefix ?? '';
    const limit = options?.limit ?? 1000;
    const now = Date.now();

    const keys: Array<{ name: string; expiration?: number }> = [];

    for (const [k, entry] of this.store.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.store.delete(k);
        continue;
      }
      if (k.startsWith(prefix)) {
        const item: { name: string; expiration?: number } = { name: k };
        if (entry.expiresAt !== undefined) {
          item.expiration = Math.floor(entry.expiresAt / 1000);
        }
        keys.push(item);
        if (keys.length >= limit) {
          break;
        }
      }
    }

    return {
      keys,
      list_complete: true,
      cacheStatus: null,
    };
  }

  /**
   * Test helper to clear mock storage
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Test helper to inspect raw store size
   */
  size(): number {
    return this.store.size;
  }
}
