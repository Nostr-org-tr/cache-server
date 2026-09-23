import { describe, expect, it } from 'vitest';
import { renderDashboardHtml, renderPlaceholderHtml } from '../../src/dashboard/renderer';
import type { DashboardData } from '../../src/dashboard/types';
import { encodeNpub, shortenNpub } from '../../src/protocol/nip19';

// ---------------------------------------------------------------------------
// Minimal valid DashboardData fixture
// ---------------------------------------------------------------------------

const FIXED_TS = 1_700_000_000;

const MINIMAL_DATA: DashboardData = {
  generatedAt: FIXED_TS,
  summary: {
    total_events: 42_000,
    total_authors: 1_234,
    total_tags: 120_000,
    oldest_event_at: FIXED_TS - 7 * 86400,
    newest_event_at: FIXED_TS - 60,
  },
  hourlyTimeline: [
    { hour_bucket: FIXED_TS - 7200, count: 150 },
    { hour_bucket: FIXED_TS - 3600, count: 200 },
  ],
  hourOfDay: Array.from({ length: 24 }, (_, h) => ({ hour_of_day: h, count: h * 10 })),
  dailyVolume: [
    { day_bucket: FIXED_TS - 2 * 86400, count: 1000 },
    { day_bucket: FIXED_TS - 86400, count: 1500 },
  ],
  kindDist: [
    { kind: 1, name: 'Short Text Note', count: 25_000 },
    { kind: 0, name: 'User Metadata / Profile', count: 5_000 },
  ],
  ageBuckets: { lt1h: 100, h1to6: 500, h6to24: 2000, d1to3: 8000, d3to7: 30_000 },
  topTags: [
    { tag_name: 'bitcoin', count: 80_000 },
    { tag_name: 'nostr', count: 40_000 },
  ],
  topPosters: [
    { pubkey: 'a'.repeat(64), display_name: 'Alice', avatar_url: 'https://example.com/alice.png', count: 50 },
    { pubkey: 'b'.repeat(64), display_name: 'Bob', avatar_url: null, count: 30 },
  ],
  topSharers: [
    { pubkey: 'c'.repeat(64), display_name: 'Carol', avatar_url: null, count: 20 },
  ],
  mostFollowed: [
    { pubkey: 'd'.repeat(64), display_name: 'Dave', avatar_url: 'https://example.com/dave.png', count: 800 },
  ],
  hot5: [
    {
      pubkey: 'f'.repeat(64),
      display_name: 'Frank',
      avatar_url: 'https://example.com/frank.png',
      posts_24h: 12,
      mentions_24h: 40,
      trend_score: 4.2,
      trend_label: 'surging',
      sparkline: new Array(168).fill(0).map((_, i) => i % 10),
    },
  ],
  relay: {
    name: 'Test Relay',
    version: '1.2.0',
    pubkey: '46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a',
    contact: 'admin@example.com',
    upstream_relays: ['wss://relay.damus.io', 'wss://nos.lol'],
    gc_schedule: 'Daily at 03:00 UTC (0 3 * * *)',
  },
};

// ---------------------------------------------------------------------------
// renderDashboardHtml
// ---------------------------------------------------------------------------

describe('renderDashboardHtml', () => {
  it('is a non-empty HTML string starting with <!DOCTYPE html>', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(10_000);
    expect(html.trimStart().startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('contains chart canvas IDs for Section B (b1-b6) and not C charts', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    const expected = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
    for (const id of expected) {
      expect(html).toContain(`id="chart-${id}"`);
    }
    // C charts are now rendered as user cards, not canvases
    const removed = ['c1', 'c2', 'c3', 'c4'];
    for (const id of removed) {
      expect(html).not.toContain(`id="chart-${id}"`);
    }
  });

  it('embeds JSON data island script tags for b1-b6', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    const expected = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];
    for (const id of expected) {
      expect(html).toContain(`id="data-${id}"`);
    }
  });

  it('inlines Chart.js bundle directly for self-contained execution without external CDN', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).toContain('Chart.js');
  });

  it('includes summary card values', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    // 42000 → rendered as "42.0K"
    expect(html).toContain('42.0K');
    // 1234 → "1.2K"
    expect(html).toContain('1.2K');
  });

  it('embeds relay name and version', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    expect(html).toContain('Test Relay');
    expect(html).toContain('v1.2.0');
  });

  it('does NOT embed relay hex pubkey in the footer', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    expect(html).not.toContain('46f3c7bb33cc3019049b76dc89dbb96e34c247bdda68b6ad8632682793ff8a1a');
  });

  it('embeds upstream relays in the footer', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    expect(html).toContain('wss://relay.damus.io');
    expect(html).toContain('wss://nos.lol');
  });

  it('renders leaderboard user cards with avatars, scores, and njump URLs using npubs', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    // User names
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).toContain('Carol');
    expect(html).toContain('Dave');
    // Scores and units
    expect(html).toContain('50 <span class="user-unit">posts</span>');
    expect(html).toContain('20 <span class="user-unit">shares</span>');
    expect(html).toContain('800 <span class="user-unit">followers</span>');
    // njump profile links with npub
    expect(html).toContain(`href="https://njump.me/${encodeURIComponent(encodeNpub('a'.repeat(64)))}"`);
    expect(html).toContain(`href="https://njump.me/${encodeURIComponent(encodeNpub('d'.repeat(64)))}"`);
    // npub formatted subtitles
    expect(html).toContain(shortenNpub('a'.repeat(64)));
    expect(html).toContain(shortenNpub('d'.repeat(64)));
    // Avatar image and fallback
    expect(html).toContain('src="https://example.com/alice.png"');
    expect(html).toContain('user-avatar-fallback');
  });

  it('renders Hot 5 trending account with njump link, avatar, and sparkline canvas', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    expect(html).toContain('id="spark-canvas-0"');
    expect(html).toContain('id="data-spark-0"');
    expect(html).toContain(`href="https://njump.me/${encodeURIComponent(encodeNpub('f'.repeat(64)))}"`);
    expect(html).toContain(shortenNpub('f'.repeat(64)));
    expect(html).toContain('src="https://example.com/frank.png"');
  });

  it('renders the trend label for a surging account', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    expect(html).toContain('trend-label-surging');
  });

  it('renders a graceful placeholder when hot5 is empty', () => {
    const data: DashboardData = { ...MINIMAL_DATA, hot5: [] };
    const html = renderDashboardHtml(data);
    expect(html).toContain('Not enough data yet');
    // No spark canvas should be rendered
    expect(html).not.toContain('id="spark-canvas-0"');
  });

  it('JSON-encodes data islands (XSS safety)', () => {
    // Inject a hashtag that looks like an HTML injection attempt
    const data: DashboardData = {
      ...MINIMAL_DATA,
      topTags: [{ tag_name: '<script>alert(1)</script>', count: 1 }],
    };
    const html = renderDashboardHtml(data);

    // Raw angle-bracket sequences must NOT appear unescaped in the JSON data islands
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('\\u003cscript\\u003e');
  });

  it('produces valid JSON in every data island', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    const islandRegex =
      /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
    let match: RegExpExecArray | null;
    while ((match = islandRegex.exec(html)) !== null) {
      const jsonContent = match[1] ?? '';
      expect(() => JSON.parse(jsonContent)).not.toThrow();
    }
  });

  it('contains proper HTML lang and charset meta', () => {
    const html = renderDashboardHtml(MINIMAL_DATA);
    expect(html).toContain('lang="en"');
    expect(html).toContain('charset="UTF-8"');
  });
});

// ---------------------------------------------------------------------------
// renderPlaceholderHtml
// ---------------------------------------------------------------------------

describe('renderPlaceholderHtml', () => {
  it('is a non-empty HTML string starting with <!DOCTYPE html>', () => {
    const html = renderPlaceholderHtml();
    expect(typeof html).toBe('string');
    expect(html.trimStart().startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('contains auto-refresh meta tag (60s)', () => {
    const html = renderPlaceholderHtml();
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain('content="60"');
  });

  it('contains a user-facing message', () => {
    const html = renderPlaceholderHtml();
    expect(html).toContain('Dashboard is being generated');
  });

  it('does NOT contain any chart canvas elements', () => {
    const html = renderPlaceholderHtml();
    expect(html).not.toContain('id="chart-');
  });
});
