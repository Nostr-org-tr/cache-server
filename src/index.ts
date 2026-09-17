import { ClientSession } from './durable-objects/client-session';
import { runGarbageCollection } from './db/gc';
import { handleHttpRequest } from './http/router';
import type { Env } from './types/env';

export { ClientSession };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleHttpRequest(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
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
  },
};

