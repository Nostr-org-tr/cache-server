/**
 * Dashboard HTML Renderer
 *
 * Renders a complete self-contained static HTML page using Chart.js v4.5.1.
 * All data is embedded as JSON data islands — zero runtime API calls.
 * All DB-sourced string values are JSON-encoded before embedding (XSS-safe).
 */

import type { DashboardData, HourlyBucket } from './types';

// ---------------------------------------------------------------------------
// Chart.js v4.5.1 — jsDelivr UMD build with pinned SRI hash
// ---------------------------------------------------------------------------
// SRI hash computed from: https://www.jsdelivr.com/package/npm/chart.js?path=dist
const CHARTJS_CDN =
  'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js';
const CHARTJS_SRI =
  'sha256-B9lAC9sS7gWHFLhpFLzLTFkBTi4CiSBVVGdK6BGAkc=';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely JSON-encode any value for embedding in an HTML data island.
 * Angle brackets and slashes are escaped so that strings like </script>
 * inside JSON cannot be misinterpreted as HTML closing tags by the parser.
 */
function island(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\//g, '\\u002f');
}

/** Format a Unix epoch (seconds) to a UTC date-time string. */
function fmtDateTime(ts: number): string {
  return new Date(ts * 1000).toUTCString();
}

/** Format a Unix epoch (seconds) to "Mon 14:00" UTC. */
function fmtHourLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = days[d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${day} ${hh}:00`;
}

/** Format a Unix epoch (seconds) to "Mon, Sep 22" UTC. */
function fmtDayLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Truncate a pubkey for display. */
function shortPubkey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`;
}

// ---------------------------------------------------------------------------
// Chart data island builders
// ---------------------------------------------------------------------------

function hourlyTimelineData(buckets: readonly HourlyBucket[]): string {
  const labels = buckets.map((b) => fmtHourLabel(b.hour_bucket));
  const data = buckets.map((b) => b.count);
  return island({ labels, data });
}

function hourOfDayData(rows: readonly { hour_of_day: number; count: number }[]): string {
  // Fill gaps for hours with no events
  const byHour = new Map(rows.map((r) => [r.hour_of_day, r.count]));
  const labels: string[] = [];
  const data: number[] = [];
  for (let h = 0; h < 24; h++) {
    labels.push(`${String(h).padStart(2, '0')}:00`);
    data.push(byHour.get(h) ?? 0);
  }
  return island({ labels, data });
}

function dailyVolumeData(rows: readonly { day_bucket: number; count: number }[]): string {
  const labels = rows.map((r) => fmtDayLabel(r.day_bucket));
  const data = rows.map((r) => r.count);
  return island({ labels, data });
}

function kindDistData(rows: readonly { kind: number; name: string; count: number }[]): string {
  const labels = rows.map((r) => `${r.name} (${r.kind})`);
  const data = rows.map((r) => r.count);
  return island({ labels, data });
}

function ageBucketsData(buckets: {
  lt1h: number;
  h1to6: number;
  h6to24: number;
  d1to3: number;
  d3to7: number;
}): string {
  return island({
    labels: ['< 1 hour', '1–6 hours', '6–24 hours', '1–3 days', '3–7 days'],
    data: [buckets.lt1h, buckets.h1to6, buckets.h6to24, buckets.d1to3, buckets.d3to7],
  });
}

function topTagsData(rows: readonly { tag_name: string; count: number }[]): string {
  const labels = rows.map((r) => `#${r.tag_name}`);
  const data = rows.map((r) => r.count);
  return island({ labels, data });
}

function leaderboardData(rows: readonly { pubkey: string; display_name: string; count: number }[]): string {
  const labels = rows.map((r) => r.display_name);
  const data = rows.map((r) => r.count);
  const pubkeys = rows.map((r) => r.pubkey);
  return island({ labels, data, pubkeys });
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface2: #22263a;
    --border: #2e3250;
    --text: #e2e8f0;
    --muted: #94a3b8;
    --accent: #7c3aed;
    --accent2: #06b6d4;
    --green: #10b981;
    --amber: #f59e0b;
    --red: #ef4444;
    --radius: 12px;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f1f5f9;
      --surface: #ffffff;
      --surface2: #f8fafc;
      --border: #e2e8f0;
      --text: #0f172a;
      --muted: #64748b;
    }
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    line-height: 1.5;
    padding: 1.5rem;
    min-height: 100vh;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 1rem;
    margin-bottom: 2rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 1.5rem; font-weight: 700; }
  header h1 span { color: var(--accent); }
  .refresh-badge {
    font-size: 0.75rem;
    color: var(--muted);
    background: var(--surface2);
    padding: 0.35rem 0.75rem;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  /* Summary cards */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 1rem;
    margin-bottom: 2rem;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .card-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); }
  .card-value { font-size: 1.75rem; font-weight: 700; color: var(--text); line-height: 1; }
  .card-sub { font-size: 0.7rem; color: var(--muted); }
  /* Section headings */
  .section-title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .section-title .pill {
    font-size: 0.65rem;
    background: var(--accent);
    color: #fff;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-weight: 600;
  }
  /* Grid layouts */
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }
  .grid-3 {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }
  @media (max-width: 900px) {
    .grid-2 { grid-template-columns: 1fr; }
    .grid-3 { grid-template-columns: 1fr; }
  }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem;
  }
  .panel-full {
    margin-bottom: 1.5rem;
  }
  .chart-wrap { position: relative; }
  /* Leaderboards */
  .leaderboard-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }
  @media (max-width: 900px) {
    .leaderboard-grid { grid-template-columns: 1fr; }
  }
  /* Hot 5 */
  .hot5-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .trend-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .trend-rank {
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .trend-name { font-size: 0.95rem; font-weight: 600; }
  .trend-pubkey { font-size: 0.65rem; color: var(--muted); font-family: monospace; }
  .trend-stats { display: flex; gap: 1rem; font-size: 0.75rem; color: var(--muted); }
  .trend-stats strong { color: var(--text); }
  .trend-label-surging { color: var(--green); font-weight: 700; }
  .trend-label-rising { color: var(--accent2); font-weight: 600; }
  .trend-label-stable { color: var(--muted); }
  .sparkline-wrap { height: 50px; }
  /* Footer */
  footer {
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1.5rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  footer h4 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.5rem; color: var(--text); }
  footer ul { list-style: none; }
  footer ul li { padding: 0.15rem 0; }
  footer a { color: var(--accent2); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
`.trim();

// ---------------------------------------------------------------------------
// Chart initialisation script
// ---------------------------------------------------------------------------

function chartScript(): string {
  return `
(function() {
  const PALETTE = [
    '#7c3aed','#06b6d4','#10b981','#f59e0b','#ef4444',
    '#8b5cf6','#22d3ee','#34d399','#fbbf24','#f87171',
    '#a78bfa','#67e8f9','#6ee7b7','#fcd34d','#fca5a5',
    '#c4b5fd','#a5f3fc','#bbf7d0','#fde68a','#fecaca',
  ];

  function read(id) {
    var el = document.getElementById('data-' + id);
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch(e) { return null; }
  }

  function baseOpts(extra) {
    return Object.assign({
      responsive: true,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false },
      },
    }, extra || {});
  }

  function initLine(id, fillColor) {
    var d = read(id); if (!d) return;
    var ctx = document.getElementById('chart-' + id); if (!ctx) return;
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: d.labels,
        datasets: [{
          data: d.data,
          borderColor: fillColor || PALETTE[0],
          backgroundColor: (fillColor || PALETTE[0]) + '22',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        }]
      },
      options: baseOpts({ scales: { x: { ticks: { maxTicksLimit: 14 } }, y: { beginAtZero: true } } })
    });
  }

  function initBar(id, horizontal, palette) {
    var d = read(id); if (!d) return;
    var ctx = document.getElementById('chart-' + id); if (!ctx) return;
    var colors = d.labels.map(function(_, i) { return PALETTE[i % PALETTE.length]; });
    var opts = baseOpts(horizontal ? { indexAxis: 'y', scales: { x: { beginAtZero: true } } } : { scales: { y: { beginAtZero: true } } });
    opts.plugins.legend = { display: false };
    new Chart(ctx, {
      type: 'bar',
      data: { labels: d.labels, datasets: [{ data: d.data, backgroundColor: colors }] },
      options: opts
    });
  }

  function initDoughnut(id) {
    var d = read(id); if (!d) return;
    var ctx = document.getElementById('chart-' + id); if (!ctx) return;
    new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: d.labels,
        datasets: [{ data: d.data, backgroundColor: PALETTE.slice(0, d.data.length) }]
      },
      options: Object.assign(baseOpts(), { plugins: { legend: { display: true, position: 'right' } } })
    });
  }

  function initSparkline(id, canvasId) {
    var d = read(id); if (!d) return;
    var ctx = document.getElementById(canvasId); if (!ctx) return;
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: d,
        datasets: [{
          data: d,
          borderColor: '#7c3aed',
          backgroundColor: '#7c3aed22',
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 1.5,
        }]
      },
      options: {
        responsive: true,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
      }
    });
  }

  // Initialise all charts
  initLine('b1');
  initBar('b2', false);
  initBar('b3', false);
  initBar('b4', true);
  initDoughnut('b5');
  initBar('b6', true);
  initBar('c1', true);
  initBar('c2', true);
  initBar('c3', true);
  initBar('c4', true);

  // Hot 5 sparklines
  for (var i = 0; i < 5; i++) {
    initSparkline('spark-' + i, 'spark-canvas-' + i);
  }
})();
  `.trim();
}

// ---------------------------------------------------------------------------
// Hot 5 card HTML
// ---------------------------------------------------------------------------

function renderHot5Cards(hot5: DashboardData['hot5']): string {
  if (hot5.length === 0) {
    return `<p style="color:var(--muted);font-size:0.85rem;">Not enough data yet — check back after more events are cached.</p>`;
  }

  return hot5
    .map((acc, i) => {
      const labelClass = `trend-label-${acc.trend_label}`;
      const labelText =
        acc.trend_label === 'surging' ? '↑↑ Surging' :
        acc.trend_label === 'rising' ? '↑ Rising' : '→ Stable';

      return `
<script type="application/json" id="data-spark-${i}">${island(acc.sparkline)}</script>
<div class="trend-card">
  <div class="trend-rank">#${i + 1} ${labelText.charAt(0) === '↑' ? '' : ''}</div>
  <div class="trend-name">${escHtml(acc.display_name)}</div>
  <div class="trend-pubkey">${escHtml(shortPubkey(acc.pubkey))}</div>
  <div class="trend-stats">
    <span>Posts today: <strong>${acc.posts_24h}</strong></span>
    <span>Mentions: <strong>${acc.mentions_24h}</strong></span>
  </div>
  <div class="trend-stats">
    <span class="${labelClass}">${labelText}</span>
  </div>
  <div class="sparkline-wrap">
    <canvas id="spark-canvas-${i}" height="50"></canvas>
  </div>
</div>`.trim();
    })
    .join('\n');
}

/** Escape HTML special characters to prevent XSS in text nodes. */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Number formatter
// ---------------------------------------------------------------------------

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * Renders the complete static dashboard HTML from assembled DashboardData.
 * Returns a UTF-8 HTML string ready to be stored in KV and served as text/html.
 */
export function renderDashboardHtml(data: DashboardData): string {
  const { summary, relay, generatedAt } = data;

  const cacheWindow =
    summary.oldest_event_at && summary.newest_event_at
      ? `${fmtDateTime(summary.oldest_event_at)} → ${fmtDateTime(summary.newest_event_at)}`
      : 'No data';

  const upstreamList = relay.upstream_relays
    .map((r) => `<li>${escHtml(r)}</li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nostr Cache Stats — ${escHtml(relay.name)}</title>
  <meta name="description" content="Live Nostr network statistics from ${escHtml(relay.name)}. Refreshed hourly.">
  <style>${CSS}</style>
</head>
<body>

<header>
  <h1>Nostr <span>Cache</span> Stats</h1>
  <span class="refresh-badge">Generated: ${escHtml(fmtDateTime(generatedAt))} · Refreshes hourly</span>
</header>

<!-- ── Section A: Summary Cards ── -->
<div class="cards">
  <div class="card">
    <span class="card-label">Total Events</span>
    <span class="card-value">${fmtNum(summary.total_events)}</span>
    <span class="card-sub">in cache</span>
  </div>
  <div class="card">
    <span class="card-label">Unique Authors</span>
    <span class="card-value">${fmtNum(summary.total_authors)}</span>
    <span class="card-sub">distinct pubkeys</span>
  </div>
  <div class="card">
    <span class="card-label">Tags Indexed</span>
    <span class="card-value">${fmtNum(summary.total_tags)}</span>
    <span class="card-sub">in event_tags</span>
  </div>
  <div class="card">
    <span class="card-label">Cache Window</span>
    <span class="card-value" style="font-size:0.9rem;line-height:1.3">${escHtml(cacheWindow)}</span>
  </div>
  <div class="card">
    <span class="card-label">Last Refresh</span>
    <span class="card-value" style="font-size:0.85rem;line-height:1.3">${escHtml(fmtDateTime(generatedAt))}</span>
    <span class="card-sub">v${escHtml(relay.version)}</span>
  </div>
</div>

<!-- ── Section B1: Hourly Timeline ── -->
<div class="panel panel-full">
  <div class="section-title">Hourly Activity <span class="pill">Last 7 days</span></div>
  <script type="application/json" id="data-b1">${hourlyTimelineData(data.hourlyTimeline)}</script>
  <div class="chart-wrap"><canvas id="chart-b1" height="80"></canvas></div>
</div>

<!-- ── Section B2 + B3 ── -->
<div class="grid-2">
  <div class="panel">
    <div class="section-title">Most Active UTC Hours</div>
    <script type="application/json" id="data-b2">${hourOfDayData(data.hourOfDay)}</script>
    <div class="chart-wrap"><canvas id="chart-b2" height="160"></canvas></div>
  </div>
  <div class="panel">
    <div class="section-title">Daily Volume <span class="pill">Last 7 days</span></div>
    <script type="application/json" id="data-b3">${dailyVolumeData(data.dailyVolume)}</script>
    <div class="chart-wrap"><canvas id="chart-b3" height="160"></canvas></div>
  </div>
</div>

<!-- ── Section B4 + B5 + B6 ── -->
<div class="grid-3">
  <div class="panel">
    <div class="section-title">Kind Distribution <span class="pill">Top 15</span></div>
    <script type="application/json" id="data-b4">${kindDistData(data.kindDist)}</script>
    <div class="chart-wrap"><canvas id="chart-b4" height="260"></canvas></div>
  </div>
  <div class="panel">
    <div class="section-title">Cache Freshness</div>
    <script type="application/json" id="data-b5">${ageBucketsData(data.ageBuckets)}</script>
    <div class="chart-wrap"><canvas id="chart-b5" height="260"></canvas></div>
  </div>
  <div class="panel">
    <div class="section-title">Top Tags <span class="pill">Top 20</span></div>
    <script type="application/json" id="data-b6">${topTagsData(data.topTags)}</script>
    <div class="chart-wrap"><canvas id="chart-b6" height="260"></canvas></div>
  </div>
</div>

<!-- ── Section C: Leaderboards ── -->
<div class="leaderboard-grid">
  <div class="panel">
    <div class="section-title">Most Active Posters <span class="pill">Today</span></div>
    <script type="application/json" id="data-c1">${leaderboardData(data.topPosters)}</script>
    <div class="chart-wrap"><canvas id="chart-c1" height="220"></canvas></div>
  </div>
  <div class="panel">
    <div class="section-title">Most Active Sharers <span class="pill">Last 7 days</span></div>
    <script type="application/json" id="data-c2">${leaderboardData(data.topSharers)}</script>
    <div class="chart-wrap"><canvas id="chart-c2" height="220"></canvas></div>
  </div>
  <div class="panel">
    <div class="section-title">Most Followed Accounts</div>
    <script type="application/json" id="data-c3">${leaderboardData(data.mostFollowed)}</script>
    <div class="chart-wrap"><canvas id="chart-c3" height="220"></canvas></div>
  </div>
  <div class="panel">
    <div class="section-title">Most Following Accounts</div>
    <script type="application/json" id="data-c4">${leaderboardData(data.mostFollowing)}</script>
    <div class="chart-wrap"><canvas id="chart-c4" height="220"></canvas></div>
  </div>
</div>

<!-- ── Section D: Hot 5 Trending ── -->
<div class="section-title" style="margin-bottom:1rem">🔥 Hot 5 Trending Accounts <span class="pill">Last 24h velocity</span></div>
<div class="hot5-grid">
${renderHot5Cards(data.hot5)}
</div>

<!-- ── Section E: Relay Info Footer ── -->
<footer>
  <div>
    <h4>Relay</h4>
    <div>${escHtml(relay.name)}</div>
    <div>v${escHtml(relay.version)}</div>
    <div style="margin-top:0.5rem;font-size:0.7rem;font-family:monospace;word-break:break-all">${escHtml(relay.pubkey)}</div>
  </div>
  <div>
    <h4>Upstream Relays</h4>
    <ul>${upstreamList}</ul>
  </div>
  <div>
    <h4>GC Schedule</h4>
    <div>${escHtml(relay.gc_schedule)}</div>
    <div style="margin-top:0.5rem">Dashboard: hourly</div>
  </div>
  <div>
    <h4>Contact</h4>
    <div><a href="mailto:${escHtml(relay.contact)}">${escHtml(relay.contact)}</a></div>
    <div style="margin-top:0.5rem"><a href="https://github.com/Nostr-org-tr/cache-server" target="_blank" rel="noopener">View source on GitHub</a></div>
  </div>
</footer>

<!-- Chart.js v4.5.1 -->
<script
  src="${CHARTJS_CDN}"
  integrity="${CHARTJS_SRI}"
  crossorigin="anonymous"></script>

<script>${chartScript()}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 503 Placeholder page (cold start / KV miss)
// ---------------------------------------------------------------------------

export function renderPlaceholderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nostr Cache Stats — Generating…</title>
  <meta http-equiv="refresh" content="60">
  <style>${CSS}
    .placeholder {
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      min-height:60vh;gap:1rem;text-align:center;
    }
    .spinner {
      width:48px;height:48px;border:4px solid var(--border);
      border-top-color:var(--accent);border-radius:50%;
      animation:spin 0.8s linear infinite;
    }
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
<header>
  <h1>Nostr <span>Cache</span> Stats</h1>
</header>
<div class="placeholder">
  <div class="spinner"></div>
  <h2>Dashboard is being generated…</h2>
  <p style="color:var(--muted)">The first hourly report is not ready yet.<br>This page will auto-refresh in 60 seconds.</p>
</div>
</body>
</html>`;
}
