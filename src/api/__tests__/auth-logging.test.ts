import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Writable } from 'stream';
import Fastify from 'fastify';
import pino from 'pino';
import { LOGGER_REDACT_CONFIG } from '../server.js';
import authPlugin from '../plugins/auth.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { seedIdentities } from '../../services/identity-seeder.js';
import { parseApiKeyEntries } from '../../config/env.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { ApiTokenRepository } from '../../repositories/api-token.repository.js';
import type Database from '../../db/driver.js';

/**
 * Phase 28 (Plan 28-04): the chain auth plugin reads `fastify.userRepository`
 * and `fastify.apiTokenRepository` per request. Both describes below
 * construct a minimal Fastify with the plugin registered directly, so they
 * MUST also seed an identity DB and decorate the same repositories the
 * full-stack `createServer` path decorates. Without this, the legacy
 * strategy's `findLegacyByDisplayName(...)` call would throw and the route
 * would return 500.
 */
async function bootIdentityDb(apiKeys: string): Promise<{
  db: Database.Database;
  userRepository: UserRepository;
  apiTokenRepository: ApiTokenRepository;
}> {
  process.env.API_KEYS = apiKeys;
  const db = initDatabase(':memory:');
  await runMigrations(db);
  seedIdentities(db, parseApiKeyEntries(apiKeys), {
    info: () => {},
    warn: () => {},
  });
  return {
    db,
    userRepository: new UserRepository(db),
    apiTokenRepository: new ApiTokenRepository(db),
  };
}

/**
 * Log redaction (task #182).
 *
 * The Fastify logger MUST redact `x-api-key` (and other secret-bearing
 * headers) in every environment so the supplied key value never appears in
 * captured log output. This test exercises the exact redact config used by
 * `createServer` with a captured pino destination, plus verifies that the
 * auth plugin's warn-on-failure log path does NOT include the supplied key.
 */
describe('X-API-Key log redaction', () => {
  /**
   * Verify pino + LOGGER_REDACT_CONFIG redacts x-api-key in a serialized
   * request object — proving the production config strips the header.
   */
  it('redacts x-api-key under the exported LOGGER_REDACT_CONFIG paths', () => {
    const captured: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      },
    });

    const logger = pino(
      {
        redact: {
          paths: [...LOGGER_REDACT_CONFIG.paths],
          censor: LOGGER_REDACT_CONFIG.censor,
        },
      },
      dest,
    );

    const secretKey = 'caller-supplied-secret-key';
    logger.info({
      req: {
        method: 'GET',
        url: '/api/v1/tasks',
        headers: {
          'x-api-key': secretKey,
          authorization: 'Bearer the-bearer-token',
          cookie: 'session=abc',
          'user-agent': 'test',
        },
      },
    });

    const allLogs = captured.join('');
    expect(allLogs).toContain('[REDACTED]');
    expect(allLogs).not.toContain(secretKey);
    expect(allLogs).not.toContain('the-bearer-token');
    expect(allLogs).not.toContain('session=abc');
    // Non-secret header still flows through.
    expect(allLogs).toContain('test');
  });

  it('also redacts password/secret/apiKey/token under wildcard patterns', () => {
    const captured: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      },
    });

    const logger = pino(
      {
        redact: {
          paths: [...LOGGER_REDACT_CONFIG.paths],
          censor: LOGGER_REDACT_CONFIG.censor,
        },
      },
      dest,
    );

    logger.info({
      user: { password: 'p4ssw0rd', secret: 's3cret', apiKey: 'ak_xyz', token: 'tok_xyz' },
    });

    const allLogs = captured.join('');
    expect(allLogs).not.toContain('p4ssw0rd');
    expect(allLogs).not.toContain('s3cret');
    expect(allLogs).not.toContain('ak_xyz');
    expect(allLogs).not.toContain('tok_xyz');
    expect(allLogs).toContain('[REDACTED]');
  });

  /**
   * Integration: register the auth plugin on a captured-logger Fastify
   * instance and exercise an invalid auth attempt. The warn log emitted by
   * the auth plugin must include the route + ip but NOT the supplied key.
   */
  describe('auth plugin warn-on-failure log', () => {
    // Pino's Logger type and Fastify's FastifyBaseLogger have an upstream
    // structural mismatch (msgPrefix); use a permissive type just for the
    // test harness so the route registration compiles.
    let server: any;
    let db: Database.Database;
    const captured: string[] = [];

    beforeAll(async () => {
      const id = await bootIdentityDb('test-key');
      db = id.db;
      const dest = new Writable({
        write(chunk, _enc, cb) {
          captured.push(chunk.toString());
          cb();
        },
      });
      const logger = pino(
        {
          redact: {
            paths: [...LOGGER_REDACT_CONFIG.paths],
            censor: LOGGER_REDACT_CONFIG.censor,
          },
        },
        dest,
      );
      server = Fastify({ loggerInstance: logger });
      // Phase 28: the chain plugin reads these per request.
      server.decorate('userRepository', id.userRepository);
      server.decorate('apiTokenRepository', id.apiTokenRepository);
      await server.register(authPlugin);
      server.get('/api/v1/tasks', async () => ({ ok: true }));
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
      db.close();
    });

    it('emits a warn log for invalid auth without leaking the supplied key', async () => {
      const attackerKey = 'attacker-attempted-secret-do-not-log-me';
      captured.length = 0;
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { 'x-api-key': attackerKey },
      });
      expect(res.statusCode).toBe(401);

      const allLogs = captured.join('');
      // The legacy X-API-Key strategy was removed (#799). An X-API-Key
      // value is no longer inspected, so a request bearing only an X-API-Key
      // header (no PAT/session) falls through to the catch-all auth.failure
      // line with strategy=legacy reasonCode=missing_credential.
      expect(allLogs).toContain('"tag":"auth.failure"');
      expect(allLogs).toMatch(/"strategy":"legacy"/);
      expect(allLogs).toMatch(/"reasonCode":"missing_credential"/);
      // CRITICAL: the supplied key must never appear in any log line. The
      // auth plugin warn log payload deliberately omits headers; the redact
      // config (verified by the first test in this file) ensures even
      // request-serializer paths censor x-api-key.
      expect(allLogs).not.toContain(attackerKey);
    });

    it('emits a warn log for missing X-API-Key', async () => {
      captured.length = 0;
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
      });
      expect(res.statusCode).toBe(401);

      const allLogs = captured.join('');
      // Phase 28 (Plan 04): catch-all path emits `tag: 'auth.failure'`
      // with `strategy: 'legacy'`, `reasonCode: 'missing_credential'`
      // (Decision Q6 — the catch-all uses the legacy strategy label).
      expect(allLogs).toContain('"tag":"auth.failure"');
      expect(allLogs).toMatch(/"strategy":"legacy"/);
      expect(allLogs).toMatch(/"reasonCode":"missing_credential"/);
    });
  });

  // The "apiKeyLabel request decoration and audit logging" describe block
  // (per-key label derivation, task #189) was removed: it exercised the
  // legacy X-API-Key authentication success path, which was deleted in the
  // v2.0 auth cutover (#799). X-API-Key no longer authenticates, so there is
  // no successful-legacy-auth path on which to attach an apiKeyLabel.

  // The "phase-28 audit fields (user_id, token_id, auth_method)" describe
  // block was removed: it asserted the audit-field shape produced by a
  // SUCCESSFUL legacy X-API-Key auth (auth_method=legacy, token_id=null).
  // The legacy X-API-Key strategy was removed in the v2.0 auth cutover
  // (#799), so there is no longer a legacy-auth success path that re-childs
  // user_id/token_id/auth_method. The audit-field contract for the surviving
  // PAT strategy is covered by auth-chain.test.ts ("audit log re-child
  // fields").
});
