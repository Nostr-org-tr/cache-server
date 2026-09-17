import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  APP_VERSION,
  APP_NAME,
  APP_DESCRIPTION,
  APP_REPOSITORY,
  APP_HOMEPAGE,
  APP_CONTACT,
} from '../src/version';
import { buildNip11Document } from '../src/http/nip11';
import { handleHealthRequest, type HealthResponse } from '../src/http/health';
import { handleStatsRequest, type RelayStatsResponse } from '../src/http/stats';
import type { Env } from '../src/types/env';
import { MockD1Database } from './mocks/mock-d1';

const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

describe('Centralized Versioning & Metadata Invariants', () => {
  const pkgJsonPath = resolve(__dirname, '../package.json');
  const pkgLockPath = resolve(__dirname, '../package-lock.json');

  it('validates that APP_VERSION conforms to SemVer 2.0.0 specification', () => {
    expect(APP_VERSION).toBeDefined();
    expect(typeof APP_VERSION).toBe('string');
    expect(SEMVER_REGEX.test(APP_VERSION)).toBe(true);
  });

  it('validates that APP_VERSION matches package.json version exactly', () => {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('validates that APP_VERSION matches package-lock.json version', () => {
    const lock = JSON.parse(readFileSync(pkgLockPath, 'utf-8')) as {
      version?: string;
      packages?: { ''?: { version?: string } };
    };
    const lockVer = lock.version || lock.packages?.['']?.version;
    expect(APP_VERSION).toBe(lockVer);
  });

  it('verifies that metadata constants are properly formed', () => {
    expect(APP_NAME).toBe('cache.nostr.org.tr');
    expect(APP_DESCRIPTION).toContain('Nostr');
    expect(APP_REPOSITORY).toContain('github.com');
    expect(APP_HOMEPAGE).toBe('https://cache.nostr.org.tr');
    expect(APP_CONTACT).toContain('@');
  });

  it('verifies NIP-11 document reflects APP_VERSION and repository URL', () => {
    const mockEnv: Env = {
      DB: new MockD1Database() as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const doc = buildNip11Document(mockEnv);
    expect(doc.version).toBe(APP_VERSION);
    expect(doc.software).toBe(APP_REPOSITORY);
    expect(doc.name).toBe(APP_NAME);
  });

  it('verifies /health endpoint JSON payload includes APP_VERSION', async () => {
    const mockDb = new MockD1Database();
    const env: Env = {
      DB: mockDb as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const response = await handleHealthRequest(env);
    expect(response.status).toBe(200);

    const json = (await response.json()) as HealthResponse;
    expect(json.version).toBe(APP_VERSION);
    expect(json.service).toBe(APP_NAME);
  });

  it('verifies /stats endpoint JSON payload includes APP_VERSION', async () => {
    const mockDb = new MockD1Database();
    const env: Env = {
      DB: mockDb as unknown as D1Database,
      CLIENT_SESSION: {} as unknown as DurableObjectNamespace<any>,
    };

    const response = await handleStatsRequest(env);
    expect(response.status).toBe(200);

    const json = (await response.json()) as RelayStatsResponse;
    expect(json.version).toBe(APP_VERSION);
    expect(json.service).toBe(APP_NAME);
  });
});
