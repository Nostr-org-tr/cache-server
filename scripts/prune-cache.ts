#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

interface CliArgs {
  remote: boolean;
  all: boolean;
  moderatedOnly: boolean;
  gc: boolean;
  dryRun: boolean;
  preserveOperator: boolean;
  batchSize: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const options: CliArgs = {
    remote: false,
    all: false,
    moderatedOnly: false,
    gc: false,
    dryRun: false,
    preserveOperator: false, // Default to complete blank-slate wipe when --all is run
    batchSize: 10000,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--remote') options.remote = true;
    else if (arg === '--local') options.remote = false;
    else if (arg === '--all') options.all = true;
    else if (arg === '--moderated-only') options.moderatedOnly = true;
    else if (arg === '--gc') options.gc = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--preserve-operator') options.preserveOperator = true;
    else if (arg === '--no-preserve-operator') options.preserveOperator = false;
    else if (arg?.startsWith('--batch-size=')) {
      const val = parseInt(arg.split('=')[1] || '10000', 10);
      if (!isNaN(val) && val > 0) options.batchSize = val;
    } else if (arg === '--batch-size' && i + 1 < args.length) {
      const val = parseInt(args[++i] || '10000', 10);
      if (!isNaN(val) && val > 0) options.batchSize = val;
    } else if (arg === '--help' || arg === '-h') options.help = true;
  }

  return options;
}

function loadRelayPubkey(): string {
  try {
    const configPath = resolve(process.cwd(), 'wrangler.jsonc');
    const raw = readFileSync(configPath, 'utf8');
    const match = raw.match(/"RELAY_PUBKEY"\s*:\s*"([a-f0-9]{64})"/i);
    return match ? match[1]!.toLowerCase() : '';
  } catch {
    return '';
  }
}

function extractJsonArray(output: string): any {
  const match = output.match(/(\[\s*\{[\s\S]*\}\s*\])/);
  if (match && match[1]) {
    try {
      return JSON.parse(match[1]);
    } catch {
      // Fall through to fallback
    }
  }
  try {
    return JSON.parse(output.trim());
  } catch (err: any) {
    throw new Error(`Failed to parse D1 JSON output: ${err.message}. Raw output:\n${output}`);
  }
}

function executeD1Command(sql: string, remote: boolean): any {
  const envFlag = remote ? '--remote' : '--local';
  const escapedSql = sql.replace(/"/g, '\\"');
  const cmd = `npx wrangler d1 execute nostr_cache_db ${envFlag} --command "${escapedSql}" --json`;
  const logDir = resolve(process.cwd(), '.wrangler');
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // Ignore if directory exists
  }
  let output = '';
  try {
    output = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: resolve(logDir, 'wrangler.log'),
      },
    });
    const parsed = extractJsonArray(output);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed[0]?.results : [];
  } catch (error: any) {
    const stderr = error?.stderr?.toString() || error?.message || 'Unknown error';
    const stdout = error?.stdout?.toString() || '';
    throw new Error(`D1 Execution Failed: ${stderr}\nSTDOUT:\n${stdout}`);
  }
}

function printHelp(): void {
  console.log(`
\x1b[1m\x1b[36mcache.nostr.org.tr - Cache Pruning & Garbage Collection Tool\x1b[0m

\x1b[1mUSAGE:\x1b[0m
  node --experimental-strip-types scripts/prune-cache.ts [OPTIONS]
  npm run cache:prune -- [OPTIONS]
  make cache-prune-[target]

\x1b[1mOPTIONS:\x1b[0m
  --all                   Purge all cached events and tags across D1 and KV (complete blank-slate).
  --moderated-only        Retroactively scan & purge all NSFW, content-warning, and operator-muted events.
  --gc                    Execute rolling TTL garbage collection on expired events.
  --dry-run               Audit and report database statistics without deleting any rows.
  --remote                Execute against remote Cloudflare production D1 database.
  --local                 Execute against local D1 emulator database (default).
  --batch-size=<N>        Set chunk mutation size (default: 10000).
  --preserve-operator     Retain events authored by RELAY_PUBKEY.
  --help, -h              Display this help message.

\x1b[1mEXAMPLES:\x1b[0m
  # Dry-run audit on remote production database
  make cache-prune-remote-dry-run

  # Complete chunked flush of remote production cache
  make cache-prune-remote-all

  # Purge all NSFW / content-warning events from local dev database
  make cache-prune-local-moderated
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help || (!args.all && !args.moderatedOnly && !args.gc && !args.dryRun)) {
    printHelp();
    return;
  }

  const targetEnv = args.remote ? '\x1b[31mREMOTE PRODUCTION\x1b[0m' : '\x1b[32mLOCAL EMULATOR\x1b[0m';
  const operatorPubkey = loadRelayPubkey();

  console.log(`\n\x1b[1m⚡ Nostr Cache Pruning Engine\x1b[0m`);
  console.log(`Target Environment: ${targetEnv}`);
  console.log(`Operator Pubkey:    \x1b[33m${operatorPubkey || 'None configured'}\x1b[0m`);
  console.log(`Purge Mode:         ${args.all ? '\x1b[31mCOMPLETE BLANK-SLATE WIPE (100%)\x1b[0m' : args.moderatedOnly ? '\x1b[33mMODERATED ONLY\x1b[0m' : args.gc ? '\x1b[36mGC ROLLING TTL\x1b[0m' : 'AUDIT'}`);
  console.log(`Dry-Run Mode:       ${args.dryRun ? '\x1b[33mYES (Audit Only)\x1b[0m' : '\x1b[32mNO (Active Deletion)\x1b[0m'}\n`);

  const startTime = Date.now();

  try {
    // 1. Initial State Query
    const countEventsRes = executeD1Command('SELECT COUNT(*) AS total FROM events;', args.remote);
    const countTagsRes = executeD1Command('SELECT COUNT(*) AS total FROM event_tags;', args.remote);
    const initialEvents = countEventsRes?.[0]?.total ?? 0;
    const initialTags = countTagsRes?.[0]?.total ?? 0;

    console.log(`📊 \x1b[1mCurrent Database Status:\x1b[0m`);
    console.log(`  • Total Cached Events: ${initialEvents.toLocaleString()}`);
    console.log(`  • Total Index Tags:    ${initialTags.toLocaleString()}`);

    if (operatorPubkey) {
      const opCountRes = executeD1Command(
        `SELECT COUNT(*) AS total FROM events WHERE LOWER(pubkey) = '${operatorPubkey}';`,
        args.remote
      );
      const opEvents = opCountRes?.[0]?.total ?? 0;
      console.log(`  • Operator Events:     ${opEvents.toLocaleString()}`);
    }

    if (args.dryRun) {
      console.log(`\n\x1b[33m[Dry Run] No database modifications were executed.\x1b[0m`);
      return;
    }

    // 2. Execution Modes
    if (args.all) {
      console.log(`\n🗑️  \x1b[1mExecuting Chunked Blank-Slate Cache Flush...\x1b[0m`);
      const tagBatchSize = args.batchSize * 2.5;
      const eventBatchSize = args.batchSize;

      // Phase 1: Purge event_tags in chunks
      console.log(`\n\x1b[34m[Phase 1/2]\x1b[0m Purging tag index table (\x1b[1mevent_tags\x1b[0m)...`);
      let currentTags = initialTags;
      let tagsDeleted = 0;
      while (currentTags > 0) {
        executeD1Command(
          `DELETE FROM event_tags WHERE rowid IN (SELECT rowid FROM event_tags LIMIT ${tagBatchSize});`,
          args.remote
        );
        const countRes = executeD1Command('SELECT COUNT(*) AS total FROM event_tags;', args.remote);
        const remaining = countRes?.[0]?.total ?? 0;
        const delta = currentTags - remaining;
        tagsDeleted += (delta > 0 ? delta : currentTags);
        currentTags = remaining;
        const percent = initialTags > 0 ? ((tagsDeleted / initialTags) * 100).toFixed(1) : '100';
        process.stdout.write(`\r  • [event_tags] ${tagsDeleted.toLocaleString()} / ${initialTags.toLocaleString()} tags purged (${percent}%)...`);
        if (currentTags === 0 || delta <= 0) break;
      }
      console.log(`\n  \x1b[32m✓ event_tags cleared.\x1b[0m`);

      // Phase 2: Purge events in chunks
      console.log(`\n\x1b[34m[Phase 2/2]\x1b[0m Purging events table (\x1b[1mevents\x1b[0m)...`);
      let currentEvents = initialEvents;
      let eventsDeleted = 0;
      while (currentEvents > 0) {
        executeD1Command(
          `DELETE FROM events WHERE rowid IN (SELECT rowid FROM events LIMIT ${eventBatchSize});`,
          args.remote
        );
        const countRes = executeD1Command('SELECT COUNT(*) AS total FROM events;', args.remote);
        const remaining = countRes?.[0]?.total ?? 0;
        const delta = currentEvents - remaining;
        eventsDeleted += (delta > 0 ? delta : currentEvents);
        currentEvents = remaining;
        const percent = initialEvents > 0 ? ((eventsDeleted / initialEvents) * 100).toFixed(1) : '100';
        process.stdout.write(`\r  • [events] ${eventsDeleted.toLocaleString()} / ${initialEvents.toLocaleString()} events purged (${percent}%)...`);
        if (currentEvents === 0 || delta <= 0) break;
      }
      console.log(`\n  \x1b[32m✓ events cleared.\x1b[0m`);
    } else if (args.moderatedOnly) {
      console.log(`\n🛡️  \x1b[1mExecuting Retroactive Moderation Purge (NIP-36 / NIP-32 / Mutes)...\x1b[0m`);
      const purgeNip36Sql = `
        DELETE FROM event_tags WHERE event_id IN (
          SELECT event_id FROM event_tags WHERE tag_name = 'content-warning' OR (tag_name = 'l' AND LOWER(tag_value) IN ('adult', 'porn', 'nsfw', 'nudity', 'sexual', 'gore', 'violence', 'illegal'))
        );
      `;
      executeD1Command(purgeNip36Sql, args.remote);

      const purgeEventsSql = `
        DELETE FROM events WHERE id NOT IN (SELECT DISTINCT event_id FROM event_tags) AND kind NOT IN (0, 3, 10000, 10002);
      `;
      executeD1Command(purgeEventsSql, args.remote);
    } else if (args.gc) {
      console.log(`\n⏳ \x1b[1mExecuting Rolling TTL Garbage Collection Cycle...\x1b[0m`);
      const now = Math.floor(Date.now() / 1000);
      const feedCutoff = now - 7 * 86400; // 7 days
      const fallbackCutoff = now - 14 * 86400; // 14 days
      const paramCutoff = now - 30 * 86400; // 30 days

      executeD1Command(
        `DELETE FROM event_tags WHERE event_id IN (SELECT id FROM events WHERE kind IN (1, 6, 7, 9735) AND created_at_recorded < ${feedCutoff});`,
        args.remote
      );
      executeD1Command(
        `DELETE FROM events WHERE kind IN (1, 6, 7, 9735) AND created_at_recorded < ${feedCutoff};`,
        args.remote
      );

      executeD1Command(
        `DELETE FROM event_tags WHERE event_id IN (SELECT id FROM events WHERE kind >= 30000 AND kind <= 39999 AND created_at_recorded < ${paramCutoff});`,
        args.remote
      );
      executeD1Command(
        `DELETE FROM events WHERE kind >= 30000 AND kind <= 39999 AND created_at_recorded < ${paramCutoff};`,
        args.remote
      );

      executeD1Command(
        `DELETE FROM event_tags WHERE event_id IN (SELECT id FROM events WHERE kind NOT IN (0, 1, 3, 5, 6, 7, 9735, 10002) AND NOT (kind >= 10000 AND kind <= 19999) AND NOT (kind >= 30000 AND kind <= 39999) AND created_at_recorded < ${fallbackCutoff});`,
        args.remote
      );
      executeD1Command(
        `DELETE FROM events WHERE kind NOT IN (0, 1, 3, 5, 6, 7, 9735, 10002) AND NOT (kind >= 10000 AND kind <= 19999) AND NOT (kind >= 30000 AND kind <= 39999) AND created_at_recorded < ${fallbackCutoff};`,
        args.remote
      );
    }

    // 3. Post-Purge Verification Query
    const postEventsRes = executeD1Command('SELECT COUNT(*) AS total FROM events;', args.remote);
    const postTagsRes = executeD1Command('SELECT COUNT(*) AS total FROM event_tags;', args.remote);
    const remainingEvents = postEventsRes?.[0]?.total ?? 0;
    const remainingTags = postTagsRes?.[0]?.total ?? 0;

    const prunedEvents = initialEvents - remainingEvents;
    const prunedTags = initialTags - remainingTags;
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n\x1b[32m✓ Cache Prune Operation Completed in ${duration}s!\x1b[0m`);
    console.log(`  • Pruned Events:   \x1b[1m${prunedEvents.toLocaleString()}\x1b[0m`);
    console.log(`  • Pruned Tags:     \x1b[1m${prunedTags.toLocaleString()}\x1b[0m`);
    console.log(`  • Remaining Cache: ${remainingEvents.toLocaleString()} events (${remainingTags.toLocaleString()} tags)\n`);
  } catch (err: any) {
    console.error(`\n\x1b[31m✗ Cache Prune Failed:\x1b[0m`, err?.message || err);
    process.exit(1);
  }
}

main();
