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
      // Phase 28 (Plan 04): the chain plugin replaces the legacy
      // "Auth failure: invalid X-API-Key" warn-string with the structured
      // `tag: 'auth.failure'` log line emitted by `logAuthFailure()`
      // (src/services/auth-audit.ts). The categorical reasonCode for an
      // unrecognised legacy key is 'unknown_token'.
      expect(allLogs).toContain('"tag":"auth.failure"');
      expect(allLogs).toMatch(/"strategy":"legacy"/);
      expect(allLogs).toMatch(/"reasonCode":"unknown_token"/);
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

  /**
   * Per-key labels (task #189).
   *
   * After successful auth the plugin attaches the matched key's label to
   * `request.apiKeyLabel` so route handlers and request-completion logs can
   * attribute the call. The raw key must NEVER appear in any log line.
   */
  describe('apiKeyLabel request decoration and audit logging', () => {
    // Permissive type — pino logger / Fastify logger structural mismatch.
    let server: any;
    let db: Database.Database;
    const captured: string[] = [];
    const originalApiKeys = process.env.API_KEYS;

    // Use long, distinctive keys so we can search log output for raw-key
    // leakage. 40+ chars satisfies the production length floor too.
    const labelledKeyRaw = 'labelled-key-raw-secret-do-not-log-me-12345';
    const bareKeyRaw = 'bare-key-raw-secret-do-not-log-me-67890123';

    beforeAll(async () => {
      // Phase 28: the chain plugin's legacy strategy looks up the seeded
      // `users` row matching `display_name = label`. Boot a DB with both
      // labels seeded so both keys land on a real principal.
      const id = await bootIdentityDb(
        `${labelledKeyRaw}:ci-bot,${bareKeyRaw}`,
      );
      db = id.db;
      const dest = new Writable({
        write(chunk, _enc, cb) {
          captured.push(chunk.toString());
          cb();
        },
      });
      const logger = pino(
        {
          // Force info-level so the route-handler info log we emit below
          // is captured even if the default level is higher.
          level: 'info',
          redact: {
            paths: [...LOGGER_REDACT_CONFIG.paths],
            censor: LOGGER_REDACT_CONFIG.censor,
          },
        },
        dest,
      );
      server = Fastify({ loggerInstance: logger });
      server.decorate('userRepository', id.userRepository);
      server.decorate('apiTokenRepository', id.apiTokenRepository);
      await server.register(authPlugin);
      // Echo back the apiKeyLabel via a route-handler log line so the test
      // can confirm it propagates into per-request logs. This stand-in
      // mirrors what a real request-completion log would carry.
      server.get('/api/v1/tasks', async (req: any) => {
        req.log.info(
          { apiKeyLabel: req.apiKeyLabel },
          'route reached with apiKeyLabel',
        );
        return { ok: true, label: req.apiKeyLabel };
      });
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
      db.close();
      if (originalApiKeys === undefined) {
        delete process.env.API_KEYS;
      } else {
        process.env.API_KEYS = originalApiKeys;
      }
    });

    it('attaches the labelled key\'s label to request.apiKeyLabel', async () => {
      captured.length = 0;
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { 'x-api-key': labelledKeyRaw },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.label).toBe('ci-bot');
    });

    it('attaches an auto-derived label for a bare key', async () => {
      captured.length = 0;
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { 'x-api-key': bareKeyRaw },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // First 8 chars of bareKeyRaw → "bare-key" (dash is preserved).
      expect(body.label).toBe(`key_${bareKeyRaw.slice(0, 8)}`);
    });

    it('emits the apiKeyLabel in per-request log lines', async () => {
      captured.length = 0;
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { 'x-api-key': labelledKeyRaw },
      });
      expect(res.statusCode).toBe(200);
      const allLogs = captured.join('');
      // The route-handler log MUST carry the label so operators can audit.
      expect(allLogs).toContain('"apiKeyLabel":"ci-bot"');
    });

    it('never logs the raw key value, even on successful auth', async () => {
      captured.length = 0;
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { 'x-api-key': labelledKeyRaw },
      });
      expect(res.statusCode).toBe(200);
      const allLogs = captured.join('');
      // CRITICAL: redaction + plugin discipline must ensure the raw key
      // never reaches the log stream — neither labelled nor bare.
      expect(allLogs).not.toContain(labelledKeyRaw);
      expect(allLogs).not.toContain(bareKeyRaw);
    });

    it('never logs the raw key value on failed auth', async () => {
      captured.length = 0;
      const attempted = 'wrong-key-attempted-by-attacker-aaaaaaaaaa';
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { 'x-api-key': attempted },
      });
      expect(res.statusCode).toBe(401);
      const allLogs = captured.join('');
      expect(allLogs).not.toContain(attempted);
      // And of course the configured raw keys also do not leak on the
      // failure path (defense-in-depth).
      expect(allLogs).not.toContain(labelledKeyRaw);
      expect(allLogs).not.toContain(bareKeyRaw);
    });
  });

  /**
   * Phase 28 (Plan 28-04) — audit fields contract.
   *
   * AUDIT-01 requires every authenticated-request log line to carry
   * `user_id`, `token_id`, `auth_method`. The chain plugin satisfies this
   * by re-childing `request.log` with the audit bindings immediately after
   * a strategy match. Tests below assert the shape of the captured log
   * stream after a legacy auth — `token_id` MUST be `null` (legacy has no
   * api_tokens row), `auth_method` MUST be `'legacy'`, `user_id` MUST be a
   * numeric primary key from the seeded `users` table.
   *
   * ADDITIVE only: this describe block does NOT re-use the captured stream
   * from earlier blocks. It boots its own minimal Fastify with the chain
   * plugin so test ordering / log accumulation cannot mask a missing field.
   */
  describe('phase-28 audit fields (user_id, token_id, auth_method)', () => {
    let server: any;
    let db: Database.Database;
    const captured: string[] = [];
    const originalApiKeys = process.env.API_KEYS;

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
          level: 'info',
          redact: {
            paths: [...LOGGER_REDACT_CONFIG.paths],
            censor: LOGGER_REDACT_CONFIG.censor,
          },
        },
        dest,
      );
      server = Fastify({ loggerInstance: logger });
      server.decorate('userRepository', id.userRepository);
      server.decorate('apiTokenRepository', id.apiTokenRepository);
      await server.register(authPlugin);
      // Emit a route-handler info line so the captured stream sees the
      // re-childed bindings. Fastify's own request-completion log uses the
      // logger captured at request start (BEFORE preHandler ran), so it
      // does NOT carry the chain plugin's child bindings — the explicit
      // emit below is the audit-trail anchor that downstream operators
      // grep for.
      server.get('/api/v1/tasks', async (req: any) => {
        req.log.info({ probe: 'phase-28-audit' }, 'phase-28 audit probe');
        return {
          ok: true,
          user: req.user,
          authMethod: req.authMethod,
          tokenId: req.tokenId,
        };
      });
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
      db.close();
      if (originalApiKeys === undefined) {
        delete process.env.API_KEYS;
      } else {
        process.env.API_KEYS = originalApiKeys;
      }
    });

    it('legacy auth populates request.user, authMethod=legacy, tokenId=null', async () => {
      captured.length = 0;
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { 'x-api-key': 'test-key' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user).not.toBeNull();
      expect(typeof body.user.id).toBe('number');
      expect(body.authMethod).toBe('legacy');
      expect(body.tokenId).toBeNull();
    });

    it('captured log line carries user_id (number), token_id (null), auth_method=legacy', async () => {
      captured.length = 0;
      const res = await server.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        headers: { 'x-api-key': 'test-key' },
      });
      expect(res.statusCode).toBe(200);
      const allLogs = captured.join('');
      // user_id MUST be present and a positive integer (no quotes around
      // the value — `user_id:5` not `user_id:"5"`).
      expect(allLogs).toMatch(/"user_id":\s*\d+/);
      // token_id MUST be the JSON literal `null` for legacy (no api_tokens
      // row backs legacy auth — that's the whole point of MIGR-01 compat).
      expect(allLogs).toMatch(/"token_id":null/);
      // auth_method MUST be the literal string "legacy".
      expect(allLogs).toMatch(/"auth_method":"legacy"/);
    });
  });
});
