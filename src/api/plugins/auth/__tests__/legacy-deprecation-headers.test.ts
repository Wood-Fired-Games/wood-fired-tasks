import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { Writable } from 'stream';
import Fastify from 'fastify';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { initDatabase } from '../../../../db/database.js';
import { runMigrations } from '../../../../db/migrate.js';
import { seedIdentities } from '../../../../services/identity-seeder.js';
import { parseApiKeyEntries, resetConfig } from '../../../../config/env.js';
import { UserRepository } from '../../../../repositories/user.repository.js';
import { ApiTokenRepository } from '../../../../repositories/api-token.repository.js';
import { generateToken } from '../../../../services/pat-hash.js';
import { LOGGER_REDACT_CONFIG } from '../../../server.js';
import authPlugin from '../../auth.js';

/**
 * Phase 31 Plan 31-05 — Deprecation/Sunset headers + warn log for legacy auth.
 *
 * Verifies the contract of the onSend hook + the legacy-success branch log:
 *   - Legacy-X-API-Key-authed request → response has both
 *     `Deprecation: true` AND `Sunset: <ENV.LEGACY_AUTH_SUNSET_DATE>`,
 *     AND a warn log line with `event: 'legacy_auth_used'` carries
 *     userId / apiKeyLabel / requestId / requestUrl / sunset.
 *   - PAT-authed request → NEITHER header present, NO warn line.
 *   - Anonymous (skipAuth=true) → NEITHER header, NO warn line.
 *   - Failed-auth 401 → NEITHER header, NO warn line.
 *   - Changing the env var between requests is reflected on the next request.
 *
 * Mirror of the harness in src/api/__tests__/auth-chain.test.ts so the
 * expectations live alongside the auth-chain regression net.
 */

interface TestHarness {
  server: FastifyInstance;
  db: Database.Database;
  legacyUserId: number;
  captured: string[];
  drain(): void;
}

async function buildHarness(opts: {
  apiKeys?: string;
  sunsetDate?: string;
}): Promise<TestHarness> {
  process.env.API_KEYS = opts.apiKeys ?? 'test-key';
  if (opts.sunsetDate !== undefined) {
    process.env.LEGACY_AUTH_SUNSET_DATE = opts.sunsetDate;
  } else {
    delete process.env.LEGACY_AUTH_SUNSET_DATE;
  }
  resetConfig();

  const captured: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      captured.push(chunk.toString());
      cb();
    },
  });
  const logger = pino(
    {
      level: 'debug',
      redact: {
        paths: [...LOGGER_REDACT_CONFIG.paths],
        censor: LOGGER_REDACT_CONFIG.censor,
      },
    },
    dest,
  );

  const db = initDatabase(':memory:');
  await runMigrations(db);
  const entries = parseApiKeyEntries(process.env.API_KEYS);
  seedIdentities(db, entries, { info: () => {}, warn: () => {} });
  const userRepo = new UserRepository(db);
  const apiTokenRepo = new ApiTokenRepository(db);

  const legacyUser = userRepo.findLegacyByDisplayName('key_test-key');
  if (legacyUser === null) {
    throw new Error('test setup: legacy user not seeded');
  }

  // Pino's Logger and Fastify's FastifyBaseLogger structurally mismatch.
  const server: FastifyInstance = Fastify({ loggerInstance: logger as never });
  (server as unknown as { decorate: (k: string, v: unknown) => void }).decorate(
    'userRepository',
    userRepo,
  );
  (server as unknown as { decorate: (k: string, v: unknown) => void }).decorate(
    'apiTokenRepository',
    apiTokenRepo,
  );
  await server.register(authPlugin);

  server.route({
    method: 'GET',
    url: '/api/v1/probe',
    handler: async (req) => ({
      authMethod: req.authMethod,
      apiKeyLabel: req.apiKeyLabel ?? null,
    }),
  });

  server.route({
    method: 'GET',
    url: '/api/v1/probe-skip',
    config: { skipAuth: true },
    handler: async () => ({ ok: true }),
  });

  await server.ready();

  return {
    server,
    db,
    legacyUserId: legacyUser.id,
    captured,
    drain: () => {
      captured.length = 0;
    },
  };
}

function mintPatRow(
  db: Database.Database,
  userId: number,
): { token: string; tokenId: number } {
  const { token, prefix, suffix, hash } = generateToken();
  const info = db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, revoked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, '[]', NULL, NULL)`,
    )
    .run(userId, 'test-token', prefix, suffix, hash);
  return { token, tokenId: Number(info.lastInsertRowid) };
}

describe('legacy auth Deprecation/Sunset headers + warn log (Plan 31-05)', () => {
  let harness: TestHarness;
  const savedSunset = process.env.LEGACY_AUTH_SUNSET_DATE;
  const savedApiKeys = process.env.API_KEYS;

  beforeAll(async () => {
    harness = await buildHarness({ sunsetDate: '2026-12-31' });
  });

  afterAll(async () => {
    await harness.server.close();
    harness.db.close();
    if (savedSunset === undefined) {
      delete process.env.LEGACY_AUTH_SUNSET_DATE;
    } else {
      process.env.LEGACY_AUTH_SUNSET_DATE = savedSunset;
    }
    if (savedApiKeys === undefined) {
      delete process.env.API_KEYS;
    } else {
      process.env.API_KEYS = savedApiKeys;
    }
    resetConfig();
  });

  beforeEach(() => {
    harness.drain();
  });

  it('legacy-X-API-Key request → both Deprecation:true and Sunset headers present', async () => {
    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['sunset']).toBe('2026-12-31');
  });

  it('legacy-X-API-Key request → warn log carries legacy_auth_used fields', async () => {
    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    const allLogs = harness.captured.join('');
    // The warn line is emitted as part of the legacy match branch in the
    // chain plugin; assert by event tag rather than by message position.
    expect(allLogs).toMatch(/"event":"legacy_auth_used"/);
    expect(allLogs).toMatch(/"apiKeyLabel":"key_test-key"/);
    expect(allLogs).toMatch(/"sunset":"2026-12-31"/);
    expect(allLogs).toMatch(/"requestUrl":"\/api\/v1\/probe"/);
    expect(allLogs).toMatch(/"userId":\s*\d+/);
    expect(allLogs).toMatch(/"requestId":/);
    // pino warn level numeric (default `level: 'debug'`, pino warn=40).
    expect(allLogs).toMatch(/"level":40[,}].*"event":"legacy_auth_used"/);
  });

  it('PAT-authed request → NEITHER Deprecation nor Sunset header, NO warn line', async () => {
    const { token } = mintPatRow(harness.db, harness.legacyUserId);
    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['deprecation']).toBeUndefined();
    expect(res.headers['sunset']).toBeUndefined();
    const allLogs = harness.captured.join('');
    expect(allLogs).not.toMatch(/"event":"legacy_auth_used"/);
  });

  it('anonymous (skipAuth=true) → NEITHER header, NO warn line', async () => {
    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/probe-skip',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['deprecation']).toBeUndefined();
    expect(res.headers['sunset']).toBeUndefined();
    const allLogs = harness.captured.join('');
    expect(allLogs).not.toMatch(/"event":"legacy_auth_used"/);
  });

  it('401 (failed auth, wrong x-api-key) → NEITHER header, NO warn line', async () => {
    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { 'x-api-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['deprecation']).toBeUndefined();
    expect(res.headers['sunset']).toBeUndefined();
    const allLogs = harness.captured.join('');
    expect(allLogs).not.toMatch(/"event":"legacy_auth_used"/);
  });

  it('401 (failed auth, no credentials) → NEITHER header, NO warn line', async () => {
    const res = await harness.server.inject({
      method: 'GET',
      url: '/api/v1/probe',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['deprecation']).toBeUndefined();
    expect(res.headers['sunset']).toBeUndefined();
    const allLogs = harness.captured.join('');
    expect(allLogs).not.toMatch(/"event":"legacy_auth_used"/);
  });
});

describe('Sunset header reflects env var value (Plan 31-05)', () => {
  // Separate describe so we can build a second harness against a different
  // sunset date — the chain plugin captures `entries` at register time but
  // reads `config.LEGACY_AUTH_SUNSET_DATE` on every onSend; new harness
  // verifies operators can choose their own date.

  let altHarness: TestHarness;
  const savedSunset = process.env.LEGACY_AUTH_SUNSET_DATE;
  const savedApiKeys = process.env.API_KEYS;

  beforeAll(async () => {
    altHarness = await buildHarness({ sunsetDate: '2027-06-30' });
  });

  afterAll(async () => {
    await altHarness.server.close();
    altHarness.db.close();
    if (savedSunset === undefined) {
      delete process.env.LEGACY_AUTH_SUNSET_DATE;
    } else {
      process.env.LEGACY_AUTH_SUNSET_DATE = savedSunset;
    }
    if (savedApiKeys === undefined) {
      delete process.env.API_KEYS;
    } else {
      process.env.API_KEYS = savedApiKeys;
    }
    resetConfig();
  });

  afterEach(() => {
    altHarness.drain();
  });

  it('operator-supplied LEGACY_AUTH_SUNSET_DATE flows into both the header and the warn log', async () => {
    const res = await altHarness.server.inject({
      method: 'GET',
      url: '/api/v1/probe',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['sunset']).toBe('2027-06-30');
    const allLogs = altHarness.captured.join('');
    expect(allLogs).toMatch(/"sunset":"2027-06-30"/);
  });
});
