import { ClientSession } from './durable-objects/client-session';
import { runGarbageCollection } from './db/gc';
import { generateDashboard } from './dashboard/generator';
import { handleHttpRequest } from './http/router';
import type { Env } from './types/env';

export { ClientSession };

// Cron expression constants — must match wrangler.jsonc triggers.crons entries
const CRON_GC = '0 3 * * *';
const CRON_DASHBOARD = '0 * * * *';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleHttpRequest(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === CRON_GC) {
      // Daily at 03:00 UTC — rolling expiration garbage collection
      ctx.waitUntil(
        runGarbageCollection(env.DB)
          .then((result) => {
            console.log(
              `[GC] Garbage collection completed. Total pruned: ${result.totalPruned} in ${result.durationMs}ms`,
              result.breakdown
            );
          })
          .catch((err) => {
            console.error('[GC] Garbage collection failed with error:', err);
          })
      );
    } else if (event.cron === CRON_DASHBOARD) {
      // Every hour — rebuild static dashboard HTML and store in KV
      ctx.waitUntil(
        generateDashboard(env).catch((err) => {
          console.error('[Dashboard] Unhandled error in generateDashboard:', err);
        })
      );
    } else {
      console.warn(`[Scheduled] Unknown cron expression received: ${event.cron}`);
    }
  },
};

