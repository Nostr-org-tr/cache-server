import type { EventRow, EventTagRow } from '../../src/db/types';

function createMockMeta(overrides?: Partial<D1Meta>): D1Meta & Record<string, unknown> {
  return {
    duration: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changes: 0,
    size_after: 0,
    changed_db: false,
    ...overrides,
  };
}

/**
 * In-memory Mock implementation of Cloudflare D1Database for unit testing.
 */
export class MockD1Database implements D1Database {
  public events = new Map<string, EventRow>();
  public eventTags: EventTagRow[] = [];

  prepare(query: string): D1PreparedStatement {
    return new MockD1PreparedStatement(this, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const stmt of statements) {
      const mockStmt = stmt as MockD1PreparedStatement;
      const q = (mockStmt as unknown as { query: string }).query.trim().toUpperCase();
      if (q.startsWith('INSERT') || q.startsWith('DELETE') || q.startsWith('UPDATE')) {
        const res = await mockStmt.run<T>();
        results.push(res);
      } else {
        const res = await mockStmt.all<T>();
        results.push(res);
      }
    }
    return results;
  }

  async exec(_query: string): Promise<D1ExecResult> {
    return { count: 0, duration: 0 };
  }

  withSession(_constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint): D1DatabaseSession {
    return {
      prepare: (query: string) => this.prepare(query),
      batch: <T = unknown>(statements: D1PreparedStatement[]) => this.batch<T>(statements),
      getBookmark: () => null,
    };
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}

export class MockD1PreparedStatement implements D1PreparedStatement {
  private boundParams: unknown[] = [];

  constructor(
    private db: MockD1Database,
    private query: string
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const stmt = new MockD1PreparedStatement(this.db, this.query);
    stmt.boundParams = values;
    return stmt;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const res = await this.all<T>();
    if (res.results && res.results.length > 0) {
      const firstRow = res.results[0];
      if (colName && firstRow && typeof firstRow === 'object') {
        return (firstRow as Record<string, unknown>)[colName] as T;
      }
      return firstRow ?? null;
    }
    return null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const q = this.query.trim();

    // Query 0: SELECT 1 AS alive
    if (q.includes('SELECT 1 AS alive') || q === 'SELECT 1' || q.startsWith('SELECT 1 AS')) {
      return {
        results: [{ alive: 1 } as unknown as T],
        success: true,
        meta: createMockMeta({ rows_read: 1 }),
      };
    }

    // Query 0.1: SELECT COUNT(*) AS total FROM event_tags
    if (q.includes('FROM event_tags') && (q.includes('COUNT(*) AS total') || q.includes('COUNT(*) as total')) && !q.includes('GROUP BY')) {
      return {
        results: [{ total: this.db.eventTags.length } as unknown as T],
        success: true,
        meta: createMockMeta({ rows_read: this.db.eventTags.length }),
      };
    }

    // Query 0.2: SELECT COUNT(*) AS total FROM events
    if (q.includes('FROM events') && (q.includes('COUNT(*) AS total') || q.includes('COUNT(*) as total'))) {
      return {
        results: [{ total: this.db.events.size } as unknown as T],
        success: true,
        meta: createMockMeta({ rows_read: this.db.events.size }),
      };
    }

    // Query 0.25: SELECT COUNT(DISTINCT pubkey) AS total FROM events
    if (q.includes('COUNT(DISTINCT pubkey)')) {
      const distinctPubkeys = new Set(Array.from(this.db.events.values()).map((e) => e.pubkey));
      return {
        results: [{ total: distinctPubkeys.size } as unknown as T],
        success: true,
        meta: createMockMeta({ rows_read: this.db.events.size }),
      };
    }

    // Query 0.26: SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM events
    if (q.includes('MIN(created_at)') || q.includes('MAX(created_at)')) {
      const allEvents = Array.from(this.db.events.values());
      let oldest: number | null = null;
      let newest: number | null = null;
      if (allEvents.length > 0) {
        oldest = Math.min(...allEvents.map((e) => e.created_at));
        newest = Math.max(...allEvents.map((e) => e.created_at));
      }
      return {
        results: [{ oldest, newest } as unknown as T],
        success: true,
        meta: createMockMeta({ rows_read: allEvents.length }),
      };
    }

    // Query 0.3: GROUP BY kind count
    if (q.includes('GROUP BY kind')) {
      const counts = new Map<number, number>();
      for (const ev of this.db.events.values()) {
        counts.set(ev.kind, (counts.get(ev.kind) || 0) + 1);
      }
      let sorted = Array.from(counts.entries())
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count);
      const limitMatch = q.match(/LIMIT\s+(\d+)/i);
      if (limitMatch && limitMatch[1]) {
        sorted = sorted.slice(0, parseInt(limitMatch[1], 10));
      }
      return {
        results: sorted as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: sorted.length }),
      };
    }

    // Dashboard B1: Hourly timeline (hour_bucket)
    if (q.includes('AS hour_bucket') && q.includes('GROUP BY hour_bucket')) {
      const isSparkline = q.includes('pubkey = ?');
      let events = Array.from(this.db.events.values());
      if (isSparkline) {
        const pubkey = this.boundParams[0] as string;
        const since = this.boundParams[1] as number;
        events = events.filter((e) => e.pubkey === pubkey && e.kind === 1 && e.created_at >= since);
      } else {
        const since = this.boundParams[0] as number;
        const kinds = this.boundParams.slice(1) as number[];
        events = events.filter((e) => e.created_at >= since && (kinds.length === 0 || kinds.includes(e.kind)));
      }
      const buckets = new Map<number, number>();
      for (const ev of events) {
        const b = Math.floor(ev.created_at / 3600) * 3600;
        buckets.set(b, (buckets.get(b) || 0) + 1);
      }
      const sorted = Array.from(buckets.entries())
        .map(([hour_bucket, count]) => ({ hour_bucket, count }))
        .sort((a, b) => a.hour_bucket - b.hour_bucket);
      return {
        results: sorted as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: sorted.length }),
      };
    }

    // Dashboard B2: Hour of day
    if (q.includes('AS hour_of_day') && q.includes('GROUP BY hour_of_day')) {
      const buckets = new Map<number, number>();
      for (const ev of this.db.events.values()) {
        const h = Math.floor((ev.created_at % 86400) / 3600);
        buckets.set(h, (buckets.get(h) || 0) + 1);
      }
      const sorted = Array.from(buckets.entries())
        .map(([hour_of_day, count]) => ({ hour_of_day, count }))
        .sort((a, b) => a.hour_of_day - b.hour_of_day);
      return {
        results: sorted as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: sorted.length }),
      };
    }

    // Dashboard B3: Daily volume (day_bucket)
    if (q.includes('AS day_bucket') && q.includes('GROUP BY day_bucket')) {
      const since = this.boundParams[0] as number;
      const kinds = this.boundParams.slice(1) as number[];
      const events = Array.from(this.db.events.values()).filter(
        (e) => e.created_at >= since && (kinds.length === 0 || kinds.includes(e.kind))
      );
      const buckets = new Map<number, number>();
      for (const ev of events) {
        const d = Math.floor(ev.created_at / 86400) * 86400;
        buckets.set(d, (buckets.get(d) || 0) + 1);
      }
      const sorted = Array.from(buckets.entries())
        .map(([day_bucket, count]) => ({ day_bucket, count }))
        .sort((a, b) => a.day_bucket - b.day_bucket);
      return {
        results: sorted as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: sorted.length }),
      };
    }

    // Dashboard B5: Age buckets count queries
    if (q.includes('FROM events WHERE created_at >=')) {
      if (q.includes('AND created_at < ?')) {
        const since = this.boundParams[0] as number;
        const until = this.boundParams[1] as number;
        const count = Array.from(this.db.events.values()).filter(
          (e) => e.created_at >= since && e.created_at < until
        ).length;
        return {
          results: [{ count } as unknown as T],
          success: true,
          meta: createMockMeta({ rows_read: count }),
        };
      } else {
        const since = this.boundParams[0] as number;
        const count = Array.from(this.db.events.values()).filter(
          (e) => e.created_at >= since
        ).length;
        return {
          results: [{ count } as unknown as T],
          success: true,
          meta: createMockMeta({ rows_read: count }),
        };
      }
    }

    // Dashboard B6: Top tags
    if (q.includes('FROM event_tags') && q.includes('GROUP BY tag_name')) {
      const tagCounts = new Map<string, number>();
      for (const t of this.db.eventTags) {
        tagCounts.set(t.tag_name, (tagCounts.get(t.tag_name) || 0) + 1);
      }
      let sorted = Array.from(tagCounts.entries())
        .map(([tag_name, count]) => ({ tag_name, count }))
        .sort((a, b) => b.count - a.count);
      const limitMatch = q.match(/LIMIT\s+(\d+)/i);
      if (limitMatch && limitMatch[1]) {
        sorted = sorted.slice(0, parseInt(limitMatch[1], 10));
      }
      return {
        results: sorted as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: sorted.length }),
      };
    }

    // Dashboard C1 / C2: Leaderboard Posters / Sharers
    if (q.includes('GROUP BY e.pubkey') && q.includes('FROM events e')) {
      if (q.includes('e.kind = 3')) {
        // C4: Most Following
        const counts = new Map<string, number>();
        for (const [eventId, ev] of this.db.events.entries()) {
          if (ev.kind === 3) {
            const pTags = this.db.eventTags.filter((t) => t.event_id === eventId && t.tag_name === 'p');
            counts.set(ev.pubkey, pTags.length);
          }
        }
        let sorted = Array.from(counts.entries())
          .map(([pubkey, count]) => {
            const profile = Array.from(this.db.events.values()).find((e) => e.pubkey === pubkey && e.kind === 0);
            return {
              pubkey,
              count,
              display_name: profile ? 'Profile Name' : `${pubkey.slice(0, 16)}...`,
            };
          })
          .sort((a, b) => b.count - a.count);
        return {
          results: sorted.slice(0, 10) as unknown as T[],
          success: true,
          meta: createMockMeta({ rows_read: sorted.length }),
        };
      }

      const since = this.boundParams[0] as number;
      const isKind1 = q.includes('e.kind = 1');
      const isSharer = q.includes('e.kind IN (6, 16)');
      const counts = new Map<string, number>();

      for (const ev of this.db.events.values()) {
        if (ev.created_at >= since) {
          if (isKind1 && ev.kind === 1) {
            counts.set(ev.pubkey, (counts.get(ev.pubkey) || 0) + 1);
          } else if (isSharer && (ev.kind === 6 || ev.kind === 16)) {
            counts.set(ev.pubkey, (counts.get(ev.pubkey) || 0) + 1);
          }
        }
      }

      let sorted = Array.from(counts.entries())
        .map(([pubkey, count]) => {
          const profile = Array.from(this.db.events.values()).find((e) => e.pubkey === pubkey && e.kind === 0);
          return {
            pubkey,
            count,
            display_name: profile ? 'Profile Name' : `${pubkey.slice(0, 16)}...`,
          };
        })
        .sort((a, b) => b.count - a.count);

      return {
        results: sorted.slice(0, 10) as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: sorted.length }),
      };
    }

    // Dashboard C3: Most Followed
    if (q.includes('FROM event_tags t') && q.includes('JOIN events e') && q.includes('e.kind = 3') && q.includes('GROUP BY t.tag_value')) {
      const followersMap = new Map<string, Set<string>>();
      for (const t of this.db.eventTags) {
        if (t.tag_name === 'p') {
          const parentEv = this.db.events.get(t.event_id);
          if (parentEv && parentEv.kind === 3) {
            if (!followersMap.has(t.tag_value)) {
              followersMap.set(t.tag_value, new Set());
            }
            followersMap.get(t.tag_value)!.add(parentEv.pubkey);
          }
        }
      }
      let sorted = Array.from(followersMap.entries())
        .map(([pubkey, followerSet]) => {
          const profile = Array.from(this.db.events.values()).find((e) => e.pubkey === pubkey && e.kind === 0);
          return {
            pubkey,
            count: followerSet.size,
            display_name: profile ? 'Profile Name' : `${pubkey.slice(0, 16)}...`,
          };
        })
        .sort((a, b) => b.count - a.count);

      return {
        results: sorted.slice(0, 10) as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: sorted.length }),
      };
    }

    // Dashboard D (Hot 5): Post counts in window
    if (q.includes('FROM events') && q.includes('WHERE kind = 1 AND created_at >=') && q.includes('GROUP BY pubkey')) {
      const since = this.boundParams[0] as number;
      const until = this.boundParams[1] as number | undefined;
      const counts = new Map<string, number>();
      for (const ev of this.db.events.values()) {
        if (ev.kind === 1 && ev.created_at >= since && (until === undefined || ev.created_at < until)) {
          counts.set(ev.pubkey, (counts.get(ev.pubkey) || 0) + 1);
        }
      }
      const results = Array.from(counts.entries()).map(([pubkey, count]) => ({ pubkey, count }));
      return {
        results: results as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: results.length }),
      };
    }

    // Dashboard D (Hot 5): Mention counts in window
    if (q.includes('FROM event_tags t') && q.includes('WHERE t.tag_name = \'p\' AND e.created_at >=') && q.includes('GROUP BY t.tag_value')) {
      const since = this.boundParams[0] as number;
      const until = this.boundParams[1] as number | undefined;
      const counts = new Map<string, number>();
      for (const t of this.db.eventTags) {
        if (t.tag_name === 'p') {
          const ev = this.db.events.get(t.event_id);
          if (ev && (ev.kind === 1 || ev.kind === 6 || ev.kind === 7)) {
            if (ev.created_at >= since && (until === undefined || ev.created_at < until)) {
              counts.set(t.tag_value, (counts.get(t.tag_value) || 0) + 1);
            }
          }
        }
      }
      const results = Array.from(counts.entries()).map(([pubkey, count]) => ({ pubkey, count }));
      return {
        results: results as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: results.length }),
      };
    }

    // Dashboard Hot 5 name resolution
    if (q.includes('WHERE e.pubkey = ? AND e.kind = 0') || (q.includes('display_name') && q.includes('e.kind = 0'))) {
      const pubkey = this.boundParams[0] as string;
      const profile = Array.from(this.db.events.values()).find((e) => e.pubkey === pubkey && e.kind === 0);
      return {
        results: [{ display_name: profile ? 'Profile Name' : `${pubkey.slice(0, 16)}...` } as unknown as T],
        success: true,
        meta: createMockMeta({ rows_read: 1 }),
      };
    }

    // Query 1: SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? LIMIT 1
    if (q.startsWith('SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? LIMIT 1')) {
      const pubkey = this.boundParams[0] as string;
      const kind = this.boundParams[1] as number;
      for (const ev of this.db.events.values()) {
        if (ev.pubkey === pubkey && ev.kind === kind) {
          return {
            results: [{ id: ev.id, created_at: ev.created_at } as unknown as T],
            success: true,
            meta: createMockMeta({ rows_read: 1 }),
          };
        }
      }
      return { results: [], success: true, meta: createMockMeta() };
    }

    // Query 2: SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ? LIMIT 1
    if (q.startsWith('SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ? LIMIT 1')) {
      const pubkey = this.boundParams[0] as string;
      const kind = this.boundParams[1] as number;
      const dTag = this.boundParams[2] as string;
      for (const ev of this.db.events.values()) {
        if (ev.pubkey === pubkey && ev.kind === kind && ev.d_tag === dTag) {
          return {
            results: [{ id: ev.id, created_at: ev.created_at } as unknown as T],
            success: true,
            meta: createMockMeta({ rows_read: 1 }),
          };
        }
      }
      return { results: [], success: true, meta: createMockMeta() };
    }

    // Query 3: SELECT id FROM events WHERE id = ? LIMIT 1
    if (q.startsWith('SELECT id FROM events WHERE id = ? LIMIT 1')) {
      const id = this.boundParams[0] as string;
      const ev = this.db.events.get(id);
      if (ev) {
        return {
          results: [{ id: ev.id } as unknown as T],
          success: true,
          meta: createMockMeta({ rows_read: 1 }),
        };
      }
      return { results: [], success: true, meta: createMockMeta() };
    }

    // Query 4: SELECT COUNT(*) as count FROM events ...
    if (q.startsWith('SELECT COUNT(*) as count FROM events')) {
      const rows = this.filterRows();
      return {
        results: [{ count: rows.length } as unknown as T],
        success: true,
        meta: createMockMeta({ rows_read: rows.length }),
      };
    }

    // Query 5: SELECT raw_event FROM events WHERE kind = 10002 AND pubkey IN (...)
    if (q.startsWith('SELECT raw_event FROM events WHERE kind = 10002 AND pubkey IN')) {
      const pubkeys = this.boundParams as string[];
      const matchedRows = Array.from(this.db.events.values()).filter(
        (ev) => ev.kind === 10002 && pubkeys.includes(ev.pubkey)
      );
      return {
        results: matchedRows.map((r) => ({ raw_event: r.raw_event })) as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: matchedRows.length }),
      };
    }

    // Query 6: General SELECT ... FROM events
    if (q.startsWith('SELECT id, pubkey, created_at, kind, d_tag, raw_event, created_at_recorded FROM events') || q.startsWith('SELECT')) {
      let rows = this.filterRows();
      // Sort by created_at DESC
      rows.sort((a, b) => b.created_at - a.created_at);

      // Check limit param (last parameter)
      if (this.boundParams.length > 0) {
        const lastParam = this.boundParams[this.boundParams.length - 1];
        if (typeof lastParam === 'number' && lastParam > 0) {
          rows = rows.slice(0, lastParam);
        }
      }

      return {
        results: rows as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: rows.length }),
      };
    }

    return { results: [], success: true, meta: createMockMeta() };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const q = this.query.trim();

    // INSERT INTO events / INSERT OR IGNORE INTO events
    if (q.startsWith('INSERT INTO events') || q.startsWith('INSERT OR IGNORE INTO events')) {
      const id = this.boundParams[0] as string;
      const pubkey = this.boundParams[1] as string;
      const createdAt = this.boundParams[2] as number;
      const kind = this.boundParams[3] as number;
      const dTag = (this.boundParams[4] as string | null | undefined) ?? null;
      const rawEvent = this.boundParams[5] as string;
      const recordedAt = this.boundParams[6] as number;

      if (!this.db.events.has(id) || q.startsWith('INSERT INTO events')) {
        this.db.events.set(id, {
          id,
          pubkey,
          created_at: createdAt,
          kind,
          d_tag: dTag,
          raw_event: rawEvent,
          created_at_recorded: recordedAt,
        });
      }
      return { results: [], success: true, meta: createMockMeta({ rows_written: 1, changes: 1 }) };
    }

    // INSERT INTO event_tags / INSERT OR IGNORE INTO event_tags
    if (q.startsWith('INSERT INTO event_tags') || q.startsWith('INSERT OR IGNORE INTO event_tags')) {
      const eventId = this.boundParams[0] as string;
      const tagName = this.boundParams[1] as string;
      const tagValue = this.boundParams[2] as string;

      const exists = this.db.eventTags.some(
        (t) => t.event_id === eventId && t.tag_name === tagName && t.tag_value === tagValue
      );
      if (!exists) {
        this.db.eventTags.push({ event_id: eventId, tag_name: tagName, tag_value: tagValue });
      }
      return { results: [], success: true, meta: createMockMeta({ rows_written: 1, changes: 1 }) };
    }

    // DELETE FROM events WHERE id = ?
    if (q.startsWith('DELETE FROM events WHERE id = ?')) {
      const id = this.boundParams[0] as string;
      this.db.events.delete(id);
      this.db.eventTags = this.db.eventTags.filter((t) => t.event_id !== id);
      return { results: [], success: true, meta: createMockMeta({ rows_written: 1, changes: 1 }) };
    }

    // DELETE FROM event_tags WHERE event_id IN (...)
    if (q.startsWith('DELETE FROM event_tags WHERE event_id IN')) {
      const idsToDelete = this.boundParams as string[];
      const initialCount = this.db.eventTags.length;
      this.db.eventTags = this.db.eventTags.filter((t) => !idsToDelete.includes(t.event_id));
      const deletedCount = initialCount - this.db.eventTags.length;
      return { results: [], success: true, meta: createMockMeta({ rows_written: deletedCount, changes: deletedCount }) };
    }

    // DELETE FROM events WHERE id IN (...) [optional: AND pubkey = ?]
    if (q.startsWith('DELETE FROM events WHERE id IN')) {
      if (q.includes('AND pubkey = ?')) {
        const pubkey = (this.boundParams[this.boundParams.length - 1] as string | undefined) ?? '';
        const idsToDelete = this.boundParams.slice(0, -1) as string[];
        let deletedCount = 0;

        for (const id of idsToDelete) {
          const ev = this.db.events.get(id);
          if (ev && ev.pubkey.toLowerCase() === pubkey.toLowerCase()) {
            this.db.events.delete(id);
            this.db.eventTags = this.db.eventTags.filter((t) => t.event_id !== id);
            deletedCount++;
          }
        }
        return { results: [], success: true, meta: createMockMeta({ rows_written: deletedCount, changes: deletedCount }) };
      } else {
        const idsToDelete = this.boundParams as string[];
        let deletedCount = 0;

        for (const id of idsToDelete) {
          if (this.db.events.delete(id)) {
            this.db.eventTags = this.db.eventTags.filter((t) => t.event_id !== id);
            deletedCount++;
          }
        }
        return { results: [], success: true, meta: createMockMeta({ rows_written: deletedCount, changes: deletedCount }) };
      }
    }

    // DELETE FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ?
    if (q.startsWith('DELETE FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ?')) {
      const pubkey = (this.boundParams[0] as string | undefined) ?? '';
      const kind = this.boundParams[1] as number;
      const dTag = (this.boundParams[2] as string | undefined) ?? '';
      let deletedCount = 0;

      for (const [id, ev] of this.db.events.entries()) {
        if (ev.pubkey.toLowerCase() === pubkey.toLowerCase() && ev.kind === kind && ev.d_tag === dTag) {
          this.db.events.delete(id);
          this.db.eventTags = this.db.eventTags.filter((t) => t.event_id !== id);
          deletedCount++;
        }
      }
      return { results: [], success: true, meta: createMockMeta({ rows_written: deletedCount, changes: deletedCount }) };
    }

    return { results: [], success: true, meta: createMockMeta() };
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(_options?: { columnNames?: boolean }): Promise<unknown> {
    const res = await this.all();
    return (res.results || []).map((row) => Object.values(row as Record<string, unknown>) as T);
  }

  private filterRows(): EventRow[] {
    let rows = Array.from(this.db.events.values());
    const q = this.query;

    if (q.includes('WHERE 1 = 0')) {
      return [];
    }

    let paramIdx = 0;

    // 1. Check id IN (?, ?) (excluding subqueries)
    const idMatch = q.match(/\bid IN \(((?:\s*\?\s*,?\s*)+)\)/);
    if (idMatch && idMatch[1] && !idMatch[1].includes('SELECT')) {
      const count = idMatch[1].split(',').length;
      const ids = this.boundParams.slice(paramIdx, paramIdx + count) as string[];
      paramIdx += count;
      rows = rows.filter((r) => ids.includes(r.id.toLowerCase()));
    }

    // Check id LIKE ?
    if (q.includes('id LIKE ?')) {
      const prefix = (this.boundParams[paramIdx++] as string).replace('%', '');
      rows = rows.filter((r) => r.id.toLowerCase().startsWith(prefix));
    }

    // 2. Check pubkey IN (...)
    if (q.includes('pubkey IN')) {
      const pubkeyMatch = q.match(/\bpubkey IN \(([^)]+)\)/);
      if (pubkeyMatch && pubkeyMatch[1]) {
        const count = pubkeyMatch[1].split(',').length;
        const pubkeys = this.boundParams.slice(paramIdx, paramIdx + count) as string[];
        paramIdx += count;
        rows = rows.filter((r) => pubkeys.includes(r.pubkey.toLowerCase()));
      }
    }

    // Check pubkey LIKE ?
    if (q.includes('pubkey LIKE ?')) {
      const prefix = (this.boundParams[paramIdx++] as string).replace('%', '');
      rows = rows.filter((r) => r.pubkey.toLowerCase().startsWith(prefix));
    }

    // 3. Check kind IN (...)
    if (q.includes('kind IN')) {
      const kindMatch = q.match(/\bkind IN \(([^)]+)\)/);
      if (kindMatch && kindMatch[1]) {
        const count = kindMatch[1].split(',').length;
        const kinds = this.boundParams.slice(paramIdx, paramIdx + count) as number[];
        paramIdx += count;
        rows = rows.filter((r) => kinds.includes(r.kind));
      }
    }

    // 3.1 Check kind >= ? AND kind <= ?
    if (q.includes('kind >= ? AND kind <= ?')) {
      const minKind = this.boundParams[paramIdx++] as number;
      const maxKind = this.boundParams[paramIdx++] as number;
      rows = rows.filter((r) => r.kind >= minKind && r.kind <= maxKind);
    }

    // 3.2 Check kind NOT IN (...)
    if (q.includes('kind NOT IN')) {
      const notKindMatch = q.match(/\bkind NOT IN \(([^)]+)\)/);
      if (notKindMatch && notKindMatch[1]) {
        const count = notKindMatch[1].split(',').length;
        const notKinds = this.boundParams.slice(paramIdx, paramIdx + count) as number[];
        paramIdx += count;
        rows = rows.filter((r) => !notKinds.includes(r.kind));
      }
    }

    // 3.3 Check NOT (kind >= ? AND kind <= ?)
    if (q.includes('NOT (kind >= ? AND kind <= ?)')) {
      const notRegex = /NOT \(kind >= \? AND kind <= \?\)/g;
      while (notRegex.exec(q) !== null) {
        const minK = this.boundParams[paramIdx++] as number;
        const maxK = this.boundParams[paramIdx++] as number;
        rows = rows.filter((r) => !(r.kind >= minK && r.kind <= maxK));
      }
    }

    // 4. Check created_at >= ?
    if (q.includes('created_at >=')) {
      const since = this.boundParams[paramIdx++] as number;
      rows = rows.filter((r) => r.created_at >= since);
    }

    // 5. Check created_at <= ?
    if (q.includes('created_at <=')) {
      const until = this.boundParams[paramIdx++] as number;
      rows = rows.filter((r) => r.created_at <= until);
    }

    // 5.1 Check created_at_recorded < ?
    if (q.includes('created_at_recorded < ?')) {
      const recordedCutoff = this.boundParams[paramIdx++] as number;
      rows = rows.filter((r) => r.created_at_recorded < recordedCutoff);
    }

    // 6. Check tags subquery
    if (q.includes('event_tags WHERE tag_name = ? AND tag_value IN')) {
      const regex = /tag_name = \? AND tag_value IN \(([^)]+)\)/g;
      let match;
      while ((match = regex.exec(q)) !== null) {
        if (!match[1]) continue;
        const tagName = this.boundParams[paramIdx++] as string;
        const count = match[1].split(',').length;
        const tagValues = this.boundParams.slice(paramIdx, paramIdx + count) as string[];
        paramIdx += count;

        const matchingEventIds = new Set(
          this.db.eventTags
            .filter((t) => t.tag_name === tagName && tagValues.includes(t.tag_value))
            .map((t) => t.event_id)
        );
        rows = rows.filter((r) => matchingEventIds.has(r.id));
      }
    }

    return rows;
  }
}
