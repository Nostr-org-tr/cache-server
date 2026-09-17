#!/usr/bin/env node

/**
 * End-to-End Live Deployment & Protocol Verification Suite
 * Relay: cache.nostr.org.tr
 * 
 * Verifies:
 * 1. HTTP NIP-11 Relay Information Document
 * 2. HTTP /health and /stats Endpoints
 * 3. WebSocket Connection & NIP-01 Protocol Handshake (REQ, EOSE, CLOSE)
 * 4. Event Ingestion, Cryptographic Verification, and Local Cache Retrieval
 * 5. Edge Latency and Performance Benchmarking
 */

import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';

// ANSI color formatting for terminal diagnostics
const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function logHeader(title: string): void {
  console.log(`\n${COLOR.bold}${COLOR.cyan}=== ${title} ===${COLOR.reset}`);
}

function logPass(msg: string, durationMs?: number): void {
  const timing = durationMs !== undefined ? ` ${COLOR.gray}(${durationMs.toFixed(1)}ms)${COLOR.reset}` : '';
  console.log(`  ${COLOR.green}✓${COLOR.reset} ${msg}${timing}`);
}

function logFail(msg: string, detail?: string): void {
  console.log(`  ${COLOR.red}✗ ${msg}${COLOR.reset}`);
  if (detail) {
    console.log(`    ${COLOR.yellow}${detail}${COLOR.reset}`);
  }
}

interface CliArgs {
  targetUrl: string;
  timeoutMs: number;
}

function printHelp(): void {
  console.log(`
Usage:
  npm run verify:live -- [options]
  node --experimental-strip-types scripts/verify-relay.ts [options]

Options:
  --url <url>        Target relay URL (default: http://127.0.0.1:8787 or https://cache.nostr.org.tr)
  --timeout <ms>     Per-operation timeout in milliseconds (default: 10000)
  --help, -h         Display this help message
`);
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  let targetUrl = 'http://127.0.0.1:8787';
  let timeoutMs = 10000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    } else if (args[i] === '--url' && args[i + 1]) {
      targetUrl = args[i + 1];
      i++;
    } else if (args[i] === '--timeout' && args[i + 1]) {
      timeoutMs = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (
      args[i].startsWith('http://') ||
      args[i].startsWith('https://') ||
      args[i].startsWith('ws://') ||
      args[i].startsWith('wss://')
    ) {
      targetUrl = args[i];
    }
  }

  return { targetUrl, timeoutMs };
}

function normalizeUrls(rawUrl: string): { httpUrl: string; wsUrl: string } {
  let httpUrl: string;
  let wsUrl: string;

  if (rawUrl.startsWith('ws://')) {
    wsUrl = rawUrl;
    httpUrl = rawUrl.replace('ws://', 'http://');
  } else if (rawUrl.startsWith('wss://')) {
    wsUrl = rawUrl;
    httpUrl = rawUrl.replace('wss://', 'https://');
  } else if (rawUrl.startsWith('https://')) {
    httpUrl = rawUrl;
    wsUrl = rawUrl.replace('https://', 'wss://');
  } else if (rawUrl.startsWith('http://')) {
    httpUrl = rawUrl;
    wsUrl = rawUrl.replace('http://', 'ws://');
  } else {
    httpUrl = `https://${rawUrl}`;
    wsUrl = `wss://${rawUrl}`;
  }

  httpUrl = httpUrl.replace(/\/+$/, '');
  wsUrl = wsUrl.replace(/\/+$/, '');

  return { httpUrl, wsUrl };
}

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function createSignedTestEvent(content: string): NostrEvent {
  const privKey = randomBytes(32);
  const pubkey = bytesToHex(schnorr.getPublicKey(privKey));
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 1; // Text note
  const tags: string[][] = [
    ['client', 'cache-nostr-verifier'],
    ['t', 'test'],
  ];

  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const idHash = sha256(new TextEncoder().encode(serialized));
  const id = bytesToHex(idHash);
  const sig = bytesToHex(schnorr.sign(id, privKey));

  return { id, pubkey, created_at, kind, tags, content, sig };
}

async function verifyHttpNip11(httpUrl: string): Promise<boolean> {
  logHeader('1. Testing NIP-11 Relay Information Document');
  const startTime = performance.now();

  try {
    const res = await fetch(`${httpUrl}/`, {
      headers: {
        Accept: 'application/nostr+json',
      },
    });
    const duration = performance.now() - startTime;

    if (!res.ok) {
      logFail(`NIP-11 endpoint returned HTTP status ${res.status}`);
      return false;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/nostr+json') && !contentType.includes('application/json')) {
      logFail(`Invalid Content-Type for NIP-11: '${contentType}' (expected application/nostr+json)`);
      return false;
    }

    const corsHeader = res.headers.get('access-control-allow-origin');
    if (corsHeader !== '*') {
      logFail(`CORS Access-Control-Allow-Origin header is '${corsHeader}', expected '*'`);
      return false;
    }

    const doc = await res.json() as Record<string, unknown>;
    if (!doc.name || !Array.isArray(doc.supported_nips) || !doc.software) {
      logFail('NIP-11 document missing required fields (name, supported_nips, software)');
      return false;
    }

    logPass(`NIP-11 document valid (Relay: "${doc.name}", NIPs: [${(doc.supported_nips as number[]).join(', ')}])`, duration);
    return true;
  } catch (err: unknown) {
    logFail('Failed to fetch NIP-11 document', (err as Error).message);
    return false;
  }
}

async function verifyHttpHealthAndStats(httpUrl: string): Promise<boolean> {
  logHeader('2. Testing Health & Stats Endpoints');

  // Test /health
  let healthOk = false;
  try {
    const healthStart = performance.now();
    const healthRes = await fetch(`${httpUrl}/health`);
    const healthDuration = performance.now() - healthStart;

    if (!healthRes.ok) {
      logFail(`/health returned status ${healthRes.status}`);
    } else {
      const healthData = await healthRes.json() as Record<string, unknown>;
      if (healthData.status !== 'ok') {
        logFail(`/health status report is not 'ok': ${JSON.stringify(healthData)}`);
      } else {
        logPass(`/health returned healthy status (D1 DB: ${healthData.database})`, healthDuration);
        healthOk = true;
      }
    }
  } catch (err: unknown) {
    logFail('Failed to query /health endpoint', (err as Error).message);
  }

  // Test /stats
  let statsOk = false;
  try {
    const statsStart = performance.now();
    const statsRes = await fetch(`${httpUrl}/stats`);
    const statsDuration = performance.now() - statsStart;

    if (!statsRes.ok) {
      logFail(`/stats returned status ${statsRes.status}`);
    } else {
      const statsData = await statsRes.json() as Record<string, unknown>;
      logPass(`/stats returned telemetry data (Cached events: ${statsData.total_events ?? 'N/A'})`, statsDuration);
      statsOk = true;
    }
  } catch (err: unknown) {
    logFail('Failed to query /stats endpoint', (err as Error).message);
  }

  return healthOk && statsOk;
}

async function verifyWebSocketFlow(wsUrl: string, timeoutMs: number): Promise<boolean> {
  logHeader('3. Testing NIP-01 WebSocket Protocol Lifecycle');
  const connectStart = performance.now();

  return new Promise<boolean>((resolve) => {
    let ws: WebSocket;
    let timer: NodeJS.Timeout;
    let isSettled = false;

    const cleanup = () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
        }
      } catch {
        // ignore close errors
      }
    };

    timer = setTimeout(() => {
      logFail(`WebSocket handshake or message response timed out after ${timeoutMs}ms`);
      cleanup();
      resolve(false);
    }, timeoutMs);

    try {
      ws = new WebSocket(wsUrl);
    } catch (err: unknown) {
      logFail('Failed to initiate WebSocket connection', (err as Error).message);
      cleanup();
      resolve(false);
      return;
    }

    const subId = `verify-${Math.random().toString(36).substring(2, 9)}`;

    ws.onopen = () => {
      const connectDuration = performance.now() - connectStart;
      logPass(`WebSocket handshake established to ${wsUrl}`, connectDuration);

      const reqMessage = JSON.stringify(['REQ', subId, { kinds: [1], limit: 5 }]);
      ws.send(reqMessage);
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : event.data.toString();
        const msg = JSON.parse(raw) as unknown[];
        const verb = msg[0];

        if (verb === 'EVENT' && msg[1] === subId) {
          const nostrEvent = msg[2] as NostrEvent;
          logPass(`Received streamed event ID ${nostrEvent.id.substring(0, 12)}... (Kind: ${nostrEvent.kind})`);
        } else if (verb === 'EOSE' && msg[1] === subId) {
          logPass(`Received EOSE for subscription "${subId}"`);
          ws.send(JSON.stringify(['CLOSE', subId]));
          cleanup();
          resolve(true);
        } else if (verb === 'NOTICE') {
          logPass(`Relay NOTICE: ${msg[1]}`);
        } else if (verb === 'CLOSED' && msg[1] === subId) {
          logPass(`Relay CLOSED subscription: ${msg[2] ?? ''}`);
          cleanup();
          resolve(true);
        }
      } catch (err: unknown) {
        logFail('Failed to parse WebSocket message from relay', (err as Error).message);
      }
    };

    ws.onerror = () => {
      logFail('WebSocket connection error encountered');
      cleanup();
      resolve(false);
    };

    ws.onclose = () => {
      if (!isSettled) {
        cleanup();
        resolve(false);
      }
    };
  });
}

async function verifyEventPublishAndCache(wsUrl: string, timeoutMs: number): Promise<boolean> {
  logHeader('4. Testing Event Publishing & Cache Retrieval');

  return new Promise<boolean>((resolve) => {
    let ws: WebSocket;
    let timer: NodeJS.Timeout;
    let isSettled = false;

    const cleanup = () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
          ws.close();
        }
      } catch {
        // ignore close errors
      }
    };

    timer = setTimeout(() => {
      logFail(`Event publish/query test timed out after ${timeoutMs}ms`);
      cleanup();
      resolve(false);
    }, timeoutMs);

    try {
      ws = new WebSocket(wsUrl);
    } catch (err: unknown) {
      logFail('Failed to connect WebSocket for event publish test', (err as Error).message);
      cleanup();
      resolve(false);
      return;
    }

    const testEvent = createSignedTestEvent(`Automated verification event at ${new Date().toISOString()}`);
    const querySubId = `query-${Math.random().toString(36).substring(2, 9)}`;
    let publishStart = 0;
    let eventReceivedInCache = false;

    ws.onopen = () => {
      publishStart = performance.now();
      ws.send(JSON.stringify(['EVENT', testEvent]));
    };

    ws.onmessage = (msgEvent: MessageEvent) => {
      try {
        const raw = typeof msgEvent.data === 'string' ? msgEvent.data : msgEvent.data.toString();
        const msg = JSON.parse(raw) as unknown[];
        const verb = msg[0];

        if (verb === 'OK' && msg[1] === testEvent.id) {
          const accepted = msg[2] as boolean;
          const reason = (msg[3] as string) || '';
          const pubDuration = performance.now() - publishStart;

          if (!accepted) {
            if (reason.toLowerCase().includes('read-only') || reason.toLowerCase().includes('blocked')) {
              logPass(`Direct write correctly blocked per policy (Read-Only Mode active: "${reason}")`, pubDuration);
              cleanup();
              resolve(true);
              return;
            }
            logFail(`Relay unexpectedly rejected test event: ${reason}`);
            cleanup();
            resolve(false);
            return;
          }

          logPass(`Event accepted by relay (ID: ${testEvent.id.substring(0, 16)}...)`, pubDuration);
          ws.send(JSON.stringify(['REQ', querySubId, { ids: [testEvent.id] }]));
        } else if (verb === 'EVENT' && msg[1] === querySubId) {
          const returnedEvent = msg[2] as NostrEvent;
          if (returnedEvent.id === testEvent.id) {
            eventReceivedInCache = true;
            logPass('Cache hit confirmed: Successfully queried and retrieved event from D1 cache');
          }
        } else if (verb === 'EOSE' && msg[1] === querySubId) {
          ws.send(JSON.stringify(['CLOSE', querySubId]));
          cleanup();
          if (eventReceivedInCache) {
            resolve(true);
          } else {
            logFail('EOSE received but published event was not found in cache query response');
            resolve(false);
          }
        }
      } catch (err: unknown) {
        logFail('Error processing message in publish test', (err as Error).message);
      }
    };

    ws.onerror = () => {
      logFail('WebSocket error during event publish/retrieval');
      cleanup();
      resolve(false);
    };

    ws.onclose = () => {
      if (!isSettled) {
        cleanup();
        resolve(false);
      }
    };
  });
}

async function runVerificationSuite(): Promise<void> {
  const { targetUrl, timeoutMs } = parseCliArgs();
  const { httpUrl, wsUrl } = normalizeUrls(targetUrl);

  console.log(`\n${COLOR.bold}${COLOR.cyan}╔═══════════════════════════════════════════════════════════╗${COLOR.reset}`);
  console.log(`${COLOR.bold}${COLOR.cyan}║   cache.nostr.org.tr - Live Edge Deployment Verifier      ║${COLOR.reset}`);
  console.log(`${COLOR.bold}${COLOR.cyan}╚═══════════════════════════════════════════════════════════╝${COLOR.reset}`);
  console.log(`Target HTTP:  ${COLOR.bold}${httpUrl}${COLOR.reset}`);
  console.log(`Target WS:    ${COLOR.bold}${wsUrl}${COLOR.reset}`);
  console.log(`Timeout:      ${timeoutMs}ms`);

  const results: boolean[] = [];

  // Step 1: NIP-11
  results.push(await verifyHttpNip11(httpUrl));

  // Step 2: Health & Stats
  results.push(await verifyHttpHealthAndStats(httpUrl));

  // Step 3: WebSocket Lifecycle
  results.push(await verifyWebSocketFlow(wsUrl, timeoutMs));

  // Step 4: Event Publishing & Cache Retrieval
  results.push(await verifyEventPublishAndCache(wsUrl, timeoutMs));

  // Final Summary
  logHeader('Final Verification Summary');
  const allPassed = results.every(Boolean);

  if (allPassed) {
    console.log(`\n${COLOR.bold}${COLOR.green}All live deployment checks PASSED successfully! 🎉${COLOR.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n${COLOR.bold}${COLOR.red}Some live deployment checks FAILED. Please review output above.${COLOR.reset}\n`);
    process.exit(1);
  }
}

// Execute the verification suite
runVerificationSuite().catch((err) => {
  console.error('Fatal error executing verification suite:', err);
  process.exit(1);
});
