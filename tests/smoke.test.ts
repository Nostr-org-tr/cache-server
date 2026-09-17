import { describe, it, expect } from 'vitest';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import worker from '../src/index';
import type { Env } from '../src/types/env';

import { MockD1Database } from './mocks/mock-d1';

describe('Phase 0 Smoke Tests: Environment & Tooling Verification', () => {
  it('verifies SHA-256 and BIP-340 Schnorr signature operations', () => {
    // Generate a valid secp256k1 private key & public key
    const privKey = secp256k1.utils.randomPrivateKey();
    const pubKeyBytes = schnorr.getPublicKey(privKey);
    const pubKeyHex = bytesToHex(pubKeyBytes);

    expect(pubKeyHex).toHaveLength(64);

    // Create a dummy Nostr event serialization array and compute SHA-256 ID
    const serialized = JSON.stringify([0, pubKeyHex, 1700000000, 1, [], 'Hello Nostr']);
    const eventIdBytes = sha256(new TextEncoder().encode(serialized));
    const eventIdHex = bytesToHex(eventIdBytes);

    expect(eventIdHex).toHaveLength(64);

    // Sign event ID with Schnorr BIP-340
    const sigBytes = schnorr.sign(eventIdHex, privKey);
    const sigHex = bytesToHex(sigBytes);

    expect(sigHex).toHaveLength(128);

    // Verify signature
    const isValid = schnorr.verify(sigHex, eventIdHex, pubKeyHex);
    expect(isValid).toBe(true);

    // Tampered event ID must fail
    const tamperedId = '0'.repeat(64);
    const isTamperedValid = schnorr.verify(sigHex, tamperedId, pubKeyHex);
    expect(isTamperedValid).toBe(false);
  });

  it('serves HTTP GET /health correctly', async () => {
    const mockDb = new MockD1Database();
    const mockEnv = {
      DB: mockDb as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
      RELAY_NAME: 'Test Relay',
    } as Env;

    const request = new Request('https://cache.nostr.org.tr/health', {
      method: 'GET',
    });

    const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { status: string; service: string };
    expect(body.status).toBe('healthy');
    expect(body.service).toBe('cache.nostr.org.tr');
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });

  it('serves NIP-11 relay info document on root GET request', async () => {
    const mockEnv = {
      DB: {} as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
      RELAY_NAME: 'Custom Relay Name',
      RELAY_DESCRIPTION: 'Custom Description',
    } as Env;

    const request = new Request('https://cache.nostr.org.tr/', {
      method: 'GET',
      headers: {
        Accept: 'application/nostr+json',
      },
    });

    const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      name: string;
      description: string;
      supported_nips: number[];
    };
    expect(body.name).toBe('Custom Relay Name');
    expect(body.description).toBe('Custom Description');
    expect(body.supported_nips).toContain(1);
    expect(response.headers.get('Content-Type')).toContain('application/nostr+json');
  });
});
