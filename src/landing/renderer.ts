import { LANDING_STYLES } from './generated-styles';
import {
  APP_CONTACT,
  APP_DESCRIPTION,
  APP_HOMEPAGE,
  APP_NAME,
  APP_REPOSITORY,
  APP_VERSION,
} from '../version';

export interface LandingStatsSummary {
  totalEvents?: number | undefined;
  totalAuthors?: number | undefined;
  totalTags?: number | undefined;
  upstreamCount?: number | undefined;
  kvStatus?: 'active' | 'disabled' | 'error' | undefined;
  gcSchedule?: string | undefined;
}

export interface RenderLandingOptions {
  relayName?: string | undefined;
  relayDescription?: string | undefined;
  relayPubkey?: string | undefined;
  relayContact?: string | undefined;
  relayHost?: string | undefined;
  stats?: LandingStatsSummary | undefined;
  supportedNips?: number[] | undefined;
  upstreams?: string[] | undefined;
}

/**
 * Escapes HTML characters to prevent XSS vulnerabilities.
 */
function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format numbers with K / M suffixes.
 */
function fmtNum(n?: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M+`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K+`;
  return n.toLocaleString('en-US');
}

/**
 * Renders the production-grade FlyonUI Light landing page HTML for cache.nostr.org.tr.
 */
export function renderLandingHtml(options?: RenderLandingOptions): string {
  const name = options?.relayName || APP_NAME;
  const relayHost = options?.relayHost || 'cache.nostr.org.tr';
  const description = options?.relayDescription || APP_DESCRIPTION;
  const contact = options?.relayContact || APP_CONTACT;
  const stats = options?.stats;
  const totalEventsFormatted = fmtNum(stats?.totalEvents);
  const totalAuthorsFormatted = fmtNum(stats?.totalAuthors);
  const totalTagsFormatted = fmtNum(stats?.totalTags);
  const upstreamCount = stats?.upstreamCount ?? (options?.upstreams?.length || 4);
  const kvStatus = stats?.kvStatus || 'active';

  return `<!DOCTYPE html>
<html lang="en" data-theme="light" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(name)} — Regional Nostr Edge Cache Relay</title>
  <meta name="description" content="${escHtml(description)}">
  <meta name="keywords" content="nostr, cache, relay, edge cache, cloudflare workers, d1, durable objects, nostr.org.tr, open-source">
  
  <!-- OpenGraph / Social Meta -->
  <meta property="og:title" content="${escHtml(name)} — High-Speed Nostr Edge Cache Relay">
  <meta property="og:description" content="Open-source regional read-only pull-through cache relay built by the nostr.org.tr community on Cloudflare Workers, D1 SQL, and Durable Objects.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escHtml(APP_HOMEPAGE)}">
  <meta name="twitter:card" content="summary_large_image">
  
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⚡</text></svg>">
  <style>
    ${LANDING_STYLES}
    /* Custom utility refinements */
    .code-font { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
  </style>
</head>
<body class="bg-base-100 text-base-content min-h-screen flex flex-col antialiased selection:bg-primary/20 selection:text-primary">

  <!-- ── Top Announcement Banner ── -->
  <aside class="bg-gradient-to-r from-primary/10 via-base-200 to-secondary/10 border-b border-base-300 py-2.5 px-4 text-center text-xs sm:text-sm font-medium">
    <div class="max-w-6xl mx-auto flex flex-wrap items-center justify-center gap-2">
      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/10 text-primary font-semibold text-xs">
        🇹🇷 Community Project
      </span>
      <span>Proudly engineered & maintained by the <a href="https://nostr.org.tr" target="_blank" rel="noopener" class="text-primary font-semibold hover:underline">nostr.org.tr</a> community</span>
      <span class="hidden sm:inline text-base-content/40">•</span>
      <a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-primary hover:underline font-medium">
        Star on GitHub →
      </a>
    </div>
  </aside>

  <!-- ── Navbar ── -->
  <header class="sticky top-0 z-40 bg-base-100/90 backdrop-blur border-b border-base-300">
    <div class="max-w-6xl mx-auto navbar px-4 sm:px-6">
      <div class="navbar-start gap-3">
        <a href="/" class="flex items-center gap-2.5 text-lg sm:text-xl font-bold tracking-tight text-base-content hover:opacity-90 transition">
          <span class="flex items-center justify-center w-8 h-8 rounded-lg bg-primary text-primary-content shadow-sm">⚡</span>
          <span>Nostr Cache</span>
        </a>
        <span class="badge badge-sm badge-soft badge-primary hidden md:inline-flex">v${escHtml(APP_VERSION)}</span>
      </div>

      <div class="navbar-center hidden lg:flex">
        <ul class="menu menu-horizontal gap-1 font-medium text-sm">
          <li><a href="#why-cache" class="hover:text-primary">Why Cache?</a></li>
          <li><a href="#developer-guide" class="hover:text-primary">Developer Guide</a></li>
          <li><a href="#architecture" class="hover:text-primary">Architecture</a></li>
          <li><a href="#nips" class="hover:text-primary">Supported NIPs</a></li>
          <li><a href="/dashboard" class="hover:text-primary font-semibold text-primary">Live Dashboard</a></li>
        </ul>
      </div>

      <div class="navbar-end gap-2">
        <a href="/stats" class="btn btn-sm btn-ghost gap-1.5 text-xs sm:text-sm" title="View Raw JSON Stats">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 shrink-0 text-base-content/70" style="display:inline-block;vertical-align:middle;">
            <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <span class="hidden sm:inline">Stats JSON</span>
        </a>
        <a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="btn btn-sm btn-neutral gap-1.5 text-xs sm:text-sm shadow-sm">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 fill-current" viewBox="0 0 24 24">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
          </svg>
          <span>GitHub</span>
        </a>
      </div>
    </div>
  </header>

  <!-- ── Hero Section ── -->
  <section class="relative overflow-hidden bg-gradient-to-b from-base-200/50 via-base-100 to-base-100 py-16 sm:py-24 border-b border-base-300">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 text-center">
      
      <!-- Community & Purpose Badges -->
      <div class="inline-flex flex-wrap items-center justify-center gap-2 mb-6">
        <span class="badge badge-lg badge-primary badge-soft font-semibold gap-1.5">
          <span class="w-2 h-2 rounded-full bg-primary animate-pulse"></span>
          Regional Edge Cache Relay
        </span>
        <span class="badge badge-lg badge-neutral badge-soft font-medium">
          Read-Only • Pull-Through
        </span>
        <span class="badge badge-lg badge-secondary badge-soft font-medium">
          Cloudflare Workers + D1
        </span>
      </div>

      <!-- Main Headline -->
      <h1 class="text-4xl sm:text-6xl font-extrabold tracking-tight text-base-content leading-tight mb-6">
        The Blazing-Fast Nostr Edge Cache <br class="hidden sm:inline">
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-primary to-secondary">
          For Developers & Builders
        </span>
      </h1>

      <!-- Subtitle -->
      <p class="text-lg sm:text-xl text-base-content/75 max-w-3xl mx-auto mb-10 leading-relaxed">
        Accelerate profile metadata (<code class="text-xs px-1.5 py-0.5 rounded bg-base-200 text-primary font-bold">kind 0</code>), contact lists (<code class="text-xs px-1.5 py-0.5 rounded bg-base-200 text-primary font-bold">kind 3</code>), and feed queries with sub-millisecond regional edge execution. Built for Nostr apps, bots, and indexers without hammering upstream relays.
      </p>

      <!-- Relay Connection Box with 1-Click Copy -->
      <div class="max-w-2xl mx-auto bg-base-100 border border-base-300 rounded-2xl shadow-lg p-5 sm:p-6 mb-8 text-left">
        <div class="flex items-center justify-between gap-2 mb-3">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-success"></span>
            <span class="text-xs font-bold uppercase tracking-wider text-base-content/70">Relay WebSocket Endpoint</span>
          </div>
          <span class="badge badge-xs badge-outline badge-success text-[10px] font-semibold uppercase">Live & Ready</span>
        </div>

        <!-- Default Endpoint -->
        <div class="flex items-center justify-between gap-2 bg-base-200/80 rounded-xl p-3 border border-base-300/80 mb-3">
          <code class="code-font text-xs sm:text-sm font-semibold text-primary select-all break-all" id="endpoint-default">wss://${escHtml(relayHost)}</code>
          <button class="btn btn-sm btn-primary shrink-0 gap-1 copy-btn" data-target="endpoint-default">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <span class="copy-text">Copy</span>
          </button>
        </div>

        <!-- Custom Upstreams Endpoint (?relays=) -->
        <div class="border-t border-base-200 pt-3">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-xs font-semibold text-base-content/80 flex items-center gap-1">
              <span>✨ Custom Upstreams Querystring</span>
              <span class="badge badge-xs badge-primary font-normal">Dynamic</span>
            </span>
            <span class="text-[11px] text-base-content/50">Specify upstreams per connection</span>
          </div>
          <div class="flex items-center justify-between gap-2 bg-base-200/50 rounded-xl p-2.5 border border-base-300/50">
            <code class="code-font text-[11px] sm:text-xs text-base-content/80 select-all break-all" id="endpoint-relays">wss://${escHtml(relayHost)}?relays=wss://relay.damus.io,wss://nos.lol</code>
            <button class="btn btn-xs btn-outline btn-neutral shrink-0 gap-1 copy-btn" data-target="endpoint-relays">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span class="copy-text">Copy</span>
            </button>
          </div>
        </div>
      </div>

      <!-- CTAs -->
      <div class="flex flex-wrap items-center justify-center gap-4">
        <a href="/dashboard" class="btn btn-primary btn-md shadow-md gap-2 font-semibold">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
          <span>Explore Live Dashboard</span>
        </a>
        <a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="btn btn-outline btn-md gap-2 font-semibold">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 fill-current" viewBox="0 0 24 24">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
          </svg>
          <span>View Source on GitHub</span>
        </a>
        <a href="#developer-guide" class="btn btn-ghost btn-md gap-1.5 font-medium">
          <span>Quickstart Guide ↓</span>
        </a>
      </div>

    </div>
  </section>

  <!-- ── Live Edge Telemetry (FlyonUI Stats Grid) ── -->
  <section class="py-12 bg-base-100 border-b border-base-300">
    <div class="max-w-6xl mx-auto px-4 sm:px-6">
      
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
        <div>
          <div class="text-xs font-bold uppercase tracking-wider text-primary mb-1">Live Edge Telemetry</div>
          <h2 class="text-2xl sm:text-3xl font-bold tracking-tight">Real-time Caching Performance</h2>
        </div>
        <div class="flex items-center gap-3 text-xs text-base-content/70">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-success/10 text-success font-medium">
            <span class="w-1.5 h-1.5 rounded-full bg-success"></span> KV Cache ${escHtml(kvStatus.toUpperCase())}
          </span>
          <a href="/dashboard" class="text-primary font-semibold hover:underline flex items-center gap-1">
            Open Full Analytics →
          </a>
        </div>
      </div>

      <!-- Stats Cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        
        <div class="bg-base-200/60 border border-base-300 rounded-xl p-5 hover:border-primary/40 transition">
          <div class="text-xs font-medium text-base-content/60 uppercase tracking-wider mb-1">Cached Events</div>
          <div class="text-2xl sm:text-3xl font-extrabold text-base-content">${escHtml(totalEventsFormatted)}</div>
          <div class="text-[11px] text-base-content/60 mt-1 flex items-center gap-1">
            <span>Indexed in Cloudflare D1</span>
          </div>
        </div>

        <div class="bg-base-200/60 border border-base-300 rounded-xl p-5 hover:border-primary/40 transition">
          <div class="text-xs font-medium text-base-content/60 uppercase tracking-wider mb-1">Unique Authors</div>
          <div class="text-2xl sm:text-3xl font-extrabold text-base-content">${escHtml(totalAuthorsFormatted)}</div>
          <div class="text-[11px] text-base-content/60 mt-1 flex items-center gap-1">
            <span>Distinct pubkeys cached</span>
          </div>
        </div>

        <div class="bg-base-200/60 border border-base-300 rounded-xl p-5 hover:border-primary/40 transition">
          <div class="text-xs font-medium text-base-content/60 uppercase tracking-wider mb-1">Indexed Tags</div>
          <div class="text-2xl sm:text-3xl font-extrabold text-base-content">${escHtml(totalTagsFormatted)}</div>
          <div class="text-[11px] text-base-content/60 mt-1 flex items-center gap-1">
            <span>Fast multi-tag query joins</span>
          </div>
        </div>

        <div class="bg-base-200/60 border border-base-300 rounded-xl p-5 hover:border-primary/40 transition">
          <div class="text-xs font-medium text-base-content/60 uppercase tracking-wider mb-1">Upstream Pool</div>
          <div class="text-2xl sm:text-3xl font-extrabold text-primary">${upstreamCount} Relays</div>
          <div class="text-[11px] text-base-content/60 mt-1 flex items-center gap-1">
            <span>Multiplexed on miss</span>
          </div>
        </div>

      </div>

    </div>
  </section>

  <!-- ── Why Developers Need a Regional Cache Relay ── -->
  <section id="why-cache" class="py-16 sm:py-20 bg-base-200/40 border-b border-base-300">
    <div class="max-w-6xl mx-auto px-4 sm:px-6">
      
      <div class="text-center max-w-3xl mx-auto mb-16">
        <span class="badge badge-primary badge-soft font-semibold mb-3">Architected for Builders</span>
        <h2 class="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">Why Build with a Read-Only Edge Cache?</h2>
        <p class="text-base sm:text-lg text-base-content/75 leading-relaxed">
          Standard Nostr clients expect full write relays. However, modern Nostr applications, bots, feeds, and web frontends require lightning-fast, high-throughput read capabilities.
        </p>
      </div>

      <div class="grid md:grid-cols-3 gap-6">
        
        <div class="card bg-base-100 border border-base-300 shadow-sm p-6 rounded-2xl">
          <div class="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold text-xl mb-4">
            ⚡
          </div>
          <h3 class="text-lg font-bold mb-2">Sub-Millisecond Edge Responses</h3>
          <p class="text-sm text-base-content/70 leading-relaxed">
            Eliminate multi-second relay roundtrips. Hot user profiles (<code class="text-xs bg-base-200 text-primary px-1 rounded">kind 0</code>) and contact lists (<code class="text-xs bg-base-200 text-primary px-1 rounded">kind 3</code>) are served from Workers KV and D1 edge replicas in under 5ms.
          </p>
        </div>

        <div class="card bg-base-100 border border-base-300 shadow-sm p-6 rounded-2xl">
          <div class="w-12 h-12 rounded-xl bg-secondary/10 text-secondary flex items-center justify-center font-bold text-xl mb-4">
            🔀
          </div>
          <h3 class="text-lg font-bold mb-2">Multiplexed Pull-Through</h3>
          <p class="text-sm text-base-content/70 leading-relaxed">
            When your query misses local cache, the relay queries configured upstream relays in parallel, streams matching events back to your client instantly, and persists them for subsequent reads.
          </p>
        </div>

        <div class="card bg-base-100 border border-base-300 shadow-sm p-6 rounded-2xl">
          <div class="w-12 h-12 rounded-xl bg-success/10 text-success flex items-center justify-center font-bold text-xl mb-4">
            🎯
          </div>
          <h3 class="text-lg font-bold mb-2">Dynamic Upstreams (<code class="text-xs">?relays=</code>)</h3>
          <p class="text-sm text-base-content/70 leading-relaxed">
            Direct the edge cache to pull from specific community or niche relays on a per-connection basis simply by passing <code class="text-xs bg-base-200 text-success px-1 rounded">?relays=wss://...</code> in your WebSocket URL.
          </p>
        </div>

      </div>

    </div>
  </section>

  <!-- ── Developer Integration Guide (Code Snippets & nak) ── -->
  <section id="developer-guide" class="py-16 sm:py-20 bg-base-100 border-b border-base-300">
    <div class="max-w-6xl mx-auto px-4 sm:px-6">
      
      <div class="max-w-3xl mb-12">
        <span class="badge badge-primary badge-soft font-semibold mb-3">Integration Quickstart</span>
        <h2 class="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">Integrate in Seconds</h2>
        <p class="text-base sm:text-lg text-base-content/75">
          Configure <code class="text-sm font-bold text-primary">wss://${escHtml(relayHost)}</code> as a read-only relay target in your SDK query pool or CLI toolchain.
        </p>
      </div>

      <!-- Code Snippet Tabs (High Contrast Dark Theme) -->
      <div class="bg-[#0e131f] border border-slate-700/80 rounded-2xl overflow-hidden shadow-xl text-slate-100">
        
        <!-- Tab Headers -->
        <div class="flex items-center gap-1.5 bg-[#090d16] p-2.5 border-b border-slate-800 overflow-x-auto text-xs font-semibold">
          <button class="px-4 py-2 rounded-xl bg-slate-800 text-amber-300 font-bold border border-slate-700 shadow-sm snippet-tab" data-tab="nak">nak CLI</button>
          <button class="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 snippet-tab" data-tab="ts">TypeScript / nostr-tools</button>
          <button class="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 snippet-tab" data-tab="ndk">NDK</button>
          <button class="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 snippet-tab" data-tab="rust">Rust (rust-nostr)</button>
          <button class="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 snippet-tab" data-tab="haskell">Haskell (nostr.hs)</button>
        </div>

        <!-- Tab 1: nak CLI -->
        <div class="p-5 sm:p-6 tab-content" id="tab-nak">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-medium text-slate-400">Query events via official nak tool:</span>
            <button class="btn btn-xs btn-outline border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white copy-btn" data-target="code-nak">
              <span class="copy-text">Copy</span>
            </button>
          </div>
          <pre class="code-font bg-[#06090e] border border-slate-800/90 p-4 rounded-xl text-xs sm:text-sm text-slate-100 overflow-x-auto leading-relaxed" id="code-nak"><code><span class="text-slate-500"># 1. Fetch user metadata profile (kind 0) from regional edge</span>
nak req -k 0 -a &lt;pubkey&gt; <span class="text-emerald-400">wss://${escHtml(relayHost)}</span>

<span class="text-slate-500"># 2. Fetch latest 20 text notes (kind 1)</span>
nak req -k 1 -l 20 <span class="text-emerald-400">wss://${escHtml(relayHost)}</span>

<span class="text-slate-500"># 3. Query with custom upstream relays on-the-fly via ?relays=</span>
nak req -k 1 -l 10 <span class="text-emerald-400">"wss://${escHtml(relayHost)}?relays=wss://relay.damus.io,wss://nos.lol"</span></code></pre>
        </div>

        <!-- Tab 2: TypeScript / nostr-tools -->
        <div class="p-5 sm:p-6 tab-content hidden" id="tab-ts">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-medium text-slate-400">Use with nostr-tools SimplePool:</span>
            <button class="btn btn-xs btn-outline border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white copy-btn" data-target="code-ts">
              <span class="copy-text">Copy</span>
            </button>
          </div>
          <pre class="code-font bg-[#06090e] border border-slate-800/90 p-4 rounded-xl text-xs sm:text-sm text-slate-100 overflow-x-auto leading-relaxed" id="code-ts"><code><span class="text-purple-400">import</span> { SimplePool } <span class="text-purple-400">from</span> <span class="text-emerald-300">'nostr-tools'</span>;

<span class="text-purple-400">const</span> pool = <span class="text-purple-400">new</span> <span class="text-yellow-300">SimplePool</span>();
<span class="text-purple-400">const</span> CACHE_RELAY = <span class="text-emerald-300">'wss://${escHtml(relayHost)}'</span>;

<span class="text-slate-500">// High-speed profile resolution from regional edge cache</span>
<span class="text-purple-400">export async function</span> <span class="text-blue-400">getProfile</span>(pubkey: <span class="text-cyan-300">string</span>) {
  <span class="text-purple-400">return await</span> pool.<span class="text-blue-400">get</span>([CACHE_RELAY], {
    kinds: [0],
    authors: [pubkey],
  });
}</code></pre>
        </div>

        <!-- Tab 3: NDK -->
        <div class="p-5 sm:p-6 tab-content hidden" id="tab-ndk">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-medium text-slate-400">Configure NDK explicit read relay:</span>
            <button class="btn btn-xs btn-outline border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white copy-btn" data-target="code-ndk">
              <span class="copy-text">Copy</span>
            </button>
          </div>
          <pre class="code-font bg-[#06090e] border border-slate-800/90 p-4 rounded-xl text-xs sm:text-sm text-slate-100 overflow-x-auto leading-relaxed" id="code-ndk"><code><span class="text-purple-400">import</span> NDK <span class="text-purple-400">from</span> <span class="text-emerald-300">'@nostr-dev-kit/ndk'</span>;

<span class="text-purple-400">const</span> ndk = <span class="text-purple-400">new</span> <span class="text-yellow-300">NDK</span>({
  explicitRelayUrls: [
    <span class="text-emerald-300">'wss://${escHtml(relayHost)}'</span> <span class="text-slate-500">// Read-only edge cache target</span>
  ]
});

<span class="text-purple-400">await</span> ndk.<span class="text-blue-400">connect</span>();
<span class="text-purple-400">const</span> user = ndk.<span class="text-blue-400">getUser</span>({ pubkey: <span class="text-emerald-300">'&lt;hex-pubkey&gt;'</span> });
<span class="text-purple-400">await</span> user.<span class="text-blue-400">fetchProfile</span>();</code></pre>
        </div>

        <!-- Tab 4: Rust -->
        <div class="p-5 sm:p-6 tab-content hidden" id="tab-rust">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-medium text-slate-400">rust-nostr client integration:</span>
            <button class="btn btn-xs btn-outline border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white copy-btn" data-target="code-rust">
              <span class="copy-text">Copy</span>
            </button>
          </div>
          <pre class="code-font bg-[#06090e] border border-slate-800/90 p-4 rounded-xl text-xs sm:text-sm text-slate-100 overflow-x-auto leading-relaxed" id="code-rust"><code><span class="text-purple-400">use</span> nostr_sdk::prelude::*;

<span class="text-yellow-300">#[tokio::main]</span>
<span class="text-purple-400">async fn</span> <span class="text-blue-400">main</span>() -&gt; Result&lt;()&gt; {
    <span class="text-purple-400">let</span> client = Client::<span class="text-blue-400">default</span>();
    
    <span class="text-slate-500">// Add cache relay for high-speed read queries</span>
    client.<span class="text-blue-400">add_relay</span>(<span class="text-emerald-300">"wss://${escHtml(relayHost)}"</span>).<span class="text-purple-400">await</span>?;
    client.<span class="text-blue-400">connect</span>().<span class="text-purple-400">await</span>;

    <span class="text-purple-400">let</span> filter = Filter::<span class="text-blue-400">new</span>().<span class="text-blue-400">kind</span>(Kind::Metadata).<span class="text-blue-400">author</span>(public_key);
    <span class="text-purple-400">let</span> events = client.<span class="text-blue-400">fetch_events</span>(vec![filter], Some(Duration::<span class="text-blue-400">from_secs</span>(3))).<span class="text-purple-400">await</span>?;
    <span class="text-blue-400">Ok</span>(())
}</code></pre>
        </div>

        <!-- Tab 5: Haskell (nostr.hs) -->
        <div class="p-5 sm:p-6 tab-content hidden" id="tab-haskell">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-medium text-slate-400"><a href="https://hackage.haskell.org/package/nostr" target="_blank" rel="noopener" class="text-emerald-400 font-semibold hover:underline">nostr.hs</a> Haskell library integration:</span>
            <button class="btn btn-xs btn-outline border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white copy-btn" data-target="code-haskell">
              <span class="copy-text">Copy</span>
            </button>
          </div>
          <pre class="code-font bg-[#06090e] border border-slate-800/90 p-4 rounded-xl text-xs sm:text-sm text-slate-100 overflow-x-auto leading-relaxed" id="code-haskell"><code><span class="text-purple-400">{-# LANGUAGE</span> <span class="text-yellow-300">OverloadedStrings</span> <span class="text-purple-400">#-}</span>

<span class="text-purple-400">import</span> Nostr.Client
<span class="text-purple-400">import</span> Nostr.Event
<span class="text-purple-400">import</span> Control.Monad.IO.Class (<span class="text-blue-400">liftIO</span>)

<span class="text-blue-400">main</span> :: <span class="text-yellow-300">IO</span> ()
<span class="text-blue-400">main</span> = <span class="text-purple-400">do</span>
  <span class="text-slate-500">-- Connect to regional edge cache relay</span>
  env &lt;- <span class="text-blue-400">connectRelays</span> [<span class="text-emerald-300">"wss://${escHtml(relayHost)}"</span>]

  <span class="text-blue-400">runNostrApp</span> env $ <span class="text-purple-400">do</span>
    <span class="text-purple-400">let</span> filter = <span class="text-blue-400">defaultFilter</span>
          { <span class="text-cyan-300">filterKinds</span> = <span class="text-yellow-300">Just</span> [<span class="text-yellow-300">0</span>]
          , <span class="text-cyan-300">filterAuthors</span> = <span class="text-yellow-300">Just</span> [<span class="text-emerald-300">"&lt;hex-pubkey&gt;"</span>]
          , <span class="text-cyan-300">filterLimit</span> = <span class="text-yellow-300">Just</span> <span class="text-yellow-300">1</span>
          }

    events &lt;- <span class="text-blue-400">queryEvents</span> filter
    <span class="text-blue-400">liftIO</span> $ <span class="text-blue-400">print</span> events

  <span class="text-blue-400">disconnect</span> env</code></pre>
        </div>

      </div>

    </div>
  </section>

  <!-- ── Architecture & Codebase Pride Grid ── -->
  <section id="architecture" class="py-16 sm:py-20 bg-base-200/40 border-b border-base-300">
    <div class="max-w-6xl mx-auto px-4 sm:px-6">
      
      <div class="text-center max-w-3xl mx-auto mb-16">
        <span class="badge badge-secondary badge-soft font-semibold mb-3">Production Architecture</span>
        <h2 class="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">Engineered for Extreme Efficiency</h2>
        <p class="text-base sm:text-lg text-base-content/75 leading-relaxed">
          Zero legacy servers. Zero heavyweight JVM or Python daemons. Built purely on modern serverless edge primitives with strict cryptographic validation.
        </p>
      </div>

      <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        
        <div class="p-6 bg-base-100 border border-base-300 rounded-2xl shadow-sm flex flex-col justify-between">
          <div>
            <div class="text-2xl mb-3">⚡</div>
            <h3 class="text-base font-bold mb-1.5">Cloudflare Edge Execution</h3>
            <p class="text-xs text-base-content/70 leading-relaxed">
              Global distribution across 330+ edge datacenters. Every request terminates at the nearest edge pop for minimum latency.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-base-200 flex items-center justify-between text-[11px] text-base-content/60">
            <span>Global Edge</span>
            <span class="badge badge-xs badge-soft badge-primary font-semibold">V8 Isolates</span>
          </div>
        </div>

        <div class="p-6 bg-base-100 border border-base-300 rounded-2xl shadow-sm flex flex-col justify-between">
          <div>
            <div class="text-2xl mb-3">🗄️</div>
            <h3 class="text-base font-bold mb-1.5">Cloudflare D1 SQL Relational Engine</h3>
            <p class="text-xs text-base-content/70 leading-relaxed">
              Index-optimized relational storage enforcing NIP-01, NIP-16, and NIP-33 replacement semantics with parameterized prepared statements.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-base-200 flex items-center justify-between text-[11px] text-base-content/60">
            <span>Relational Caching</span>
            <span class="badge badge-xs badge-soft badge-secondary font-semibold">Indexed D1</span>
          </div>
        </div>

        <div class="p-6 bg-base-100 border border-base-300 rounded-2xl shadow-sm flex flex-col justify-between">
          <div>
            <div class="text-2xl mb-3">🚀</div>
            <h3 class="text-base font-bold mb-1.5">Workers KV Micro-Cache</h3>
            <p class="text-xs text-base-content/70 leading-relaxed">
              Sub-millisecond key-value caching layer for hot profiles, contact lists, and hourly analytics dashboard HTML.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-base-200 flex items-center justify-between text-[11px] text-base-content/60">
            <span>Ultra-low Latency</span>
            <span class="badge badge-xs badge-soft badge-success font-semibold">&lt; 5ms Reads</span>
          </div>
        </div>

        <div class="p-6 bg-base-100 border border-base-300 rounded-2xl shadow-sm flex flex-col justify-between">
          <div>
            <div class="text-2xl mb-3">💤</div>
            <h3 class="text-base font-bold mb-1.5">Durable Objects Hibernation</h3>
            <p class="text-xs text-base-content/70 leading-relaxed">
              ClientSession Durable Objects utilize WebSocket Hibernation API. Idle connections consume zero memory while maintaining instant wake-up.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-base-200 flex items-center justify-between text-[11px] text-base-content/60">
            <span>State Coordination</span>
            <span class="badge badge-xs badge-soft badge-primary font-semibold">Zero Idle Cost</span>
          </div>
        </div>

        <div class="p-6 bg-base-100 border border-base-300 rounded-2xl shadow-sm flex flex-col justify-between">
          <div>
            <div class="text-2xl mb-3">🔐</div>
            <h3 class="text-base font-bold mb-1.5">BIP-340 Schnorr Cryptography</h3>
            <p class="text-xs text-base-content/70 leading-relaxed">
              Zero-dependency, auditable cryptographic verification using @noble/curves. Validates every inbound event signature before caching.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-base-200 flex items-center justify-between text-[11px] text-base-content/60">
            <span>BIP-340 Verification</span>
            <span class="badge badge-xs badge-soft badge-success font-semibold">Audited Pure TS</span>
          </div>
        </div>

        <div class="p-6 bg-base-100 border border-base-300 rounded-2xl shadow-sm flex flex-col justify-between">
          <div>
            <div class="text-2xl mb-3">🧹</div>
            <h3 class="text-base font-bold mb-1.5">Tiered Rolling Garbage Collection</h3>
            <p class="text-xs text-base-content/70 leading-relaxed">
              Automated daily scheduled cron jobs prune expired ephemeral, text, and metadata events according to tiered retention policies.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-base-200 flex items-center justify-between text-[11px] text-base-content/60">
            <span>Retention Engine</span>
            <span class="badge badge-xs badge-soft badge-neutral font-semibold">Daily Cron</span>
          </div>
        </div>

      </div>

    </div>
  </section>

  <!-- ── Supported NIPs Grid ── -->
  <section id="nips" class="py-16 sm:py-20 bg-base-100 border-b border-base-300">
    <div class="max-w-6xl mx-auto px-4 sm:px-6">
      
      <div class="text-center max-w-3xl mx-auto mb-16">
        <span class="badge badge-primary badge-soft font-semibold mb-3">Protocol Standards</span>
        <h2 class="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">Supported Nostr Protocol Specifications</h2>
        <p class="text-base sm:text-lg text-base-content/75">
          Strict conformance with official Nostr Implementation Possibilities (NIPs).
        </p>
      </div>

      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        
        <div class="p-4 bg-base-200/50 border border-base-300 rounded-xl">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold text-primary">NIP-01</span>
            <span class="badge badge-xs badge-success">Core</span>
          </div>
          <div class="text-xs font-semibold mb-1">Base Protocol & Filters</div>
          <p class="text-[11px] text-base-content/70">Canonical serialization, event hashing, signature verification, and multi-tag filtering.</p>
        </div>

        <div class="p-4 bg-base-200/50 border border-base-300 rounded-xl">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold text-primary">NIP-09</span>
            <span class="badge badge-xs badge-neutral">Security</span>
          </div>
          <div class="text-xs font-semibold mb-1">Event Deletions (Kind 5)</div>
          <p class="text-[11px] text-base-content/70">Cryptographic deletion handling ensuring verified author-only cache purging.</p>
        </div>

        <div class="p-4 bg-base-200/50 border border-base-300 rounded-xl">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold text-primary">NIP-11</span>
            <span class="badge badge-xs badge-primary">Discovery</span>
          </div>
          <div class="text-xs font-semibold mb-1">Relay Information Document</div>
          <p class="text-[11px] text-base-content/70">Automated JSON document served via content negotiation on HTTP GET.</p>
        </div>

        <div class="p-4 bg-base-200/50 border border-base-300 rounded-xl">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold text-primary">NIP-16</span>
            <span class="badge badge-xs badge-secondary">State</span>
          </div>
          <div class="text-xs font-semibold mb-1">Replaceable Events</div>
          <p class="text-[11px] text-base-content/70">Timestamp and ID tie-breaking replacement rules for Kinds 0, 3, and 10000-19999.</p>
        </div>

        <div class="p-4 bg-base-200/50 border border-base-300 rounded-xl">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold text-primary">NIP-20</span>
            <span class="badge badge-xs badge-success">Standards</span>
          </div>
          <div class="text-xs font-semibold mb-1">Command Results (OK / NOTICE)</div>
          <p class="text-[11px] text-base-content/70">Explicit structured feedback for client actions and read-only policy notifications.</p>
        </div>

        <div class="p-4 bg-base-200/50 border border-base-300 rounded-xl">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold text-primary">NIP-33</span>
            <span class="badge badge-xs badge-secondary">State</span>
          </div>
          <div class="text-xs font-semibold mb-1">Parameterized Replaceable</div>
          <p class="text-[11px] text-base-content/70">Keyed replacement on (pubkey, kind, d_tag) for Kinds 30000-39999.</p>
        </div>

        <div class="p-4 bg-base-200/50 border border-base-300 rounded-xl">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold text-primary">NIP-65</span>
            <span class="badge badge-xs badge-primary">Discovery</span>
          </div>
          <div class="text-xs font-semibold mb-1">Relay List Metadata</div>
          <p class="text-[11px] text-base-content/70">Author relay hints used for dynamic read-through upstream routing.</p>
        </div>

        <div class="p-4 bg-base-200/50 border border-base-300 rounded-xl flex flex-col justify-center text-center">
          <a href="/dashboard" class="text-xs font-bold text-primary hover:underline">
            View Protocol Analytics →
          </a>
        </div>

      </div>

    </div>
  </section>

  <!-- ── nostr.org.tr Community & Open Source Showcase ── -->
  <section class="py-16 sm:py-20 bg-gradient-to-b from-base-200/60 to-base-100 border-b border-base-300">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 text-center">
      
      <div class="w-16 h-16 rounded-2xl bg-primary/10 text-primary flex items-center justify-center text-3xl mx-auto mb-6 shadow-sm">
        🇹🇷
      </div>

      <h2 class="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
        Proudly Built by the <span class="text-primary">nostr.org.tr</span> Community
      </h2>

      <p class="text-base sm:text-lg text-base-content/75 max-w-2xl mx-auto mb-8 leading-relaxed">
        <a href="https://nostr.org.tr" target="_blank" rel="noopener" class="text-primary font-semibold hover:underline">nostr.org.tr</a> is dedicated to expanding open protocols, sovereign communication, and high-performance infrastructure for Nostr users and developers across Turkey and the world.
      </p>

      <div class="flex flex-wrap items-center justify-center gap-4">
        <a href="https://nostr.org.tr" target="_blank" rel="noopener" class="btn btn-primary font-semibold shadow-sm gap-2">
          <span>Visit nostr.org.tr</span>
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
        <a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="btn btn-neutral font-semibold shadow-sm gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 fill-current" viewBox="0 0 24 24">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
          </svg>
          <span>Contribute on GitHub</span>
        </a>
      </div>

    </div>
  </section>

  <!-- ── Footer ── -->
  <footer class="bg-base-100 py-12 border-t border-base-300 text-xs text-base-content/70">
    <div class="max-w-6xl mx-auto px-4 sm:px-6">
      
      <div class="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
        
        <div>
          <div class="flex items-center gap-2 font-bold text-sm text-base-content mb-3">
            <span class="text-primary">⚡</span> Nostr Cache
          </div>
          <p class="text-xs text-base-content/60 leading-relaxed mb-3">
            High-Performance Regional Nostr Edge Cache Relay.
          </p>
          <div class="badge badge-sm badge-soft badge-primary font-semibold">
            MIT Licensed
          </div>
        </div>

        <div>
          <div class="font-bold text-sm text-base-content mb-3 uppercase tracking-wider text-[11px]">Endpoints</div>
          <ul class="space-y-2">
            <li><a href="/" class="hover:text-primary transition">Relay Endpoint (NIP-11)</a></li>
            <li><a href="/dashboard" class="hover:text-primary transition">Live Analytics Dashboard</a></li>
            <li><a href="/stats" class="hover:text-primary transition">JSON Telemetry Stats</a></li>
            <li><a href="/health" class="hover:text-primary transition">Health Check</a></li>
          </ul>
        </div>

        <div>
          <div class="font-bold text-sm text-base-content mb-3 uppercase tracking-wider text-[11px]">Community & Docs</div>
          <ul class="space-y-2">
            <li><a href="https://nostr.org.tr" target="_blank" rel="noopener" class="hover:text-primary transition">nostr.org.tr Portal</a></li>
            <li><a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="hover:text-primary transition">GitHub Repository</a></li>
            <li><a href="${escHtml(APP_REPOSITORY)}/blob/master/CONTRIBUTING.md" target="_blank" rel="noopener" class="hover:text-primary transition">Contributing Guide</a></li>
          </ul>
        </div>

        <div>
          <div class="font-bold text-sm text-base-content mb-3 uppercase tracking-wider text-[11px]">Contact & Support</div>
          <ul class="space-y-2">
            <li><a href="mailto:${escHtml(contact)}" class="hover:text-primary transition">${escHtml(contact)}</a></li>
            <li><a href="${escHtml(APP_REPOSITORY)}/issues" target="_blank" rel="noopener" class="hover:text-primary transition">Report an Issue</a></li>
            <li class="pt-2 text-[11px] text-base-content/50">Version ${escHtml(APP_VERSION)}</li>
          </ul>
        </div>

      </div>

      <div class="border-t border-base-300 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-base-content/50">
        <div>
          © ${new Date().getFullYear()} nostr.org.tr community. Open-source under the MIT License.
        </div>
        <div class="flex items-center gap-4">
          <a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="hover:text-primary">Source Code</a>
          <span>•</span>
          <a href="https://github.com/nostr-protocol/nips" target="_blank" rel="noopener" class="hover:text-primary">Nostr Protocol NIPs</a>
        </div>
      </div>

    </div>
  </footer>

  <!-- ── Interactive Client Script (Copy & Tab switching) ── -->
  <script>
    (function() {
      // 1. Copy to Clipboard handler
      document.querySelectorAll('.copy-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var targetId = btn.getAttribute('data-target');
          var targetEl = document.getElementById(targetId);
          if (!targetEl) return;
          var text = targetEl.textContent || targetEl.innerText || '';
          
          navigator.clipboard.writeText(text.trim()).then(function() {
            var textEl = btn.querySelector('.copy-text');
            var origText = textEl ? textEl.textContent : 'Copy';
            if (textEl) textEl.textContent = 'Copied! ✓';
            btn.classList.add('btn-success');
            setTimeout(function() {
              if (textEl) textEl.textContent = origText;
              btn.classList.remove('btn-success');
            }, 2000);
          });
        });
      });

      // 2. Code Snippets Tab Switcher
      document.querySelectorAll('.snippet-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          var tabId = tab.getAttribute('data-tab');
          
          // Reset all tabs
          document.querySelectorAll('.snippet-tab').forEach(function(t) {
            t.classList.remove('bg-slate-800', 'text-amber-300', 'font-bold', 'border', 'border-slate-700', 'shadow-sm');
            t.classList.add('text-slate-400');
          });
          
          // Activate clicked tab
          tab.classList.remove('text-slate-400');
          tab.classList.add('bg-slate-800', 'text-amber-300', 'font-bold', 'border', 'border-slate-700', 'shadow-sm');

          // Hide all tab contents
          document.querySelectorAll('.tab-content').forEach(function(tc) {
            tc.classList.add('hidden');
          });

          // Show selected tab content
          var activeContent = document.getElementById('tab-' + tabId);
          if (activeContent) {
            activeContent.classList.remove('hidden');
          }
        });
      });
    })();
  </script>

</body>
</html>`;
}
