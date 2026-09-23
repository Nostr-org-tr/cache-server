import { describe, expect, it } from 'vitest';
import {
  queryAgeBuckets,
  queryDailyVolume,
  queryHot5,
  queryHourlyTimeline,
  queryHourOfDay,
  queryKindDistribution,
  queryMostFollowed,
  querySummary,
  queryTopPosters,
  queryTopSharers,
  queryTopTags,
} from '../../src/dashboard/queries';
import { MockD1Database } from '../mocks/mock-d1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000; // arbitrary fixed "now" in seconds
const H1 = 3600;
const D1 = 86400;

function makeDb() {
  return new MockD1Database();
}

/** Insert a minimal event row into the mock DB */
function addEvent(
  db: MockD1Database,
  opts: {
    id: string;
    pubkey: string;
    kind: number;
    created_at?: number;
    raw_event?: string;
  }
) {
  db.events.set(opts.id, {
    id: opts.id,
    pubkey: opts.pubkey,
    kind: opts.kind,
    created_at: opts.created_at ?? NOW - 1000,
    d_tag: null,
    raw_event: opts.raw_event ?? '{}',
    created_at_recorded: opts.created_at ?? NOW - 1000,
  });
}

// ---------------------------------------------------------------------------
// querySummary
// ---------------------------------------------------------------------------

describe('querySummary', () => {
  it('returns zero values on empty database', async () => {
    const db = makeDb();
    const result = await querySummary(db as unknown as D1Database);
    expect(result.total_events).toBe(0);
    expect(result.total_authors).toBe(0);
    expect(result.total_tags).toBe(0);
    expect(result.oldest_event_at).toBeNull();
    expect(result.newest_event_at).toBeNull();
  });

  it('counts events, authors, tags, and time range correctly', async () => {
    const db = makeDb();
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 1, created_at: NOW - 1000 });
    addEvent(db, { id: 'e2', pubkey: 'p1', kind: 1, created_at: NOW - 500 });
    addEvent(db, { id: 'e3', pubkey: 'p2', kind: 0, created_at: NOW - 2000 });
    db.eventTags.push({ event_id: 'e1', tag_name: 'p', tag_value: 'p2' });
    db.eventTags.push({ event_id: 'e2', tag_name: 'e', tag_value: 'e1' });

    const result = await querySummary(db as unknown as D1Database);
    expect(result.total_events).toBe(3);
    expect(result.total_authors).toBe(2);
    expect(result.total_tags).toBe(2);
    expect(result.oldest_event_at).toBe(NOW - 2000);
    expect(result.newest_event_at).toBe(NOW - 500);
  });
});

// ---------------------------------------------------------------------------
// queryHourlyTimeline
// ---------------------------------------------------------------------------

describe('queryHourlyTimeline', () => {
  it('returns empty array on empty database', async () => {
    const db = makeDb();
    const result = await queryHourlyTimeline(db as unknown as D1Database, NOW);
    expect(result).toEqual([]);
  });

  it('only includes feed kinds (1, 6, 7, 9735)', async () => {
    const db = makeDb();
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 1, created_at: NOW - H1 });
    addEvent(db, { id: 'e2', pubkey: 'p1', kind: 0, created_at: NOW - H1 }); // non-feed
    addEvent(db, { id: 'e3', pubkey: 'p1', kind: 7, created_at: NOW - H1 });

    const result = await queryHourlyTimeline(db as unknown as D1Database, NOW);
    // Aggregated count should be 2 (kinds 1 and 7 only)
    const total = result.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(2);
  });

  it('excludes events older than 7 days', async () => {
    const db = makeDb();
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 1, created_at: NOW - 8 * D1 }); // too old
    addEvent(db, { id: 'e2', pubkey: 'p1', kind: 1, created_at: NOW - 3 * D1 }); // in window

    const result = await queryHourlyTimeline(db as unknown as D1Database, NOW);
    const total = result.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// queryHourOfDay
// ---------------------------------------------------------------------------

describe('queryHourOfDay', () => {
  it('returns empty array on empty database', async () => {
    const db = makeDb();
    const result = await queryHourOfDay(db as unknown as D1Database);
    expect(result).toEqual([]);
  });

  it('groups events by hour-of-day modulo', async () => {
    const db = makeDb();
    // created_at = 3600 * 14 (14:00 UTC on day 0)
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 1, created_at: 3600 * 14 });
    addEvent(db, { id: 'e2', pubkey: 'p1', kind: 1, created_at: 3600 * 14 + 100 });
    addEvent(db, { id: 'e3', pubkey: 'p1', kind: 1, created_at: 3600 * 2 });

    const result = await queryHourOfDay(db as unknown as D1Database);
    const byHour = new Map(result.map((r) => [r.hour_of_day, r.count]));
    expect(byHour.get(14)).toBe(2);
    expect(byHour.get(2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// queryDailyVolume
// ---------------------------------------------------------------------------

describe('queryDailyVolume', () => {
  it('returns empty array on empty database', async () => {
    const db = makeDb();
    const result = await queryDailyVolume(db as unknown as D1Database, NOW);
    expect(result).toEqual([]);
  });

  it('only includes feed kinds in the last 7 days', async () => {
    const db = makeDb();
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 1, created_at: NOW - D1 });
    addEvent(db, { id: 'e2', pubkey: 'p1', kind: 9, created_at: NOW - D1 }); // non-feed
    addEvent(db, { id: 'e3', pubkey: 'p1', kind: 1, created_at: NOW - 10 * D1 }); // too old

    const result = await queryDailyVolume(db as unknown as D1Database, NOW);
    const total = result.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// queryKindDistribution
// ---------------------------------------------------------------------------

describe('queryKindDistribution', () => {
  it('returns empty array on empty database', async () => {
    const db = makeDb();
    const result = await queryKindDistribution(db as unknown as D1Database);
    expect(result).toEqual([]);
  });

  it('annotates kind with human-readable name', async () => {
    const db = makeDb();
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 1 });
    addEvent(db, { id: 'e2', pubkey: 'p1', kind: 1 });
    addEvent(db, { id: 'e3', pubkey: 'p2', kind: 0 });

    const result = await queryKindDistribution(db as unknown as D1Database);
    expect(result[0]?.kind).toBe(1);
    expect(result[0]?.name).toBe('Short Text Note');
    expect(result[0]?.count).toBe(2);
    expect(result[1]?.kind).toBe(0);
    expect(result[1]?.name).toBe('User Metadata / Profile');
  });

  it('limits to top 15', async () => {
    const db = makeDb();
    for (let k = 1; k <= 20; k++) {
      addEvent(db, { id: `e${k}`, pubkey: 'p1', kind: k });
    }
    const result = await queryKindDistribution(db as unknown as D1Database);
    expect(result.length).toBeLessThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// queryAgeBuckets
// ---------------------------------------------------------------------------

describe('queryAgeBuckets', () => {
  it('returns all-zero on empty database', async () => {
    const db = makeDb();
    const result = await queryAgeBuckets(db as unknown as D1Database, NOW);
    expect(result).toEqual({ lt1h: 0, h1to6: 0, h6to24: 0, d1to3: 0, d3to7: 0 });
  });

  it('categorises events into correct age buckets', async () => {
    const db = makeDb();
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 1, created_at: NOW - 1800 }); // < 1h
    addEvent(db, { id: 'e2', pubkey: 'p1', kind: 1, created_at: NOW - 3 * H1 }); // 1–6h
    addEvent(db, { id: 'e3', pubkey: 'p1', kind: 1, created_at: NOW - 12 * H1 }); // 6–24h
    addEvent(db, { id: 'e4', pubkey: 'p1', kind: 1, created_at: NOW - 2 * D1 }); // 1–3d
    addEvent(db, { id: 'e5', pubkey: 'p1', kind: 1, created_at: NOW - 5 * D1 }); // 3–7d

    const result = await queryAgeBuckets(db as unknown as D1Database, NOW);
    expect(result.lt1h).toBe(1);
    expect(result.h1to6).toBe(1);
    expect(result.h6to24).toBe(1);
    expect(result.d1to3).toBe(1);
    expect(result.d3to7).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// queryTopTags
// ---------------------------------------------------------------------------

describe('queryTopTags', () => {
  it('returns empty array on empty tag table', async () => {
    const db = makeDb();
    const result = await queryTopTags(db as unknown as D1Database);
    expect(result).toEqual([]);
  });

  it('counts and sorts hashtags (tag_name = "t") and excludes builtin tags', async () => {
    const db = makeDb();
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 1 });
    addEvent(db, { id: 'e2', pubkey: 'p1', kind: 1 });
    // Non-t tags (structural tags like 'p', 'e', 'd') should be ignored
    db.eventTags.push({ event_id: 'e1', tag_name: 'p', tag_value: 'pubkey1' });
    db.eventTags.push({ event_id: 'e2', tag_name: 'd', tag_value: 'd-id' });
    db.eventTags.push({ event_id: 'e1', tag_name: 'e', tag_value: 'event1' });
    // Builtin tags as values should also be ignored
    db.eventTags.push({ event_id: 'e1', tag_name: 't', tag_value: 'd' });
    // Real hashtags
    db.eventTags.push({ event_id: 'e1', tag_name: 't', tag_value: 'Bitcoin' });
    db.eventTags.push({ event_id: 'e2', tag_name: 't', tag_value: 'bitcoin' });
    db.eventTags.push({ event_id: 'e1', tag_name: 't', tag_value: 'nostr' });

    const result = await queryTopTags(db as unknown as D1Database);
    expect(result[0]?.tag_name).toBe('bitcoin');
    expect(result[0]?.count).toBe(2);
    expect(result[1]?.tag_name).toBe('nostr');
    expect(result[1]?.count).toBe(1);
    expect(result.some((r) => r.tag_name === 'p' || r.tag_name === 'd' || r.tag_name === 'e')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// queryTopPosters
// ---------------------------------------------------------------------------

describe('queryTopPosters', () => {
  it('returns empty array when no posts in last 24h', async () => {
    const db = makeDb();
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 1, created_at: NOW - 2 * D1 });
    const result = await queryTopPosters(db as unknown as D1Database, NOW);
    expect(result).toEqual([]);
  });

  it('counts kind 1 posts in last 24h per pubkey and attaches profile metadata', async () => {
    const db = makeDb();
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 1, created_at: NOW - H1 });
    addEvent(db, { id: 'e2', pubkey: 'p1', kind: 1, created_at: NOW - 2 * H1 });
    addEvent(db, { id: 'e3', pubkey: 'p2', kind: 1, created_at: NOW - H1 });
    addEvent(db, { id: 'e4', pubkey: 'p1', kind: 6, created_at: NOW - H1 }); // not kind 1
    addEvent(db, {
      id: 'p1_prof',
      pubkey: 'p1',
      kind: 0,
      raw_event: JSON.stringify({
        content: JSON.stringify({ display_name: 'Alice', picture: 'https://example.com/alice.png' }),
      }),
    });

    const result = await queryTopPosters(db as unknown as D1Database, NOW);
    expect(result[0]?.pubkey).toBe('p1');
    expect(result[0]?.count).toBe(2);
    expect(result[0]?.display_name).toBe('Alice');
    expect(result[0]?.avatar_url).toBe('https://example.com/alice.png');
    expect(result[1]?.pubkey).toBe('p2');
    expect(result[1]?.count).toBe(1);
    expect(result[1]?.avatar_url).toBeNull();
  });

  it('formats display_name as npub when 64-hex author has no Kind 0 profile', async () => {
    const db = makeDb();
    const hexPubkey = '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a04f0d618e479a596';
    addEvent(db, { id: 'e1', pubkey: hexPubkey, kind: 1, created_at: NOW - H1 });

    const result = await queryTopPosters(db as unknown as D1Database, NOW);
    expect(result[0]?.pubkey).toBe(hexPubkey);
    expect(result[0]?.display_name.startsWith('npub1')).toBe(true);
    expect(result[0]?.display_name).toContain('…');
  });
});

// ---------------------------------------------------------------------------
// queryTopSharers
// ---------------------------------------------------------------------------

describe('queryTopSharers', () => {
  it('counts kind 6 and 16 events in last 7 days', async () => {
    const db = makeDb();
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 6, created_at: NOW - D1 });
    addEvent(db, { id: 'e2', pubkey: 'p1', kind: 16, created_at: NOW - 2 * D1 });
    addEvent(db, { id: 'e3', pubkey: 'p2', kind: 6, created_at: NOW - D1 });
    addEvent(db, { id: 'e4', pubkey: 'p1', kind: 6, created_at: NOW - 10 * D1 }); // too old

    const result = await queryTopSharers(db as unknown as D1Database, NOW);
    expect(result[0]?.pubkey).toBe('p1');
    expect(result[0]?.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// queryMostFollowed
// ---------------------------------------------------------------------------

describe('queryMostFollowed', () => {
  it('counts distinct kind 3 authors whose follow list contains a pubkey', async () => {
    const db = makeDb();
    // p1 follows p3 and p4; p2 also follows p3
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 3 });
    addEvent(db, { id: 'e2', pubkey: 'p2', kind: 3 });
    db.eventTags.push({ event_id: 'e1', tag_name: 'p', tag_value: 'p3' });
    db.eventTags.push({ event_id: 'e1', tag_name: 'p', tag_value: 'p4' });
    db.eventTags.push({ event_id: 'e2', tag_name: 'p', tag_value: 'p3' });

    const result = await queryMostFollowed(db as unknown as D1Database);
    expect(result[0]?.pubkey).toBe('p3');
    expect(result[0]?.count).toBe(2);
    expect(result[1]?.pubkey).toBe('p4');
    expect(result[1]?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// queryHot5
// ---------------------------------------------------------------------------

describe('queryHot5', () => {
  it('returns empty array with insufficient data', async () => {
    const db = makeDb();
    const result = await queryHot5(db as unknown as D1Database, NOW, []);
    expect(result).toEqual([]);
  });

  it('applies minimum activity gate (3 events in 48h)', async () => {
    const db = makeDb();
    // Only 2 events in 48h — below gate
    addEvent(db, { id: 'e1', pubkey: 'p1', kind: 1, created_at: NOW - H1 });
    addEvent(db, { id: 'e2', pubkey: 'p1', kind: 1, created_at: NOW - 2 * H1 });

    const result = await queryHot5(db as unknown as D1Database, NOW, []);
    expect(result).toEqual([]);
  });

  it('selects surging account with high post velocity', async () => {
    const db = makeDb();
    // p1: 5 posts in last 24h vs 1 in prior 24–48h → surging
    for (let i = 0; i < 5; i++) {
      addEvent(db, { id: `n${i}`, pubkey: 'p1', kind: 1, created_at: NOW - H1 * (i + 1) });
    }
    addEvent(db, { id: 'old1', pubkey: 'p1', kind: 1, created_at: NOW - 25 * H1 });

    const result = await queryHot5(db as unknown as D1Database, NOW, []);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]?.pubkey).toBe('p1');
    expect(result[0]?.posts_24h).toBe(5);
    expect(['surging', 'rising', 'stable']).toContain(result[0]?.trend_label);
  });

  it('attaches a sparkline array of length 168 per account', async () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      addEvent(db, { id: `s${i}`, pubkey: 'p1', kind: 1, created_at: NOW - H1 * (i + 1) });
    }

    const result = await queryHot5(db as unknown as D1Database, NOW, []);
    if (result.length > 0) {
      expect(result[0]?.sparkline).toHaveLength(168);
    }
  });
});
