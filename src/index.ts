import { ClientSession } from './durable-objects/client-session';
import { handleHttpRequest } from './http/router';
import type { Env } from './types/env';

export { ClientSession };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleHttpRequest(request, env, ctx);
  },
};
