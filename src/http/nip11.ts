import type { Env } from '../types/env';
import type { Nip11RelayInformation } from '../types/nostr';
import {
  APP_CONTACT,
  APP_DESCRIPTION,
  APP_NAME,
  APP_REPOSITORY,
  APP_VERSION,
} from '../version';
import { createCorsHeaders } from './cors';

/**
 * Builds the canonical NIP-11 Relay Information Document
 */
export function buildNip11Document(env: Env): Nip11RelayInformation {
  return {
    name: env.RELAY_NAME || APP_NAME,
    description: env.RELAY_DESCRIPTION || APP_DESCRIPTION,
    pubkey: env.RELAY_PUBKEY || '',
    contact: env.RELAY_CONTACT || APP_CONTACT,
    supported_nips: [1, 9, 11, 16, 20, 33, 50],
    software: APP_REPOSITORY,
    version: APP_VERSION,
    limitation: {
      max_message_length: 65536,
      max_subscriptions: 20,
      max_filters: 10,
      max_limit: 500,
      max_event_tags: 100,
      max_content_length: 65536,
      auth_required: false,
      payment_required: false,
      restricted_writes: env.ALLOW_DIRECT_WRITES !== 'true',
    },
  };
}

/**
 * Handles NIP-11 Relay Information HTTP requests
 */
export function handleNip11Request(env: Env): Response {
  const doc = buildNip11Document(env);
  const headers = createCorsHeaders({
    'Content-Type': 'application/nostr+json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });

  return new Response(JSON.stringify(doc, null, 2), {
    status: 200,
    headers,
  });
}
