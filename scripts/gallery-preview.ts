#!/usr/bin/env node

/**
 * CLI Tool: D1 Media Gallery Generator (Images & Videos)
 * cache.nostr.org.tr
 *
 * Queries Cloudflare D1 database for media-containing Nostr events (Images & Videos)
 * using full-text and pattern matching with configurable limits, extracts media metadata
 * (excluding postimg.cc), and generates a standalone responsive HTML gallery for rapid
 * visual and playback inspection.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { encodeNote, encodeNpub, shortenNpub } from '../src/protocol/nip19.ts';

// Terminal color helpers
const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

type MediaType = 'image' | 'video';

interface CliOptions {
  isRemote: boolean;
  limit: number;
  searchQuery: string;
  mediaFilter: 'all' | 'image' | 'video';
  outputFile: string;
  autoOpen: boolean;
}

interface RawEventRow {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  d_tag: string | null;
  raw_event: string;
}

interface ParsedNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface ExtractedMedia {
  url: string;
  type: MediaType;
  alt?: string;
  dim?: string;
  blurhash?: string;
  mimeType?: string;
  thumbnailUrl?: string;
}

interface GalleryItem {
  event: ParsedNostrEvent;
  npub: string;
  shortNpub: string;
  noteId: string;
  media: ExtractedMedia[];
  formattedDate: string;
  isoDate: string;
}

const IMAGE_EXTENSIONS_REGEX = /\.(?:jpg|jpeg|png|webp|gif|svg|avif)(?:\?[^\s"'<>]*)?$/i;
const VIDEO_EXTENSIONS_REGEX = /\.(?:mp4|mov|webm|m4v|ogv|mkv)(?:\?[^\s"'<>]*)?$/i;
const MEDIA_URL_EXTRACT_REGEX = /https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp|gif|svg|avif|mp4|mov|webm|m4v|ogv|mkv)(?:\?[^\s"'<>]*)?/gi;

function isPostImgUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();
    return host === 'postimg.cc' || host.endsWith('.postimg.cc') || host.includes('postimg');
  } catch {
    return urlStr.toLowerCase().includes('postimg.cc');
  }
}

function detectMediaType(urlStr: string, mime?: string): MediaType | null {
  if (mime) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
  }
  if (IMAGE_EXTENSIONS_REGEX.test(urlStr)) return 'image';
  if (VIDEO_EXTENSIONS_REGEX.test(urlStr)) return 'video';
  return null;
}

function printHelp(): void {
  console.log(`
${COLOR.bold}${COLOR.cyan}Nostr D1 Media Gallery Generator (Images & Videos)${COLOR.reset}
${COLOR.gray}Searches D1 database for media-containing events and generates an HTML preview gallery.${COLOR.reset}

${COLOR.bold}USAGE:${COLOR.reset}
  make gallery [ARGS="..."]
  npm run gallery -- [options]
  node --experimental-strip-types scripts/gallery-preview.ts [options]

${COLOR.bold}OPTIONS:${COLOR.reset}
  --remote           Query remote production Cloudflare D1 database (default)
  --local            Query local development D1 emulator
  --limit <number>   Maximum number of events to query (default: 50, max: 500)
  --query <text>     Optional text/keyword filter in content or tags
  --search <text>    Alias for --query
  --type <type>      Filter media type: 'all' | 'image' | 'video' (default: all)
  --out <file>       Output HTML filepath (default: gallery.html)
  --open             Attempt to open generated HTML in default browser
  --help, -h         Show this help message

${COLOR.bold}EXAMPLES:${COLOR.reset}
  make gallery
  make gallery ARGS="--limit 100 --remote"
  make gallery ARGS="--type video --limit 50"
  make gallery ARGS="--local --query nostr --limit 25"
  make gallery ARGS="--query bitcoin --out my-gallery.html --open"
`);
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  let isRemote = true; // Default to remote D1
  let limit = 50;
  let searchQuery = '';
  let mediaFilter: 'all' | 'image' | 'video' = 'all';
  let outputFile = 'gallery.html';
  let autoOpen = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--local') {
      isRemote = false;
    } else if (arg === '--remote') {
      isRemote = true;
    } else if ((arg === '--limit' || arg === '-l') && args[i + 1]) {
      const parsed = Number.parseInt(args[i + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 500);
      }
      i++;
    } else if ((arg === '--query' || arg === '--search' || arg === '-q') && args[i + 1]) {
      searchQuery = args[i + 1].trim();
      i++;
    } else if (arg === '--type' && args[i + 1]) {
      const t = args[i + 1].toLowerCase().trim();
      if (t === 'image' || t === 'images') mediaFilter = 'image';
      else if (t === 'video' || t === 'videos') mediaFilter = 'video';
      else mediaFilter = 'all';
      i++;
    } else if ((arg === '--out' || arg === '-o') && args[i + 1]) {
      outputFile = args[i + 1].trim();
      i++;
    } else if (arg === '--open') {
      autoOpen = true;
    }
  }

  return { isRemote, limit, searchQuery, mediaFilter, outputFile, autoOpen };
}

function buildSql(limit: number, searchQuery: string, mediaFilter: 'all' | 'image' | 'video'): string {
  const imageLikePatterns = [
    "raw_event LIKE '%.jpg%'",
    "raw_event LIKE '%.jpeg%'",
    "raw_event LIKE '%.png%'",
    "raw_event LIKE '%.webp%'",
    "raw_event LIKE '%.gif%'",
    "raw_event LIKE '%.avif%'",
    "raw_event LIKE '%.svg%'",
    'kind = 20',
  ];

  const videoLikePatterns = [
    "raw_event LIKE '%.mp4%'",
    "raw_event LIKE '%.mov%'",
    "raw_event LIKE '%.webm%'",
    "raw_event LIKE '%.m4v%'",
    "raw_event LIKE '%.ogv%'",
    'kind = 21',
    'kind = 22',
  ];

  let selectedPatterns: string[] = [];
  if (mediaFilter === 'image') {
    selectedPatterns = [...imageLikePatterns, 'kind = 1063'];
  } else if (mediaFilter === 'video') {
    selectedPatterns = [...videoLikePatterns, 'kind = 1063'];
  } else {
    selectedPatterns = [...imageLikePatterns, ...videoLikePatterns, 'kind = 1063'];
  }

  const mediaClause = `(${selectedPatterns.join(' OR ')})`;
  let whereClause = mediaClause;

  if (searchQuery.length > 0) {
    const sanitizedSearch = searchQuery.replace(/'/g, "''");
    whereClause += ` AND raw_event LIKE '%${sanitizedSearch}%'`;
  }

  return `SELECT id, pubkey, created_at, kind, d_tag, raw_event FROM events WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${limit};`;
}

function executeD1Query(sql: string, isRemote: boolean): RawEventRow[] {
  const targetFlag = isRemote ? '--remote' : '--local';
  console.log(`\n${COLOR.cyan}Executing D1 query on ${isRemote ? 'REMOTE' : 'LOCAL'} database...${COLOR.reset}`);

  const wranglerArgs = [
    'd1',
    'execute',
    'nostr_cache_db',
    targetFlag,
    '--command',
    sql,
    '--json',
  ];

  const proc = spawnSync('npx', ['wrangler', ...wranglerArgs], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (proc.error) {
    throw new Error(`Failed to invoke wrangler CLI: ${proc.error.message}`);
  }

  if (proc.status !== 0) {
    const errorMsg = proc.stderr || proc.stdout;
    throw new Error(`Wrangler D1 execution failed (exit code ${proc.status}): ${errorMsg}`);
  }

  try {
    const output = proc.stdout.trim();
    const parsed = JSON.parse(output) as Array<{ results?: RawEventRow[] }> | { results?: RawEventRow[] };
    
    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && Array.isArray(parsed[0]?.results)) {
        return parsed[0].results;
      }
      return [];
    }
    
    if (parsed && Array.isArray(parsed.results)) {
      return parsed.results;
    }

    return [];
  } catch (err) {
    throw new Error(`Failed to parse Wrangler JSON output: ${(err as Error).message}\nOutput: ${proc.stdout.slice(0, 500)}`);
  }
}

function extractMediaFromEvent(event: ParsedNostrEvent, mediaFilter: 'all' | 'image' | 'video'): ExtractedMedia[] {
  const mediaList: ExtractedMedia[] = [];
  const seenUrls = new Set<string>();

  const addMedia = (item: { url: string; mimeType?: string; alt?: string; dim?: string; blurhash?: string; thumbnailUrl?: string }) => {
    const cleanUrl = item.url.trim();
    if (!cleanUrl || seenUrls.has(cleanUrl)) return;
    
    // Filter postimg.cc URLs
    if (isPostImgUrl(cleanUrl)) return;

    try {
      const parsed = new URL(cleanUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

      const detectedType = detectMediaType(cleanUrl, item.mimeType);
      if (!detectedType) return;

      if (mediaFilter !== 'all' && detectedType !== mediaFilter) return;

      seenUrls.add(cleanUrl);
      mediaList.push({
        url: cleanUrl,
        type: detectedType,
        mimeType: item.mimeType,
        alt: item.alt,
        dim: item.dim,
        blurhash: item.blurhash,
        thumbnailUrl: item.thumbnailUrl,
      });
    } catch {
      // Ignore invalid URLs
    }
  };

  // 1. Extract from NIP-92 / NIP-94 imeta tags
  if (Array.isArray(event.tags)) {
    for (const tag of event.tags) {
      if (!Array.isArray(tag) || tag.length < 2) continue;
      const tagName = tag[0];

      if (tagName === 'imeta') {
        let mediaUrl = '';
        let alt: string | undefined;
        let dim: string | undefined;
        let blurhash: string | undefined;
        let mimeType: string | undefined;
        let thumbnailUrl: string | undefined;

        for (let i = 1; i < tag.length; i++) {
          const part = tag[i] ?? '';
          if (part.startsWith('url ')) {
            mediaUrl = part.substring(4).trim();
          } else if (part.startsWith('alt ')) {
            alt = part.substring(4).trim();
          } else if (part.startsWith('dim ')) {
            dim = part.substring(4).trim();
          } else if (part.startsWith('blurhash ')) {
            blurhash = part.substring(9).trim();
          } else if (part.startsWith('m ')) {
            mimeType = part.substring(2).trim();
          } else if (part.startsWith('thumb ') || part.startsWith('image ')) {
            thumbnailUrl = part.substring(part.indexOf(' ') + 1).trim();
          }
        }

        if (mediaUrl) {
          addMedia({ url: mediaUrl, alt, dim, blurhash, mimeType, thumbnailUrl });
        }
      } else if (tagName === 'image' || tagName === 'thumb' || tagName === 'url') {
        const potentialUrl = tag[1] ?? '';
        addMedia({ url: potentialUrl });
      }
    }
  }

  // 2. Extract from content using RegExp
  if (typeof event.content === 'string' && event.content.length > 0) {
    const matches = event.content.match(MEDIA_URL_EXTRACT_REGEX);
    if (matches) {
      for (const match of matches) {
        addMedia({ url: match });
      }
    }
  }

  // 3. Special handling for Kind 1063 (File Metadata) and Kind 21/22 (Video Events)
  if (Array.isArray(event.tags)) {
    const urlTag = event.tags.find((t) => t[0] === 'url');
    const mTag = event.tags.find((t) => t[0] === 'm');
    const dimTag = event.tags.find((t) => t[0] === 'dim');
    const altTag = event.tags.find((t) => t[0] === 'alt');
    const thumbTag = event.tags.find((t) => t[0] === 'thumb' || t[0] === 'image');

    if (urlTag && urlTag[1]) {
      addMedia({
        url: urlTag[1],
        mimeType: mTag ? mTag[1] : undefined,
        dim: dimTag ? dimTag[1] : undefined,
        alt: altTag ? altTag[1] : undefined,
        thumbnailUrl: thumbTag ? thumbTag[1] : undefined,
      });
    }
  }

  return mediaList;
}

function processRows(rows: RawEventRow[], mediaFilter: 'all' | 'image' | 'video'): GalleryItem[] {
  const items: GalleryItem[] = [];

  for (const row of rows) {
    try {
      const parsedEvent = JSON.parse(row.raw_event) as ParsedNostrEvent;
      const media = extractMediaFromEvent(parsedEvent, mediaFilter);

      if (media.length === 0) {
        continue;
      }

      let npub = '';
      let shortNpub = '';
      let noteId = '';

      try {
        npub = encodeNpub(parsedEvent.pubkey);
        shortNpub = shortenNpub(parsedEvent.pubkey, 8, 6);
      } catch {
        npub = parsedEvent.pubkey;
        shortNpub = parsedEvent.pubkey.slice(0, 10) + '…';
      }

      try {
        noteId = encodeNote(parsedEvent.id);
      } catch {
        noteId = parsedEvent.id;
      }

      const dateObj = new Date(parsedEvent.created_at * 1000);
      const formattedDate = dateObj.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const isoDate = dateObj.toISOString();

      items.push({
        event: parsedEvent,
        npub,
        shortNpub,
        noteId,
        media,
        formattedDate,
        isoDate,
      });
    } catch {
      // Skip malformed rows
    }
  }

  return items;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateGalleryHtml(items: GalleryItem[], options: CliOptions): string {
  const totalMedia = items.reduce((acc, it) => acc + it.media.length, 0);
  const totalImages = items.reduce((acc, it) => acc + it.media.filter((m) => m.type === 'image').length, 0);
  const totalVideos = items.reduce((acc, it) => acc + it.media.filter((m) => m.type === 'video').length, 0);
  const uniqueAuthors = new Set(items.map((it) => it.event.pubkey)).size;

  const serializedData = JSON.stringify(
    items.map((it) => ({
      id: it.event.id,
      pubkey: it.event.pubkey,
      npub: it.npub,
      noteId: it.noteId,
      kind: it.event.kind,
      created_at: it.event.created_at,
      formattedDate: it.formattedDate,
      content: it.event.content,
      media: it.media,
    }))
  );

  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nostr D1 Media Gallery Preview (Images & Videos) - cache.nostr.org.tr</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #090d16;
      --bg-secondary: #0f172a;
      --bg-card: #131d33;
      --bg-card-hover: #192644;
      --border-color: rgba(255, 255, 255, 0.08);
      --border-color-hover: rgba(99, 102, 241, 0.4);
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent-purple: #8b5cf6;
      --accent-indigo: #6366f1;
      --accent-cyan: #06b6d4;
      --accent-emerald: #10b981;
      --accent-rose: #f43f5e;
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --shadow-card: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.5;
      padding: 24px;
      min-height: 100vh;
    }

    .container {
      max-width: 1600px;
      margin: 0 auto;
    }

    header {
      background: linear-gradient(135deg, rgba(30, 27, 75, 0.8), rgba(15, 23, 42, 0.8));
      backdrop-filter: blur(12px);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      padding: 24px 32px;
      margin-bottom: 24px;
      box-shadow: var(--shadow-card);
    }

    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 20px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-icon {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--accent-purple), var(--accent-indigo));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 0 20px rgba(139, 92, 246, 0.4);
    }

    h1 {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.02em;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .subtitle {
      font-size: 13px;
      color: var(--text-secondary);
      font-family: 'JetBrains Mono', monospace;
    }

    .stats-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .stat-pill {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-color);
      border-radius: 9999px;
      padding: 6px 14px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .stat-pill strong {
      color: var(--accent-cyan);
      font-weight: 700;
    }

    .badge-source {
      background: rgba(99, 102, 241, 0.15);
      border-color: rgba(99, 102, 241, 0.3);
      color: #a5b4fc;
    }

    .controls-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: center;
      justify-content: space-between;
      border-top: 1px solid var(--border-color);
      padding-top: 16px;
    }

    .search-box {
      flex: 1;
      min-width: 280px;
      position: relative;
    }

    .search-box input {
      width: 100%;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: 10px 16px 10px 38px;
      color: var(--text-primary);
      font-size: 14px;
      outline: none;
      transition: all 0.2s ease;
    }

    .search-box input:focus {
      border-color: var(--accent-indigo);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }

    .search-icon {
      position: absolute;
      left: 14px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      font-size: 14px;
      pointer-events: none;
    }

    .filter-group {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      padding: 8px 14px;
      font-size: 13px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }

    .btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: var(--text-primary);
      border-color: var(--text-muted);
    }

    .btn-active {
      background: var(--accent-indigo);
      color: #fff;
      border-color: var(--accent-indigo);
    }

    .btn-active:hover {
      background: #4f46e5;
    }

    /* Gallery Grid */
    .gallery-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 24px;
    }

    .gallery-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: var(--shadow-card);
      transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .gallery-card:hover {
      transform: translateY(-4px);
      border-color: var(--border-color-hover);
      box-shadow: 0 15px 30px -5px rgba(0, 0, 0, 0.6), 0 0 15px rgba(99, 102, 241, 0.2);
    }

    /* Multi-Media Showcase */
    .media-showcase {
      display: grid;
      gap: 4px;
      background: #020617;
      padding: 4px;
      position: relative;
    }

    .media-showcase.single {
      grid-template-columns: 1fr;
    }

    .media-showcase.double {
      grid-template-columns: 1fr 1fr;
    }

    .media-showcase.triple {
      grid-template-columns: 1fr 1fr 1fr;
    }

    .media-showcase.multi {
      grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    }

    .media-thumb-wrap {
      position: relative;
      background: #0b0f19;
      aspect-ratio: 1;
      overflow: hidden;
      cursor: pointer;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .media-showcase.single .media-thumb-wrap {
      aspect-ratio: 16 / 10;
    }

    .media-showcase.double .media-thumb-wrap {
      aspect-ratio: 4 / 3;
    }

    .media-thumb-wrap img, .media-thumb-wrap video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.3s ease;
    }

    .media-thumb-wrap:hover img, .media-thumb-wrap:hover video {
      transform: scale(1.05);
    }

    .type-badge {
      position: absolute;
      top: 8px;
      left: 8px;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(6px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 10px;
      font-weight: 700;
      color: #38bdf8;
      font-family: 'JetBrains Mono', monospace;
      z-index: 2;
    }

    .type-badge.video {
      color: var(--accent-rose);
      border-color: rgba(244, 63, 94, 0.4);
    }

    .image-badge {
      position: absolute;
      top: 8px;
      right: 8px;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      padding: 2px 6px;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      color: #fff;
      z-index: 2;
    }

    .media-idx-badge {
      position: absolute;
      bottom: 4px;
      right: 4px;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 10px;
      color: #94a3b8;
      font-family: 'JetBrains Mono', monospace;
      z-index: 2;
    }

    .video-play-icon {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 36px;
      height: 36px;
      background: rgba(0, 0, 0, 0.65);
      border: 2px solid #fff;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 14px;
      pointer-events: none;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    }

    .img-fallback {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 10px;
      text-align: center;
      color: var(--text-muted);
      font-size: 11px;
      height: 100%;
      width: 100%;
      background: #0b0f19;
    }

    .img-fallback span {
      font-size: 18px;
      margin-bottom: 2px;
    }

    .card-body {
      padding: 16px;
      display: flex;
      flex-direction: column;
      flex: 1;
      gap: 12px;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .author-info {
      display: flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      color: var(--text-secondary);
      font-size: 13px;
      font-family: 'JetBrains Mono', monospace;
    }

    .author-info:hover {
      color: var(--accent-cyan);
    }

    .author-avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: linear-gradient(135deg, #4f46e5, #9333ea);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: #fff;
      font-weight: 700;
    }

    .event-kind {
      background: rgba(255, 255, 255, 0.06);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
    }

    .content-snippet {
      font-size: 13px;
      color: var(--text-primary);
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      line-height: 1.4;
      word-break: break-word;
    }

    .card-footer {
      margin-top: auto;
      border-top: 1px solid var(--border-color);
      padding-top: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      color: var(--text-muted);
    }

    .client-links {
      display: flex;
      gap: 6px;
    }

    .client-link {
      color: var(--text-secondary);
      text-decoration: none;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      transition: all 0.15s;
    }

    .client-link:hover {
      background: var(--accent-indigo);
      color: #fff;
      border-color: var(--accent-indigo);
    }

    /* Lightbox Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.94);
      backdrop-filter: blur(10px);
      z-index: 9999;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .modal-overlay.active {
      display: flex;
    }

    .modal-content {
      max-width: 90vw;
      max-height: 92vh;
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.75);
      position: relative;
    }

    .modal-media-wrap {
      background: #000;
      display: flex;
      align-items: center;
      justify-content: center;
      max-height: 70vh;
      overflow: hidden;
      position: relative;
    }

    .modal-media-wrap img, .modal-media-wrap video {
      max-width: 100%;
      max-height: 70vh;
      object-fit: contain;
    }

    .modal-nav-btn {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(0, 0, 0, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      font-size: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
      z-index: 10;
    }

    .modal-nav-btn:hover {
      background: var(--accent-indigo);
      border-color: var(--accent-indigo);
    }

    .modal-nav-prev {
      left: 16px;
    }

    .modal-nav-next {
      right: 16px;
    }

    .modal-details {
      padding: 16px 20px;
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .modal-close {
      position: absolute;
      top: 12px;
      right: 12px;
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      font-size: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 10;
      transition: background 0.2s;
    }

    .modal-close:hover {
      background: #ef4444;
      border-color: #ef4444;
    }

    .copy-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--accent-emerald);
      color: #fff;
      padding: 10px 20px;
      border-radius: var(--radius-sm);
      font-weight: 600;
      font-size: 13px;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.4);
      display: none;
      z-index: 10000;
    }

    .no-results {
      grid-column: 1 / -1;
      text-align: center;
      padding: 80px 20px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>

  <div class="container">
    <header>
      <div class="header-top">
        <div class="brand">
          <div class="brand-icon">🎬</div>
          <div>
            <h1>cache.nostr.org.tr Media Gallery</h1>
            <div class="subtitle">Cloudflare D1 Images & Videos Inspector (postimg.cc excluded)</div>
          </div>
        </div>

        <div class="stats-bar">
          <div class="stat-pill badge-source">
            <span>Database:</span>
            <strong>${options.isRemote ? 'Remote D1 (Cloudflare Edge)' : 'Local D1 Emulator'}</strong>
          </div>
          <div class="stat-pill">
            <span>Events:</span>
            <strong id="stat-events">${items.length}</strong>
          </div>
          <div class="stat-pill">
            <span>Total Media:</span>
            <strong id="stat-media">${totalMedia}</strong>
          </div>
          <div class="stat-pill">
            <span>Images:</span>
            <strong style="color: var(--accent-cyan);">${totalImages}</strong>
          </div>
          <div class="stat-pill">
            <span>Videos:</span>
            <strong style="color: var(--accent-rose);">${totalVideos}</strong>
          </div>
          <div class="stat-pill">
            <span>Authors:</span>
            <strong>${uniqueAuthors}</strong>
          </div>
        </div>
      </div>

      <div class="controls-bar">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input type="text" id="client-search" placeholder="Filter by text, npub, tag, kind, or media type..." autocomplete="off">
        </div>
        
        <div class="filter-group">
          <button class="btn btn-active" id="btn-filter-all" onclick="filterMediaType('all')">All</button>
          <button class="btn" id="btn-filter-images" onclick="filterMediaType('image')">🖼️ Images (${totalImages})</button>
          <button class="btn" id="btn-filter-videos" onclick="filterMediaType('video')">🎥 Videos (${totalVideos})</button>
        </div>

        <div class="view-toggles">
          <button class="btn btn-active" id="btn-grid-medium" onclick="setGridSize('medium')">Medium</button>
          <button class="btn" id="btn-grid-large" onclick="setGridSize('large')">Large</button>
        </div>
      </div>
    </header>

    <main class="gallery-grid" id="gallery-grid">
      ${items
        .map((item, itemIdx) => {
          let showcaseClass = 'single';
          if (item.media.length === 2) showcaseClass = 'double';
          else if (item.media.length === 3) showcaseClass = 'triple';
          else if (item.media.length > 3) showcaseClass = 'multi';

          const hasImages = item.media.some((m) => m.type === 'image');
          const hasVideos = item.media.some((m) => m.type === 'video');
          const mediaTypesAttr = [hasImages ? 'image' : '', hasVideos ? 'video' : ''].filter(Boolean).join(' ');

          return `
        <div class="gallery-card" data-idx="${itemIdx}" data-types="${mediaTypesAttr}" data-search="${escapeHtml(
            (item.event.content + ' ' + item.npub + ' ' + item.noteId + ' ' + item.event.kind + ' ' + mediaTypesAttr).toLowerCase()
          )}">
          
          <div class="media-showcase ${showcaseClass}">
            <div class="image-badge">k:${item.event.kind} (${item.media.length} item${item.media.length > 1 ? 's' : ''})</div>
            ${item.media
              .map((m, mIdx) => {
                if (m.type === 'video') {
                  return `
              <div class="media-thumb-wrap" onclick="openModal(${itemIdx}, ${mIdx})" title="Click to play video (${mIdx + 1}/${item.media.length})">
                <span class="type-badge video">VIDEO</span>
                <video 
                  src="${escapeHtml(m.url)}" 
                  muted 
                  playsinline 
                  preload="metadata" 
                  onmouseover="this.play()" 
                  onmouseout="this.pause()" 
                  onerror="handleMediaError(this)"
                ></video>
                <div class="video-play-icon">▶</div>
                <div class="img-fallback">
                  <span>⚠️</span>
                  <div>Video offline</div>
                </div>
                ${item.media.length > 1 ? `<div class="media-idx-badge">${mIdx + 1}/${item.media.length}</div>` : ''}
              </div>
            `;
                }

                return `
              <div class="media-thumb-wrap" onclick="openModal(${itemIdx}, ${mIdx})" title="Click to view image (${mIdx + 1}/${item.media.length})">
                <span class="type-badge">IMG</span>
                <img 
                  src="${escapeHtml(m.url)}" 
                  alt="${escapeHtml(m.alt || 'Nostr Media')}" 
                  loading="lazy" 
                  onerror="handleMediaError(this)"
                />
                <div class="img-fallback">
                  <span>⚠️</span>
                  <div>Image offline</div>
                </div>
                ${item.media.length > 1 ? `<div class="media-idx-badge">${mIdx + 1}/${item.media.length}</div>` : ''}
              </div>
            `;
              })
              .join('')}
          </div>
          
          <div class="card-body">
            <div class="card-header">
              <a href="https://njump.me/${escapeHtml(item.npub)}" target="_blank" rel="noopener noreferrer" class="author-info" title="${escapeHtml(item.npub)}">
                <div class="author-avatar">${escapeHtml(item.event.pubkey.slice(0, 2).toUpperCase())}</div>
                <span>${escapeHtml(item.shortNpub)}</span>
              </a>
              <span class="event-kind">Kind ${item.event.kind}</span>
            </div>

            <div class="content-snippet" title="${escapeHtml(item.event.content)}">
              ${escapeHtml(item.event.content || '(No text content)')}
            </div>

            <div class="card-footer">
              <time datetime="${item.isoDate}">${item.formattedDate}</time>
              <div class="client-links">
                <a href="https://njump.me/${escapeHtml(item.noteId)}" target="_blank" rel="noopener noreferrer" class="client-link" title="Open in njump.me">njump</a>
                <a href="https://primal.net/e/${escapeHtml(item.noteId)}" target="_blank" rel="noopener noreferrer" class="client-link" title="Open in Primal">primal</a>
                <a href="https://nostr.band/${escapeHtml(item.noteId)}" target="_blank" rel="noopener noreferrer" class="client-link" title="Open in nostr.band">band</a>
                <button class="client-link" style="cursor:pointer;" onclick="copyToClipboard('${escapeHtml(item.media[0]?.url || '')}', 'Media URL copied!')">copy url</button>
              </div>
            </div>
          </div>
        </div>
      `;
        })
        .join('')}
    </main>

    <div id="no-results-msg" class="no-results" style="display: none;">
      <h2>No media events match your filter</h2>
      <p style="margin-top: 8px;">Try adjusting search keywords or media type filter.</p>
    </div>
  </div>

  <!-- Lightbox Modal -->
  <div class="modal-overlay" id="lightbox-modal" onclick="closeModal(event)">
    <div class="modal-content" onclick="event.stopPropagation()">
      <button class="modal-close" onclick="closeModal()">&times;</button>
      <div class="modal-media-wrap">
        <button class="modal-nav-btn modal-nav-prev" id="modal-prev-btn" onclick="prevModalMedia()">&#10094;</button>
        <img id="modal-img" src="" alt="Full preview" style="display: none;">
        <video id="modal-video" src="" controls autoplay playsinline style="display: none;"></video>
        <button class="modal-nav-btn modal-nav-next" id="modal-next-btn" onclick="nextModalMedia()">&#10095;</button>
      </div>
      <div class="modal-details">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <a id="modal-author-link" href="#" target="_blank" rel="noopener noreferrer" class="author-info">
            <span id="modal-author-name"></span>
          </a>
          <div style="font-size: 12px; color: var(--text-muted);" id="modal-media-counter"></div>
          <div style="display: flex; gap: 8px;">
            <button class="btn" id="modal-copy-media" onclick="copyModalMediaUrl()">Copy Media URL</button>
            <button class="btn" id="modal-copy-id" onclick="copyModalEventId()">Copy Event ID</button>
          </div>
        </div>
        <p id="modal-caption" style="font-size: 13px; color: var(--text-secondary); max-height: 80px; overflow-y: auto;"></p>
      </div>
    </div>
  </div>

  <div class="copy-toast" id="copy-toast">Copied to clipboard!</div>

  <script>
    const GALLERY_DATA = ${serializedData};
    let currentItemIdx = 0;
    let currentMediaIdx = 0;
    let activeTypeFilter = 'all';

    function handleMediaError(element) {
      element.style.display = 'none';
      const fallback = element.nextElementSibling;
      if (fallback && fallback.classList.contains('img-fallback')) {
        fallback.style.display = 'flex';
      }
    }

    function openModal(itemIdx, mediaIdx) {
      currentItemIdx = itemIdx;
      currentMediaIdx = mediaIdx;
      updateModalView();

      const modal = document.getElementById('lightbox-modal');
      modal.classList.add('active');
      document.body.style.overflow = 'hidden';
    }

    function updateModalView() {
      const item = GALLERY_DATA[currentItemIdx];
      if (!item || !item.media || item.media.length === 0) return;

      if (currentMediaIdx < 0) currentMediaIdx = item.media.length - 1;
      if (currentMediaIdx >= item.media.length) currentMediaIdx = 0;

      const media = item.media[currentMediaIdx];
      const modalImg = document.getElementById('modal-img');
      const modalVideo = document.getElementById('modal-video');
      const authorLink = document.getElementById('modal-author-link');
      const authorName = document.getElementById('modal-author-name');
      const caption = document.getElementById('modal-caption');
      const counter = document.getElementById('modal-media-counter');
      const prevBtn = document.getElementById('modal-prev-btn');
      const nextBtn = document.getElementById('modal-next-btn');

      if (media.type === 'video') {
        modalImg.style.display = 'none';
        modalImg.src = '';
        modalVideo.style.display = 'block';
        modalVideo.src = media.url;
        modalVideo.play().catch(() => {});
      } else {
        modalVideo.style.display = 'none';
        modalVideo.pause();
        modalVideo.src = '';
        modalImg.style.display = 'block';
        modalImg.src = media.url;
      }

      authorLink.href = 'https://njump.me/' + item.npub;
      authorName.textContent = item.npub.slice(0, 12) + '…' + item.npub.slice(-6);
      caption.textContent = item.content || '(No text content)';
      counter.textContent = (media.type === 'video' ? '🎥 Video ' : '🖼️ Image ') + (currentMediaIdx + 1) + ' of ' + item.media.length;

      if (item.media.length > 1) {
        prevBtn.style.display = 'flex';
        nextBtn.style.display = 'flex';
      } else {
        prevBtn.style.display = 'none';
        nextBtn.style.display = 'none';
      }
    }

    function prevModalMedia() {
      currentMediaIdx--;
      updateModalView();
    }

    function nextModalMedia() {
      currentMediaIdx++;
      updateModalView();
    }

    function closeModal(event) {
      const modal = document.getElementById('lightbox-modal');
      const modalVideo = document.getElementById('modal-video');
      modalVideo.pause();
      modalVideo.src = '';
      modal.classList.remove('active');
      document.body.style.overflow = 'auto';
    }

    document.addEventListener('keydown', (e) => {
      const modal = document.getElementById('lightbox-modal');
      if (!modal.classList.contains('active')) return;
      if (e.key === 'Escape') closeModal();
      if (e.key === 'ArrowLeft') prevModalMedia();
      if (e.key === 'ArrowRight') nextModalMedia();
    });

    function setGridSize(size) {
      const grid = document.getElementById('gallery-grid');
      const btnMed = document.getElementById('btn-grid-medium');
      const btnLrg = document.getElementById('btn-grid-large');

      if (size === 'large') {
        grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(480px, 1fr))';
        btnLrg.classList.add('btn-active');
        btnMed.classList.remove('btn-active');
      } else {
        grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(360px, 1fr))';
        btnMed.classList.add('btn-active');
        btnLrg.classList.remove('btn-active');
      }
    }

    function filterMediaType(type) {
      activeTypeFilter = type;
      document.getElementById('btn-filter-all').classList.toggle('btn-active', type === 'all');
      document.getElementById('btn-filter-images').classList.toggle('btn-active', type === 'image');
      document.getElementById('btn-filter-videos').classList.toggle('btn-active', type === 'video');
      applyFilters();
    }

    function applyFilters() {
      const searchInput = document.getElementById('client-search');
      const query = searchInput.value.toLowerCase().trim();
      const cards = document.querySelectorAll('.gallery-card');
      let visibleCount = 0;

      cards.forEach((card) => {
        const text = card.getAttribute('data-search') || '';
        const types = card.getAttribute('data-types') || '';

        const matchesSearch = !query || text.includes(query);
        const matchesType = activeTypeFilter === 'all' || types.includes(activeTypeFilter);

        if (matchesSearch && matchesType) {
          card.style.display = 'flex';
          visibleCount++;
        } else {
          card.style.display = 'none';
        }
      });

      const noRes = document.getElementById('no-results-msg');
      if (visibleCount === 0 && cards.length > 0) {
        noRes.style.display = 'block';
      } else {
        noRes.style.display = 'none';
      }

      document.getElementById('stat-events').textContent = visibleCount;
    }

    document.getElementById('client-search').addEventListener('input', applyFilters);

    function showToast(msg) {
      const toast = document.getElementById('copy-toast');
      toast.textContent = msg;
      toast.style.display = 'block';
      setTimeout(() => {
        toast.style.display = 'none';
      }, 2500);
    }

    function copyToClipboard(text, msg) {
      navigator.clipboard.writeText(text).then(() => {
        showToast(msg || 'Copied to clipboard!');
      }).catch(() => {
        prompt('Copy this link:', text);
      });
    }

    function copyModalMediaUrl() {
      const item = GALLERY_DATA[currentItemIdx];
      const media = item?.media[currentMediaIdx];
      if (media?.url) {
        copyToClipboard(media.url, 'Media URL copied!');
      }
    }

    function copyModalEventId() {
      const item = GALLERY_DATA[currentItemIdx];
      if (item?.id) {
        copyToClipboard(item.id, 'Event ID copied!');
      }
    }
  </script>
</body>
</html>`;
}

function openInBrowser(filePath: string): void {
  const absolutePath = path.resolve(filePath);
  const platform = process.platform;
  let command = '';
  let args: string[] = [];

  if (platform === 'darwin') {
    command = 'open';
    args = [absolutePath];
  } else if (platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '""', absolutePath];
  } else {
    command = 'xdg-open';
    args = [absolutePath];
  }

  try {
    spawnSync(command, args, { stdio: 'ignore' });
    console.log(`  ${COLOR.green}✓ Opened in default browser${COLOR.reset}`);
  } catch {
    console.log(`  ${COLOR.yellow}Notice: Please open ${absolutePath} in your browser.${COLOR.reset}`);
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs();

  console.log(`\n${COLOR.bold}${COLOR.cyan}╔═══════════════════════════════════════════════════════════╗${COLOR.reset}`);
  console.log(`${COLOR.bold}${COLOR.cyan}║   cache.nostr.org.tr - D1 Media Gallery (Images & Videos) ║${COLOR.reset}`);
  console.log(`${COLOR.bold}${COLOR.cyan}╚═══════════════════════════════════════════════════════════╝${COLOR.reset}`);
  console.log(`Target DB:      ${COLOR.bold}${options.isRemote ? 'Remote (Cloudflare D1)' : 'Local (Wrangler D1)'}${COLOR.reset}`);
  console.log(`Limit:          ${COLOR.bold}${options.limit}${COLOR.reset}`);
  console.log(`Media Filter:   ${COLOR.bold}${options.mediaFilter.toUpperCase()}${COLOR.reset}`);
  if (options.searchQuery) {
    console.log(`Search Query:   ${COLOR.bold}"${options.searchQuery}"${COLOR.reset}`);
  }
  console.log(`Filter Policy:  ${COLOR.bold}Excluding postimg.cc URLs${COLOR.reset}`);
  console.log(`Output Target:  ${COLOR.bold}${options.outputFile}${COLOR.reset}`);

  // 1. Build and execute SQL
  const sql = buildSql(options.limit, options.searchQuery, options.mediaFilter);
  const rows = executeD1Query(sql, options.isRemote);

  console.log(`  ${COLOR.green}✓ Retrieved ${rows.length} candidate event rows from D1${COLOR.reset}`);

  // 2. Process rows and extract media
  const items = processRows(rows, options.mediaFilter);
  const totalExtractedMedia = items.reduce((acc, it) => acc + it.media.length, 0);
  const totalExtractedImages = items.reduce((acc, it) => acc + it.media.filter((m) => m.type === 'image').length, 0);
  const totalExtractedVideos = items.reduce((acc, it) => acc + it.media.filter((m) => m.type === 'video').length, 0);

  console.log(
    `  ${COLOR.green}✓ Filtered and extracted ${totalExtractedMedia} media (${totalExtractedImages} images, ${totalExtractedVideos} videos) across ${items.length} events${COLOR.reset}`
  );

  // 3. Render HTML
  const html = generateGalleryHtml(items, options);
  const resolvedOutputPath = path.resolve(options.outputFile);
  fs.writeFileSync(resolvedOutputPath, html, 'utf8');

  console.log(`\n${COLOR.bold}${COLOR.green}Media Gallery generated successfully! 🎉${COLOR.reset}`);
  console.log(`File saved to: ${COLOR.bold}${COLOR.cyan}${resolvedOutputPath}${COLOR.reset}`);
  console.log(`File URL:      ${COLOR.bold}file://${resolvedOutputPath}${COLOR.reset}\n`);

  // 4. Optionally open
  if (options.autoOpen) {
    openInBrowser(resolvedOutputPath);
  }
}

main().catch((err: unknown) => {
  console.error(`\n${COLOR.bold}${COLOR.red}Fatal Error:${COLOR.reset}`, (err as Error).message);
  process.exit(1);
});
