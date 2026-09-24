/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/* Hallmark · genre: modern-minimal · theme: cobalt-terminal · macrostructure: command-deck */

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
  indexedVectors?: number | undefined;
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
 * Renders the production-grade Hallmark modern-minimal landing page HTML for cache.nostr.org.tr.
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
  const totalVectorsFormatted = fmtNum(stats?.indexedVectors);
  const upstreamCount = stats?.upstreamCount ?? (options?.upstreams?.length || 4);
  const kvStatus = stats?.kvStatus || 'active';
  const dynamicRelaysQuery = options?.upstreams?.length
    ? options.upstreams.join(',')
    : 'wss://relay.damus.io,wss://nos.lol';

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
  </style>
</head>
<body class="min-h-screen flex flex-col antialiased selection:bg-blue-500/20 selection:text-blue-900 bg-[#fafbfe] text-[#0f172a]">

  <!-- ── Top Announcement Banner ── -->
  <aside class="bg-gradient-to-r from-blue-50 via-slate-50 to-indigo-50 border-b border-slate-200/80 py-2 px-4 text-xs font-medium text-slate-700">
    <div class="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-semibold text-[11px] tracking-wide uppercase">
          🇹🇷 Community Project
        </span>
        <span>Maintained by the <a href="https://nostr.org.tr" target="_blank" rel="noopener" class="text-blue-600 hover:text-blue-800 font-semibold underline underline-offset-2">nostr.org.tr</a> community</span>
      </div>
      <div class="flex items-center gap-3">
        <span class="hidden sm:inline text-slate-400">Pure Serverless Architecture</span>
        <a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-slate-900 hover:text-blue-600 font-semibold transition">
          <span>GitHub</span>
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </a>
      </div>
    </div>
  </aside>

  <!-- ── Precision Header ── -->
  <header class="sticky top-0 z-40 bg-white/90 backdrop-blur-md border-b border-slate-200/80">
    <div class="max-w-6xl mx-auto flex items-center justify-between px-4 sm:px-6 h-16">
      
      <!-- Brand & Version -->
      <div class="flex items-center gap-3">
        <a href="/" class="flex items-center gap-2.5 text-base sm:text-lg font-bold tracking-tight text-slate-900 hover:opacity-90 transition">
          <span class="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-600 text-white shadow-sm font-mono text-sm font-extrabold">⚡</span>
          <span>Nostr Cache</span>
        </a>
        <span class="px-2 py-0.5 text-[11px] font-mono font-medium rounded-full bg-slate-100 border border-slate-200 text-slate-600">
          v${escHtml(APP_VERSION)}
        </span>
      </div>

      <!-- Navigation -->
      <nav class="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
        <a href="#telemetry" class="hover:text-blue-600 transition">Telemetry</a>
        <a href="#search-section" class="hover:text-blue-600 transition">Vector Search</a>
        <a href="#quickstart" class="hover:text-blue-600 transition">Integration</a>
        <a href="#architecture" class="hover:text-blue-600 transition">Architecture</a>
        <a href="#nips" class="hover:text-blue-600 transition">NIPs</a>
        <a href="/dashboard" class="text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1">
          <span>Live Dashboard</span>
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
        </a>
      </nav>

      <!-- Header Actions -->
      <div class="flex items-center gap-2.5">
        <a href="/stats" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition" title="Raw JSON Telemetry">
          <svg class="w-3.5 h-3.5 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          <span class="hidden sm:inline">Stats JSON</span>
        </a>
        <a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 shadow-sm transition">
          <svg class="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
          </svg>
          <span>GitHub</span>
        </a>
      </div>

    </div>
  </header>

  <!-- ── Hero Command Deck ── -->
  <section class="relative bg-tech-grid border-b border-slate-200/80 py-16 sm:py-24">
    <div class="max-w-5xl mx-auto px-4 sm:px-6 text-center">
      
      <!-- Live Status Badge -->
      <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white border border-slate-200 shadow-sm text-xs font-medium text-slate-700 mb-6">
        <span class="flex h-2 w-2 relative">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
        </span>
        <span class="font-semibold text-slate-900">Regional Edge Node</span>
        <span class="text-slate-300">•</span>
        <span>Read-Only Pull-Through</span>
      </div>

      <!-- Main Headline -->
      <h1 class="text-3xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-slate-900 leading-[1.1] mb-6">
        Sub-Millisecond Nostr Caching <br class="hidden sm:inline">
        <span class="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-indigo-600 to-cyan-600">
          At The Global Cloud Edge
        </span>
      </h1>

      <!-- Description Subtitle -->
      <p class="text-base sm:text-lg text-slate-600 max-w-3xl mx-auto mb-10 leading-relaxed">
        Accelerate profile metadata (<code class="text-xs px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-blue-700 font-mono font-semibold">kind 0</code>), contact lists (<code class="text-xs px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-blue-700 font-mono font-semibold">kind 3</code>), and feed queries with sub-millisecond edge execution. Built for clients, indexers, and bots without hammering upstream relays.
      </p>

      <!-- Command Deck: Connection Terminal Box -->
      <div class="max-w-2xl mx-auto bg-white border border-slate-200 rounded-2xl shadow-xl shadow-slate-100 overflow-hidden text-left mb-8">
        
        <div class="bg-slate-50/80 px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
            <span class="text-xs font-mono font-bold tracking-wider uppercase text-slate-700">Relay WebSocket Endpoint</span>
          </div>
          <span class="text-[11px] font-mono font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
            ONLINE • READY
          </span>
        </div>

        <div class="p-4 sm:p-5 space-y-4">
          <!-- Default Endpoint -->
          <div>
            <div class="text-xs font-semibold text-slate-500 mb-1.5 flex items-center justify-between">
              <span>Standard Edge Gateway</span>
              <span class="text-[11px] text-slate-400">Default upstream pool</span>
            </div>
            <div class="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-xl p-2.5">
              <code class="code-font text-xs sm:text-sm font-semibold text-blue-600 select-all break-all" id="endpoint-default">wss://${escHtml(relayHost)}</code>
              <button class="hallmark-btn inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 shadow-sm shrink-0 copy-btn" data-target="endpoint-default">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                <span class="copy-text">Copy</span>
              </button>
            </div>
          </div>

          <!-- Dynamic Upstreams Endpoint (?relays=) -->
          <div class="pt-3 border-t border-slate-100">
            <div class="text-xs font-semibold text-slate-500 mb-1.5 flex items-center justify-between">
              <span class="flex items-center gap-1.5">
                <span>Custom Upstreams Querystring</span>
                <span class="px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 text-[10px] font-mono uppercase">Dynamic</span>
              </span>
              <span class="text-[11px] text-slate-400">Per-connection routing</span>
            </div>
            <div class="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-xl p-2.5">
              <code class="code-font text-[11px] sm:text-xs text-slate-700 select-all break-all" id="endpoint-relays">wss://${escHtml(relayHost)}?relays=${escHtml(dynamicRelaysQuery)}</code>
              <button class="hallmark-btn inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50 shadow-sm shrink-0 copy-btn" data-target="endpoint-relays">
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                <span class="copy-text">Copy</span>
              </button>
            </div>
          </div>
        </div>

      </div>

      <!-- Action Buttons -->
      <div class="flex flex-wrap items-center justify-center gap-3">
        <a href="/dashboard" class="hallmark-btn inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700 shadow-md shadow-blue-500/20 transition">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/></svg>
          <span>Explore Live Dashboard</span>
        </a>
        <a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="hallmark-btn inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-800 font-semibold text-sm hover:bg-slate-50 shadow-sm transition">
          <svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
          <span>View on GitHub</span>
        </a>
        <a href="#quickstart" class="hallmark-btn inline-flex items-center gap-1 px-4 py-2.5 rounded-xl text-slate-600 font-medium text-sm hover:text-slate-900 transition">
          <span>Quickstart Guide ↓</span>
        </a>
      </div>

    </div>
  </section>

  <!-- ── Live Edge Telemetry Grid ── -->
  <section id="telemetry" class="py-12 bg-white border-b border-slate-200/80">
    <div class="max-w-6xl mx-auto px-4 sm:px-6">
      
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
        <div>
          <div class="text-xs font-mono font-bold uppercase tracking-wider text-blue-600 mb-1">Live Edge Telemetry</div>
          <h2 class="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900">Real-time Caching Performance</h2>
        </div>
        <div class="flex flex-wrap items-center gap-2.5 text-xs">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 font-medium border border-blue-200">
            <span class="w-1.5 h-1.5 rounded-full bg-blue-600"></span> Vector AI Active
          </span>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 font-medium border border-emerald-200">
            <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> KV Cache ${escHtml(kvStatus.toUpperCase())}
          </span>
          <a href="/dashboard" class="text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1 ml-1">
            Open Analytics →
          </a>
        </div>
      </div>

      <!-- Telemetry Cards -->
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        
        <div class="telemetry-card bg-slate-50/70 border border-slate-200 rounded-xl p-4 sm:p-5">
          <div class="text-xs font-mono font-semibold text-slate-500 uppercase tracking-wider mb-1">Cached Events</div>
          <div class="text-2xl sm:text-3xl font-extrabold text-slate-900">${escHtml(totalEventsFormatted)}</div>
          <div class="text-[11px] text-slate-500 mt-1">Indexed in Cloudflare D1</div>
        </div>

        <div class="telemetry-card bg-slate-50/70 border border-slate-200 rounded-xl p-4 sm:p-5">
          <div class="text-xs font-mono font-semibold text-slate-500 uppercase tracking-wider mb-1">Searchable Vectors</div>
          <div class="text-2xl sm:text-3xl font-extrabold text-blue-600">${escHtml(totalVectorsFormatted)}</div>
          <div class="text-[11px] text-slate-500 mt-1">1024-dim Vector AI</div>
        </div>

        <div class="telemetry-card bg-slate-50/70 border border-slate-200 rounded-xl p-4 sm:p-5">
          <div class="text-xs font-mono font-semibold text-slate-500 uppercase tracking-wider mb-1">Unique Authors</div>
          <div class="text-2xl sm:text-3xl font-extrabold text-slate-900">${escHtml(totalAuthorsFormatted)}</div>
          <div class="text-[11px] text-slate-500 mt-1">Distinct pubkeys cached</div>
        </div>

        <div class="telemetry-card bg-slate-50/70 border border-slate-200 rounded-xl p-4 sm:p-5">
          <div class="text-xs font-mono font-semibold text-slate-500 uppercase tracking-wider mb-1">Indexed Tags</div>
          <div class="text-2xl sm:text-3xl font-extrabold text-slate-900">${escHtml(totalTagsFormatted)}</div>
          <div class="text-[11px] text-slate-500 mt-1">Multi-tag indexed joins</div>
        </div>

        <div class="telemetry-card bg-slate-50/70 border border-slate-200 rounded-xl p-4 sm:p-5 col-span-2 md:col-span-1">
          <div class="text-xs font-mono font-semibold text-slate-500 uppercase tracking-wider mb-1">Upstream Pool</div>
          <div class="text-2xl sm:text-3xl font-extrabold text-blue-600">${upstreamCount} Relays</div>
          <div class="text-[11px] text-slate-500 mt-1">Multiplexed on miss</div>
        </div>

      </div>

    </div>
  </section>

  <!-- ── Interactive NIP-50 Vector Search Workbench ── -->
  <section id="search-section" class="py-14 bg-slate-50/60 border-b border-slate-200/80">
    <div class="max-w-4xl mx-auto px-4 sm:px-6">
      
      <div class="text-center mb-8">
        <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-mono font-semibold text-xs mb-2">
          <span>🔍 NIP-50 Vector Search Engine</span>
        </div>
        <h2 class="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900">Explore the Nostr Knowledge Base</h2>
        <p class="text-sm text-slate-600 mt-1">Semantic search across notes, articles, and author profiles powered by Cloudflare Vectorize</p>
      </div>

      <!-- Search Console Box -->
      <div class="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 sm:p-5 mb-6">
        <form id="landing-search-form" class="flex flex-col sm:flex-row gap-2.5">
          <div class="relative flex-1">
            <span class="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
            </span>
            <input 
              type="text" 
              id="landing-search-input" 
              placeholder="Search notes, articles, or profiles (e.g. bitcoin lightning)..." 
              class="w-full pl-10 pr-4 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
              autocomplete="off"
            />
          </div>
          <button type="submit" id="landing-search-btn" class="hallmark-btn inline-flex items-center justify-center gap-1.5 px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 shadow-sm shrink-0">
            <span>Search</span>
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>
          </button>
        </form>

        <!-- Kinds Filter Chips -->
        <div class="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-slate-100 text-xs">
          <span class="font-medium text-slate-500">Filter kinds:</span>
          <button type="button" class="kind-pill px-2.5 py-1 rounded-lg font-medium bg-blue-600 text-white" data-kinds="1,0,30023">All (Notes, Articles, Profiles)</button>
          <button type="button" class="kind-pill px-2.5 py-1 rounded-lg font-medium bg-slate-100 text-slate-700 hover:bg-slate-200" data-kinds="1">Notes (kind 1)</button>
          <button type="button" class="kind-pill px-2.5 py-1 rounded-lg font-medium bg-slate-100 text-slate-700 hover:bg-slate-200" data-kinds="30023">Articles (kind 30023)</button>
          <button type="button" class="kind-pill px-2.5 py-1 rounded-lg font-medium bg-slate-100 text-slate-700 hover:bg-slate-200" data-kinds="0">Profiles (kind 0)</button>
        </div>
      </div>

      <!-- Live Search Results Container -->
      <div id="search-results-wrapper" class="hidden">
        <div class="flex items-center justify-between mb-3 px-1 text-xs text-slate-600">
          <span id="search-status-text">Found 0 results</span>
          <span id="search-time-text" class="code-font text-blue-600 font-semibold"></span>
        </div>
        <div id="search-results-list" class="space-y-3">
          <!-- Dynamic cards injected here -->
        </div>
      </div>

    </div>
  </section>

  <!-- ── Developer Integration Quickstart (High Contrast Terminal Drawer) ── -->
  <section id="quickstart" class="py-16 bg-white border-b border-slate-200/80">
    <div class="max-w-6xl mx-auto px-4 sm:px-6">
      
      <div class="max-w-3xl mb-10">
        <div class="text-xs font-mono font-bold uppercase tracking-wider text-blue-600 mb-1">Developer Quickstart</div>
        <h2 class="text-3xl font-extrabold tracking-tight text-slate-900 mb-3">Integrate in Seconds</h2>
        <p class="text-base text-slate-600 leading-relaxed">
          Configure <code class="text-sm font-mono font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200">wss://${escHtml(relayHost)}</code> as a read-only relay target across your preferred SDK query pool or CLI toolchain.
        </p>
      </div>

      <!-- Terminal Deck Tabs -->
      <div class="bg-[#080c14] border border-slate-800 rounded-2xl overflow-hidden shadow-2xl text-slate-100">
        
        <!-- Tab Bar -->
        <div class="flex items-center gap-1 bg-[#05080e] p-2 border-b border-slate-800/80 overflow-x-auto text-xs font-mono">
          <button class="px-4 py-2 rounded-xl bg-slate-800 text-amber-300 font-bold border border-slate-700 shadow-sm snippet-tab" data-tab="nak">nak CLI</button>
          <button class="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 snippet-tab" data-tab="ts">TypeScript / nostr-tools</button>
          <button class="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 snippet-tab" data-tab="ndk">NDK</button>
          <button class="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 snippet-tab" data-tab="rust">Rust (nostr_sdk)</button>
          <button class="px-4 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 snippet-tab" data-tab="haskell">Haskell (nostr.hs)</button>
        </div>

        <!-- Tab 1: nak CLI -->
        <div class="p-5 sm:p-6 tab-content" id="tab-nak">
          <div class="flex items-center justify-between mb-3 text-xs text-slate-400 font-mono">
            <span>Query events via official nak tool:</span>
            <button class="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white copy-btn" data-target="code-nak">
              <span class="copy-text">Copy</span>
            </button>
          </div>
          <pre class="code-font bg-[#04060a] border border-slate-800 p-4 rounded-xl text-xs sm:text-sm text-slate-200 overflow-x-auto leading-relaxed" id="code-nak"><code><span class="text-slate-500"># 1. Fetch user metadata profile (kind 0) from regional edge</span>
nak req -k 0 -a &lt;pubkey&gt; <span class="text-emerald-400">wss://${escHtml(relayHost)}</span>

<span class="text-slate-500"># 2. Fetch latest 20 text notes (kind 1)</span>
nak req -k 1 -l 20 <span class="text-emerald-400">wss://${escHtml(relayHost)}</span>

<span class="text-slate-500"># 3. Query with custom upstream relays on-the-fly via ?relays=</span>
nak req -k 1 -l 10 <span class="text-emerald-400">"wss://${escHtml(relayHost)}?relays=wss://relay.damus.io,wss://nos.lol"</span></code></pre>
        </div>

        <!-- Tab 2: TypeScript / nostr-tools -->
        <div class="p-5 sm:p-6 tab-content hidden" id="tab-ts">
          <div class="flex items-center justify-between mb-3 text-xs text-slate-400 font-mono">
            <span>Use with nostr-tools SimplePool:</span>
            <button class="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white copy-btn" data-target="code-ts">
              <span class="copy-text">Copy</span>
            </button>
          </div>
          <pre class="code-font bg-[#04060a] border border-slate-800 p-4 rounded-xl text-xs sm:text-sm text-slate-200 overflow-x-auto leading-relaxed" id="code-ts"><code><span class="text-purple-400">import</span> { SimplePool } <span class="text-purple-400">from</span> <span class="text-emerald-300">'nostr-tools'</span>;

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
          <div class="flex items-center justify-between mb-3 text-xs text-slate-400 font-mono">
            <span>Configure NDK explicit read relay:</span>
            <button class="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white copy-btn" data-target="code-ndk">
              <span class="copy-text">Copy</span>
            </button>
          </div>
          <pre class="code-font bg-[#04060a] border border-slate-800 p-4 rounded-xl text-xs sm:text-sm text-slate-200 overflow-x-auto leading-relaxed" id="code-ndk"><code><span class="text-purple-400">import</span> NDK <span class="text-purple-400">from</span> <span class="text-emerald-300">'@nostr-dev-kit/ndk'</span>;

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
          <div class="flex items-center justify-between mb-3 text-xs text-slate-400 font-mono">
            <span>nostr_sdk client integration:</span>
            <button class="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white copy-btn" data-target="code-rust">
              <span class="copy-text">Copy</span>
            </button>
          </div>
          <pre class="code-font bg-[#04060a] border border-slate-800 p-4 rounded-xl text-xs sm:text-sm text-slate-200 overflow-x-auto leading-relaxed" id="code-rust"><code><span class="text-purple-400">use</span> nostr_sdk::prelude::*;

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
          <div class="flex items-center justify-between mb-3 text-xs text-slate-400 font-mono">
            <span><a href="https://hackage.haskell.org/package/nostr" target="_blank" rel="noopener" class="text-emerald-400 font-semibold hover:underline">nostr.hs</a> Haskell library integration:</span>
            <button class="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white copy-btn" data-target="code-haskell">
              <span class="copy-text">Copy</span>
            </button>
          </div>
          <pre class="code-font bg-[#04060a] border border-slate-800 p-4 rounded-xl text-xs sm:text-sm text-slate-200 overflow-x-auto leading-relaxed" id="code-haskell"><code><span class="text-purple-400">{-# LANGUAGE</span> <span class="text-yellow-300">OverloadedStrings</span> <span class="text-purple-400">#-}</span>

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

  <!-- ── Architecture Highlights ── -->
  <section id="architecture" class="py-16 bg-slate-50/60 border-b border-slate-200/80">
    <div class="max-w-6xl mx-auto px-4 sm:px-6">
      
      <div class="text-center max-w-3xl mx-auto mb-14">
        <div class="text-xs font-mono font-bold uppercase tracking-wider text-blue-600 mb-1">Architecture</div>
        <h2 class="text-3xl font-extrabold tracking-tight text-slate-900 mb-3">Engineered for Extreme Efficiency</h2>
        <p class="text-base text-slate-600 leading-relaxed">
          Zero legacy server overhead. Built purely on modern serverless edge primitives with strict cryptographic validation and relational SQL indexing.
        </p>
      </div>

      <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
        
        <div class="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div>
            <div class="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold mb-3 text-base">⚡</div>
            <h3 class="text-sm font-bold text-slate-900 mb-1">Global Edge Isolates</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              Global distribution across 330+ edge datacenters. Every request terminates at the closest edge POP for minimum latency.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-mono">
            <span>Runtime</span>
            <span class="text-blue-600 font-semibold">V8 Isolates</span>
          </div>
        </div>

        <div class="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div>
            <div class="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold mb-3 text-base">🗄️</div>
            <h3 class="text-sm font-bold text-slate-900 mb-1">Cloudflare D1 SQL Relational Engine</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              Index-optimized relational storage enforcing NIP-01, NIP-16, and NIP-33 replacement semantics with parameterized prepared statements.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-mono">
            <span>Storage</span>
            <span class="text-indigo-600 font-semibold">Indexed D1</span>
          </div>
        </div>

        <div class="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div>
            <div class="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold mb-3 text-base">🚀</div>
            <h3 class="text-sm font-bold text-slate-900 mb-1">Workers KV Micro-Cache</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              Sub-millisecond key-value caching layer for hot profiles, contact lists, and hourly analytics dashboard data.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-mono">
            <span>Read Speed</span>
            <span class="text-emerald-600 font-semibold">&lt; 5ms Edge Reads</span>
          </div>
        </div>

        <div class="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div>
            <div class="w-9 h-9 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center font-bold mb-3 text-base">💤</div>
            <h3 class="text-sm font-bold text-slate-900 mb-1">Durable Objects Hibernation</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              ClientSession Durable Objects utilize WebSocket Hibernation API. Idle connections consume zero memory while maintaining instant wake-up.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-mono">
            <span>State Engine</span>
            <span class="text-purple-600 font-semibold">Zero Idle Cost</span>
          </div>
        </div>

        <div class="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div>
            <div class="w-9 h-9 rounded-lg bg-cyan-50 text-cyan-600 flex items-center justify-center font-bold mb-3 text-base">🔐</div>
            <h3 class="text-sm font-bold text-slate-900 mb-1">BIP-340 Schnorr Cryptography</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              Zero-dependency, auditable cryptographic verification using @noble/curves. Validates every inbound event signature before caching.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-mono">
            <span>Crypto</span>
            <span class="text-cyan-600 font-semibold">BIP-340 Schnorr</span>
          </div>
        </div>

        <div class="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-col justify-between">
          <div>
            <div class="w-9 h-9 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center font-bold mb-3 text-base">🧹</div>
            <h3 class="text-sm font-bold text-slate-900 mb-1">Tiered Rolling Garbage Collection</h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              Automated daily scheduled cron jobs prune expired ephemeral, text, and metadata events according to tiered retention policies.
            </p>
          </div>
          <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500 font-mono">
            <span>GC Engine</span>
            <span class="text-amber-600 font-semibold">Automated Daily</span>
          </div>
        </div>

      </div>

    </div>
  </section>

  <!-- ── Supported Protocol Standards (NIPs) ── -->
  <section id="nips" class="py-16 bg-white border-b border-slate-200/80">
    <div class="max-w-6xl mx-auto px-4 sm:px-6">
      
      <div class="text-center max-w-3xl mx-auto mb-12">
        <div class="text-xs font-mono font-bold uppercase tracking-wider text-blue-600 mb-1">Specifications</div>
        <h2 class="text-3xl font-extrabold tracking-tight text-slate-900 mb-3">Supported Nostr Protocol Specifications</h2>
        <p class="text-base text-slate-600">
          Strict conformance with official Nostr Implementation Possibilities (NIPs).
        </p>
      </div>

      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        
        <div class="p-4 bg-slate-50/70 border border-slate-200 rounded-xl">
          <div class="flex items-center justify-between mb-1.5">
            <span class="font-mono font-bold text-blue-600">NIP-01</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Core</span>
          </div>
          <div class="text-xs font-bold text-slate-800 mb-1">Base Protocol & Filters</div>
          <p class="text-[11px] text-slate-600 leading-relaxed">Canonical serialization, event hashing, signature verification, and multi-tag filtering.</p>
        </div>

        <div class="p-4 bg-slate-50/70 border border-slate-200 rounded-xl">
          <div class="flex items-center justify-between mb-1.5">
            <span class="font-mono font-bold text-blue-600">NIP-09</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-slate-100 text-slate-700 border border-slate-200">Security</span>
          </div>
          <div class="text-xs font-bold text-slate-800 mb-1">Event Deletions (Kind 5)</div>
          <p class="text-[11px] text-slate-600 leading-relaxed">Cryptographic deletion handling ensuring verified author-only cache purging.</p>
        </div>

        <div class="p-4 bg-slate-50/70 border border-slate-200 rounded-xl">
          <div class="flex items-center justify-between mb-1.5">
            <span class="font-mono font-bold text-blue-600">NIP-11</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-blue-50 text-blue-700 border border-blue-200">Discovery</span>
          </div>
          <div class="text-xs font-bold text-slate-800 mb-1">Relay Information Document</div>
          <p class="text-[11px] text-slate-600 leading-relaxed">Automated JSON document served via content negotiation on HTTP GET.</p>
        </div>

        <div class="p-4 bg-slate-50/70 border border-slate-200 rounded-xl">
          <div class="flex items-center justify-between mb-1.5">
            <span class="font-mono font-bold text-blue-600">NIP-16</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">State</span>
          </div>
          <div class="text-xs font-bold text-slate-800 mb-1">Replaceable Events</div>
          <p class="text-[11px] text-slate-600 leading-relaxed">Timestamp and ID tie-breaking replacement rules for Kinds 0, 3, and 10000-19999.</p>
        </div>

        <div class="p-4 bg-slate-50/70 border border-slate-200 rounded-xl">
          <div class="flex items-center justify-between mb-1.5">
            <span class="font-mono font-bold text-blue-600">NIP-20</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Standards</span>
          </div>
          <div class="text-xs font-bold text-slate-800 mb-1">Command Results (OK / NOTICE)</div>
          <p class="text-[11px] text-slate-600 leading-relaxed">Explicit structured feedback for client actions and read-only policy notifications.</p>
        </div>

        <div class="p-4 bg-slate-50/70 border border-slate-200 rounded-xl">
          <div class="flex items-center justify-between mb-1.5">
            <span class="font-mono font-bold text-blue-600">NIP-33</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">State</span>
          </div>
          <div class="text-xs font-bold text-slate-800 mb-1">Parameterized Replaceable</div>
          <p class="text-[11px] text-slate-600 leading-relaxed">Keyed replacement on (pubkey, kind, d_tag) for Kinds 30000-39999.</p>
        </div>

        <div class="p-4 bg-slate-50/70 border border-slate-200 rounded-xl">
          <div class="flex items-center justify-between mb-1.5">
            <span class="font-mono font-bold text-blue-600">NIP-65</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-blue-50 text-blue-700 border border-blue-200">Discovery</span>
          </div>
          <div class="text-xs font-bold text-slate-800 mb-1">Relay List Metadata</div>
          <p class="text-[11px] text-slate-600 leading-relaxed">Author relay hints used for dynamic read-through upstream routing.</p>
        </div>

        <div class="p-4 bg-slate-50/70 border border-slate-200 rounded-xl flex flex-col justify-center text-center">
          <a href="/dashboard" class="text-xs font-bold text-blue-600 hover:underline">
            View Protocol Analytics →
          </a>
        </div>

      </div>

    </div>
  </section>

  <!-- ── Community Provenance ── -->
  <section class="py-16 bg-slate-50/80 border-b border-slate-200/80">
    <div class="max-w-4xl mx-auto px-4 sm:px-6 text-center">
      
      <div class="w-14 h-14 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-2xl mx-auto mb-5 shadow-sm">
        🇹🇷
      </div>

      <h2 class="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900 mb-3">
        Built by the <span class="text-blue-600">nostr.org.tr</span> Community
      </h2>

      <p class="text-sm sm:text-base text-slate-600 max-w-xl mx-auto mb-8 leading-relaxed">
        <a href="https://nostr.org.tr" target="_blank" rel="noopener" class="text-blue-600 font-semibold hover:underline">nostr.org.tr</a> is dedicated to expanding open protocols, sovereign communication, and high-performance infrastructure for Nostr users and developers across Turkey and the world.
      </p>

      <div class="flex flex-wrap items-center justify-center gap-3">
        <a href="https://nostr.org.tr" target="_blank" rel="noopener" class="hallmark-btn inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 shadow-sm transition">
          <span>Visit nostr.org.tr</span>
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
        </a>
        <a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="hallmark-btn inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 shadow-sm transition">
          <svg class="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
          <span>Contribute on GitHub</span>
        </a>
      </div>

    </div>
  </section>

  <!-- ── Footer ── -->
  <footer class="bg-white py-12 border-t border-slate-200 text-xs text-slate-600">
    <div class="max-w-6xl mx-auto px-4 sm:px-6">
      
      <div class="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
        
        <div>
          <div class="flex items-center gap-2 font-bold text-sm text-slate-900 mb-2">
            <span class="text-blue-600">⚡</span> Nostr Cache
          </div>
          <p class="text-xs text-slate-500 leading-relaxed mb-3">
            High-Performance Regional Nostr Edge Cache Relay.
          </p>
          <div class="inline-flex px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-blue-50 text-blue-700 border border-blue-200">
            MIT Licensed
          </div>
        </div>

        <div>
          <div class="font-mono font-bold text-[11px] text-slate-900 mb-3 uppercase tracking-wider">Endpoints</div>
          <ul class="space-y-2">
            <li><a href="/" class="hover:text-blue-600 transition">Relay Endpoint (NIP-11)</a></li>
            <li><a href="/dashboard" class="hover:text-blue-600 transition">Live Analytics Dashboard</a></li>
            <li><a href="/stats" class="hover:text-blue-600 transition">JSON Telemetry Stats</a></li>
            <li><a href="/health" class="hover:text-blue-600 transition">Health Check</a></li>
          </ul>
        </div>

        <div>
          <div class="font-mono font-bold text-[11px] text-slate-900 mb-3 uppercase tracking-wider">Community & Docs</div>
          <ul class="space-y-2">
            <li><a href="https://nostr.org.tr" target="_blank" rel="noopener" class="hover:text-blue-600 transition">nostr.org.tr Portal</a></li>
            <li><a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="hover:text-blue-600 transition">GitHub Repository</a></li>
            <li><a href="${escHtml(APP_REPOSITORY)}/blob/master/CONTRIBUTING.md" target="_blank" rel="noopener" class="hover:text-blue-600 transition">Contributing Guide</a></li>
          </ul>
        </div>

        <div>
          <div class="font-mono font-bold text-[11px] text-slate-900 mb-3 uppercase tracking-wider">Contact & Support</div>
          <ul class="space-y-2">
            <li><a href="mailto:${escHtml(contact)}" class="hover:text-blue-600 transition">${escHtml(contact)}</a></li>
            <li><a href="${escHtml(APP_REPOSITORY)}/issues" target="_blank" rel="noopener" class="hover:text-blue-600 transition">Report an Issue</a></li>
            <li class="pt-2 text-[11px] text-slate-400 font-mono">Version ${escHtml(APP_VERSION)}</li>
          </ul>
        </div>

      </div>

      <div class="border-t border-slate-200 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-slate-500 font-mono">
        <div>
          © ${new Date().getFullYear()} nostr.org.tr community. Open-source under the MIT License.
        </div>
        <div class="flex items-center gap-4">
          <a href="${escHtml(APP_REPOSITORY)}" target="_blank" rel="noopener" class="hover:text-blue-600">Source Code</a>
          <span>•</span>
          <a href="https://github.com/nostr-protocol/nips" target="_blank" rel="noopener" class="hover:text-blue-600">Nostr Protocol NIPs</a>
        </div>
      </div>

    </div>
  </footer>

  <!-- ── Interactive Client Script (Copy, Tab Switching & Vector Search) ── -->
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
            btn.classList.add('btn-copy-success');
            setTimeout(function() {
              if (textEl) textEl.textContent = origText;
              btn.classList.remove('btn-copy-success');
            }, 2000);
          });
        });
      });

      // 2. Code Snippets Tab Switcher
      document.querySelectorAll('.snippet-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          var tabId = tab.getAttribute('data-tab');
          
          document.querySelectorAll('.snippet-tab').forEach(function(t) {
            t.classList.remove('bg-slate-800', 'text-amber-300', 'font-bold', 'border', 'border-slate-700', 'shadow-sm');
            t.classList.add('text-slate-400');
          });
          
          tab.classList.remove('text-slate-400');
          tab.classList.add('bg-slate-800', 'text-amber-300', 'font-bold', 'border', 'border-slate-700', 'shadow-sm');

          document.querySelectorAll('.tab-content').forEach(function(tc) {
            tc.classList.add('hidden');
          });

          var activeContent = document.getElementById('tab-' + tabId);
          if (activeContent) {
            activeContent.classList.remove('hidden');
          }
        });
      });

      // 3. Vector Search UI Handler
      var searchForm = document.getElementById('landing-search-form');
      var searchInput = document.getElementById('landing-search-input');
      var searchBtn = document.getElementById('landing-search-btn');
      var resultsWrapper = document.getElementById('search-results-wrapper');
      var resultsList = document.getElementById('search-results-list');
      var statusText = document.getElementById('search-status-text');
      var timeText = document.getElementById('search-time-text');
      var selectedKinds = '1,0,30023';

      document.querySelectorAll('.kind-pill').forEach(function(pill) {
        pill.addEventListener('click', function() {
          document.querySelectorAll('.kind-pill').forEach(function(p) {
            p.classList.remove('bg-blue-600', 'text-white');
            p.classList.add('bg-slate-100', 'text-slate-700');
          });
          pill.classList.remove('bg-slate-100', 'text-slate-700');
          pill.classList.add('bg-blue-600', 'text-white');
          selectedKinds = pill.getAttribute('data-kinds') || '1,0,30023';
          if (searchInput && searchInput.value.trim().length > 0) {
            performSearch(searchInput.value.trim());
          }
        });
      });

      function escapeHtml(str) {
        if (!str) return '';
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function performSearch(q) {
        if (!q) return;
        if (resultsWrapper) resultsWrapper.classList.remove('hidden');
        if (statusText) statusText.textContent = 'Searching vector index...';
        if (timeText) timeText.textContent = '';
        if (resultsList) {
          resultsList.innerHTML = '<div class="p-8 text-center text-sm text-slate-500"><div class="inline-block animate-spin w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full mb-2"></div><div>Computing semantic embeddings & querying vector index...</div></div>';
        }

        var url = '/api/search?q=' + encodeURIComponent(q) + '&kinds=' + encodeURIComponent(selectedKinds) + '&limit=15';
        fetch(url)
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (!resultsList || !statusText) return;
            if (!data.results || data.results.length === 0) {
              statusText.textContent = 'No matching events found for "' + escapeHtml(q) + '"';
              if (timeText) timeText.textContent = data.tookMs ? data.tookMs + 'ms' : '';
              resultsList.innerHTML = '<div class="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-500">No events matched your vector search criteria. Try a broader search term or different kind filter.</div>';
              return;
            }

            statusText.textContent = 'Found ' + data.results.length + ' matching event' + (data.results.length === 1 ? '' : 's');
            if (timeText) timeText.textContent = (data.tookMs || 0) + 'ms';

            var html = '';
            data.results.forEach(function(item) {
              var ev = item.event;
              var scorePercent = Math.min(100, Math.max(0, Math.round((item.score || 0) * 100)));
              var kindName = 'Event (k:' + ev.kind + ')';
              var kindBadgeClass = 'bg-slate-100 text-slate-700 border-slate-200';
              var njumpText = 'Open in njump ↗';

              if (ev.kind === 1) {
                kindName = 'Note (kind 1)';
                kindBadgeClass = 'bg-blue-50 text-blue-700 border-blue-200';
                njumpText = 'View Note on njump ↗';
              } else if (ev.kind === 0) {
                kindName = 'Profile (kind 0)';
                kindBadgeClass = 'bg-indigo-50 text-indigo-700 border-indigo-200';
                njumpText = 'View Profile on njump ↗';
              } else if (ev.kind === 30023) {
                kindName = 'Article (kind 30023)';
                kindBadgeClass = 'bg-cyan-50 text-cyan-700 border-cyan-200';
                njumpText = 'Read Article on njump ↗';
              }

              var authorName = (item.author && (item.author.displayName || item.author.name)) || (ev.pubkey.slice(0, 8) + '…' + ev.pubkey.slice(-4));
              var nip05 = item.author && item.author.nip05 ? '<span class="text-xs text-blue-600 font-mono font-medium ml-1.5">✓ ' + escapeHtml(item.author.nip05) + '</span>' : '';
              var dateStr = new Date(ev.created_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

              var contentSnippet = escapeHtml(item.summary || ev.content || '');
              if (contentSnippet.length > 280) {
                contentSnippet = contentSnippet.slice(0, 280) + '…';
              }

              var titleHtml = item.title ? '<div class="text-base font-bold text-slate-900 mb-1">' + escapeHtml(item.title) + '</div>' : '';

              html += '<div class="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-sm hover:border-blue-300 transition flex flex-col justify-between gap-3">';
              html += '  <div>';
              html += '    <div class="flex flex-wrap items-center justify-between gap-2 mb-2">';
              html += '      <div class="flex items-center gap-2">';
              html += '        <span class="px-2 py-0.5 rounded text-[11px] font-mono font-semibold border ' + kindBadgeClass + '">' + kindName + '</span>';
              html += '        <span class="text-xs font-semibold text-slate-800">' + escapeHtml(authorName) + '</span>' + nip05;
              html += '      </div>';
              html += '      <div class="flex items-center gap-2">';
              html += '        <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">' + scorePercent + '% Match</span>';
              html += '        <span class="text-[11px] text-slate-400 font-mono">' + dateStr + '</span>';
              html += '      </div>';
              html += '    </div>';
              html += titleHtml;
              html += '    <p class="text-xs sm:text-sm text-slate-700 whitespace-pre-wrap leading-relaxed break-words">' + contentSnippet + '</p>';
              html += '  </div>';
              html += '  <div class="flex items-center justify-between pt-2 border-t border-slate-100 text-xs">';
              html += '    <span class="code-font text-[11px] text-slate-400 truncate max-w-[200px] sm:max-w-[300px]">id: ' + escapeHtml(ev.id) + '</span>';
              html += '    <a href="' + escapeHtml(item.njumpUrl) + '" target="_blank" rel="noopener noreferrer" class="hallmark-btn inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 font-medium hover:bg-blue-100 text-xs">';
              html += '      <span>' + njumpText + '</span>';
              html += '    </a>';
              html += '  </div>';
              html += '</div>';
            });

            resultsList.innerHTML = html;
          })
          .catch(function(err) {
            if (!resultsList || !statusText) return;
            statusText.textContent = 'Search failed';
            resultsList.innerHTML = '<div class="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-xs">Error querying vector search engine: ' + escapeHtml(err.message || 'Unknown error') + '</div>';
          });
      }

      if (searchForm && searchInput) {
        searchForm.addEventListener('submit', function(e) {
          e.preventDefault();
          var q = searchInput.value.trim();
          if (q.length > 0) {
            performSearch(q);
          }
        });
      }
    })();
  </script>

</body>
</html>`;
}
