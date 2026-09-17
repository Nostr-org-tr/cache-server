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
      const res = await mockStmt.run<T>();
      results.push(res);
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
    if (q.includes('FROM event_tags') && q.includes('COUNT(*)')) {
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

    // Query 0.3: GROUP BY kind count
    if (q.includes('GROUP BY kind')) {
      const counts = new Map<number, number>();
      for (const ev of this.db.events.values()) {
        counts.set(ev.kind, (counts.get(ev.kind) || 0) + 1);
      }
      const sorted = Array.from(counts.entries())
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count);
      return {
        results: sorted as unknown as T[],
        success: true,
        meta: createMockMeta({ rows_read: sorted.length }),
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
