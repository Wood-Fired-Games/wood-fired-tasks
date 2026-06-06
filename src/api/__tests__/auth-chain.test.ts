import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Writable } from 'stream';
import Fastify from 'fastify';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import type Database from '../../db/driver.js';
import { initDatabase } from '../../db/database.js';
import { runMigrations } from '../../db/migrate.js';
import { seedIdentities } from '../../services/identity-seeder.js';
import { parseApiKeyEntries } from '../../config/env.js';
import { UserRepository } from '../../repositories/user.repository.js';
import { ApiTokenRepository } from '../../repositories/api-token.repository.js';
import { generateToken } from '../../services/pat-hash.js';
import { LOGGER_REDACT_CONFIG } from '../server.js';
import authPlugin from '../plugins/auth.js';

/**
 * Phase 28 Plan 04 — auth-chain.test.ts
 *
 * Full-stack strategy-order + audit-log assertions for the three-strategy
 * chain plugin (PAT → session-stub → legacy). Tests use a minimal Fastify
 * instance with the chain plugin registered directly so we can:
 *   - Register probe routes with arbitrary `config: { skipAuth, sessionOnly }`
 *     flags BEFORE plugin registration finishes (Fastify requires this).
 *   - Capture log output via a Writable buffer + pino destination so we can
 *     assert post-auth re-childed log fields (user_id, token_id, auth_method).
 *   - Mint PAT rows inline (generateToken() + raw INSERT) without spinning up
 *     /me/tokens (Plan 5).
 *
 * Pattern mirrors `auth-logging.test.ts:124-128` minimal Fastify; extended to
 * decorate userRepository + apiTokenRepository (the chain reads them).
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
  routes: Array<{
    path: string;
    method?: 'GET' | 'POST';
    config?: { skipAuth?: boolean; sessionOnly?: boolean };
  }>;
}): Promise<TestHarness> {
  process.env.API_KEYS = opts.apiKeys ?? 'test-key';

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

  // The legacy X-API-Key auth strategy (and its key_* user seeding) was
  // removed in the v2.0 auth cutover (#799), so we insert a plain user row
  // directly to own the PAT rows minted by `mintPatRow` below.
  const userInfo = db.prepare(`INSERT INTO users (display_name) VALUES (?)`).run('pat-test-user');
  const ownerUserId = Number(userInfo.lastInsertRowid);
  const legacyUser = { id: ownerUserId };

  // Pino's Logger type and Fastify's FastifyBaseLogger have a structural
  // mismatch; use `any` for the loggerInstance assignment.
  const server: any = Fastify({ loggerInstance: logger as any });
  server.decorate('userRepository', userRepo);
  server.decorate('apiTokenRepository', apiTokenRepo);
  await server.register(authPlugin);

  for (const r of opts.routes) {
    server.route({
      method: r.method ?? 'GET',
      url: r.path,
      config: r.config ?? {},
      handler: async (req: any) => {
        // Emit a log line through the (possibly re-childed) per-request
        // logger so the captured stream sees the audit fields
        // (user_id, token_id, auth_method, apiKeyLabel). Fastify's own
        // "request completed" line uses the logger captured at request
        // start (BEFORE the auth preHandler ran), so it doesn't carry the
        // child bindings — the explicit emit below is what tests assert on.
        req.log.info({ probe: true }, 'probe route reached');
        return {
          user: req.user,
          authMethod: req.authMethod,
          tokenId: req.tokenId,
          apiKeyLabel: req.apiKeyLabel ?? null,
        };
      },
    });
  }

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
  opts: {
    userId: number;
    name?: string;
    revoked?: boolean;
    expiresAt?: string | null;
  },
): { token: string; tokenId: number } {
  const { token, prefix, suffix, hash } = generateToken();
  const info = db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, prefix, suffix, hash, scopes, revoked_at, expires_at)
       VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
    )
    .run(
      opts.userId,
      opts.name ?? 'test-token',
      prefix,
      suffix,
      hash,
      opts.revoked ? "datetime('now')" : null,
      opts.expiresAt ?? null,
    );
  // Use UPDATE for revoked_at because parameterised datetime('now') needs to
  // run server-side, not bind as a literal.
  if (opts.revoked) {
    db.prepare("UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ?").run(
      Number(info.lastInsertRowid),
    );
  }
  return { token, tokenId: Number(info.lastInsertRowid) };
}

describe('Auth chain plugin — strategy order + audit log + route opt-outs', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await buildHarness({
      routes: [
        { path: '/api/v1/probe' },
        { path: '/api/v1/probe-skip', config: { skipAuth: true } },
        { path: '/api/v1/probe-session-only', config: { sessionOnly: true } },
      ],
    });
  });

  afterAll(async () => {
    await harness.server.close();
    harness.db.close();
  });

  beforeEach(() => {
    harness.drain();
  });

  describe('strategy order — first match wins', () => {
    it('PAT wins when both Authorization Bearer PAT and x-api-key are present', async () => {
      const { token, tokenId } = mintPatRow(harness.db, {
        userId: harness.legacyUserId,
      });
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe',
        headers: {
          authorization: `Bearer ${token}`,
          'x-api-key': 'test-key',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.authMethod).toBe('pat');
      expect(body.tokenId).toBe(tokenId);
      expect(body.user).not.toBeNull();
      expect(body.user.id).toBe(harness.legacyUserId);
      // apiKeyLabel is NOT set on PAT path
      expect(body.apiKeyLabel).toBeNull();
    });

    it('PAT with unknown token short-circuits 401 — does NOT fall through to legacy', async () => {
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe',
        headers: {
          // valid PAT shape, but never inserted into api_tokens
          authorization: 'Bearer wft_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        },
      });
      expect(res.statusCode).toBe(401);
      const allLogs = harness.captured.join('');
      expect(allLogs).toMatch(/"strategy":"pat"/);
      expect(allLogs).toMatch(/"reasonCode":"unknown_token"/);
    });

    it('revoked PAT → 401 with reasonCode revoked', async () => {
      const { token } = mintPatRow(harness.db, {
        userId: harness.legacyUserId,
        revoked: true,
      });
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      const allLogs = harness.captured.join('');
      expect(allLogs).toMatch(/"strategy":"pat"/);
      expect(allLogs).toMatch(/"reasonCode":"revoked"/);
    });

    it('malformed PAT body (wrong charset/length) → 401 with reasonCode wrong_prefix', async () => {
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe',
        headers: { authorization: 'Bearer wft_pat_short' },
      });
      expect(res.statusCode).toBe(401);
      const allLogs = harness.captured.join('');
      expect(allLogs).toMatch(/"strategy":"pat"/);
      expect(allLogs).toMatch(/"reasonCode":"wrong_prefix"/);
    });

    it('x-api-key (no Authorization) → 401 (legacy strategy removed in v2.0 cutover)', async () => {
      // The legacy X-API-Key auth strategy was removed (#799). A request
      // bearing only an X-API-Key header (no PAT/session) now falls through
      // to the catch-all 401 with strategy=legacy reasonCode=missing_credential.
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe',
        headers: { 'x-api-key': 'test-key' },
      });
      expect(res.statusCode).toBe(401);
      const allLogs = harness.captured.join('');
      expect(allLogs).toMatch(/"strategy":"legacy"/);
      expect(allLogs).toMatch(/"reasonCode":"missing_credential"/);
    });

    it('wrong x-api-key (no Authorization) → 401 with catch-all log strategy=legacy reasonCode=missing_credential', async () => {
      // With the legacy strategy removed, an X-API-Key value is never
      // inspected — the request simply has no PAT/session credential and
      // falls through to the catch-all missing_credential 401.
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe',
        headers: { 'x-api-key': 'wrong-key' },
      });
      expect(res.statusCode).toBe(401);
      const allLogs = harness.captured.join('');
      expect(allLogs).toMatch(/"strategy":"legacy"/);
      expect(allLogs).toMatch(/"reasonCode":"missing_credential"/);
    });

    it('no credentials at all → 401 with catch-all strategy=legacy reasonCode=missing_credential', async () => {
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe',
      });
      expect(res.statusCode).toBe(401);
      const allLogs = harness.captured.join('');
      expect(allLogs).toMatch(/"strategy":"legacy"/);
      expect(allLogs).toMatch(/"reasonCode":"missing_credential"/);
    });
  });

  describe('audit log re-child fields', () => {
    it('after PAT match, request log carries user_id, token_id, auth_method=pat', async () => {
      const { token, tokenId } = mintPatRow(harness.db, {
        userId: harness.legacyUserId,
      });
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const allLogs = harness.captured.join('');
      // request-completion log emitted by Fastify carries the re-childed
      // bindings.
      expect(allLogs).toMatch(/"user_id":\s*\d+/);
      expect(allLogs).toContain(`"token_id":${tokenId}`);
      expect(allLogs).toMatch(/"auth_method":"pat"/);
    });

    it('x-api-key (no Authorization) → 401 catch-all audit line strategy=legacy reasonCode=missing_credential', async () => {
      // The legacy success path (re-childing user_id/token_id/auth_method=legacy)
      // was removed with the legacy X-API-Key strategy (#799). The remaining
      // observable is the catch-all auth.failure audit line.
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe',
        headers: { 'x-api-key': 'test-key' },
      });
      expect(res.statusCode).toBe(401);
      const allLogs = harness.captured.join('');
      expect(allLogs).toMatch(/"strategy":"legacy"/);
      expect(allLogs).toMatch(/"reasonCode":"missing_credential"/);
    });
  });

  describe('route config flags', () => {
    it('skipAuth=true route returns 200 with no headers; request.user stays null', async () => {
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe-skip',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user).toBeNull();
      expect(body.authMethod).toBeNull();
      expect(body.tokenId).toBeNull();
    });

    it('sessionOnly=true + x-api-key (no Authorization) → 401 (legacy strategy removed; auth fails before sessionOnly check)', async () => {
      // Previously the legacy strategy authenticated the X-API-Key and the
      // sessionOnly post-auth check returned 403. With the legacy strategy
      // removed (#799), the X-API-Key never authenticates, so the request
      // fails auth (401) before the sessionOnly check can run.
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe-session-only',
        headers: { 'x-api-key': 'test-key' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('sessionOnly=true + valid PAT → 403 session_required', async () => {
      const { token } = mintPatRow(harness.db, {
        userId: harness.legacyUserId,
      });
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe-session-only',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('session_required');
    });

    it('sessionOnly=true + no credentials → 401 (auth runs first, sessionOnly check is post-auth)', async () => {
      const res = await harness.server.inject({
        method: 'GET',
        url: '/api/v1/probe-session-only',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('WR-01: strategy DB errors → 500 INTERNAL_ERROR + auth.error log + auth.failure audit', () => {
    // A throwing `apiTokenRepository.findByHash` (e.g. DB locked, connection
    // lost, prepared-statement compile error from a runtime migration) must
    // surface as a categorical 500 with:
    //   - an `auth.error` log line carrying the underlying err object for
    //     postmortem,
    //   - an `auth.failure` audit line (strategy=legacy,
    //     reasonCode=unknown_token) so aggregators watching the audit feed
    //     stay aware of the outage,
    //   - and a response body of `{ error: 'INTERNAL_ERROR' }` — NOT 401
    //     (we should not pretend auth failed when it errored) and with no
    //     token-shaped data.
    //
    // We need a separate harness with a throwing apiTokenRepository because
    // `buildHarness` uses the real repository against an in-memory SQLite.
    let throwHarness: TestHarness;

    beforeAll(async () => {
      // Reuse the buildHarness machinery but then swap the repository
      // decoration with a throwing stub. The chain plugin reads the
      // decoration at register time, so swap BEFORE register.
      // Easier path: build a fresh harness that wires the throwing repo
      // directly (avoid double-register).
      process.env.API_KEYS = 'test-key';

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

      // Build a throwing api-token repo that mimics the real interface
      // surface used by the PAT strategy + chain plugin.
      const throwingApiTokenRepo = {
        findByHash() {
          throw new Error('database is locked');
        },
        touchLastUsed() {
          /* no-op */
        },
        // Methods exercised by the routes module — unused here but kept so
        // the structural shape matches.
        insert() {
          throw new Error('not implemented in throw-harness');
        },
        listByUser() {
          return [];
        },
        revoke() {
          return false;
        },
      };

      const server: any = Fastify({ loggerInstance: logger as any });
      server.decorate('userRepository', userRepo);
      server.decorate('apiTokenRepository', throwingApiTokenRepo);
      await server.register(authPlugin);

      server.route({
        method: 'GET',
        url: '/api/v1/throw-probe',
        config: {},
        handler: async () => ({ ok: true }),
      });

      await server.ready();

      throwHarness = {
        server,
        db,
        legacyUserId: 0,
        captured,
        drain: () => {
          captured.length = 0;
        },
      };
    });

    afterAll(async () => {
      await throwHarness.server.close();
      throwHarness.db.close();
    });

    beforeEach(() => {
      throwHarness.drain();
    });

    it('throwing findByHash on a valid-shape Bearer PAT → 500 INTERNAL_ERROR', async () => {
      const res = await throwHarness.server.inject({
        method: 'GET',
        url: '/api/v1/throw-probe',
        headers: {
          authorization: 'Bearer wft_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        },
      });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ error: 'INTERNAL_ERROR' });
      // Body MUST NOT leak the offending token bytes or stack.
      expect(res.body).not.toContain('wft_pat_');
      expect(res.body).not.toContain('database is locked');
    });

    it('emits an auth.error log carrying err + requestId, AND an auth.failure audit line', async () => {
      const res = await throwHarness.server.inject({
        method: 'GET',
        url: '/api/v1/throw-probe',
        headers: {
          authorization: 'Bearer wft_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
        },
      });
      expect(res.statusCode).toBe(500);
      const allLogs = throwHarness.captured.join('');
      // auth.error structured log carries the underlying err object.
      expect(allLogs).toMatch(/"msg":"auth\.error"/);
      expect(allLogs).toMatch(/"message":"database is locked"/);
      // auth.failure audit line — categorical reasonCode reused from the
      // existing enum (not widened).
      expect(allLogs).toMatch(/"tag":"auth\.failure"/);
      expect(allLogs).toMatch(/"strategy":"legacy"/);
      expect(allLogs).toMatch(/"reasonCode":"unknown_token"/);
    });
  });

  describe('full-stack regression — /health scope split preserved', () => {
    // The full createServer path is tested in auth.test.ts (legacy) and the
    // /health scope-split is exercised by rate-limit.test.ts +
    // health-detailed.test.ts. We re-assert the basic behaviour here so a
    // regression in the new chain plugin surfaces in this file's history.
    let fullServer: FastifyInstance;
    let fullDb: Database.Database;

    beforeAll(async () => {
      process.env.API_KEYS = 'test-key';
      const { createServer } = await import('../server.js');
      const result = await createServer({ dbPath: ':memory:' });
      fullServer = result.server;
      fullDb = result.app.db;
    });

    afterAll(async () => {
      await fullServer.close();
      fullDb.close();
    });

    it('GET /health with no auth → 200 (scope split survives)', async () => {
      const res = await fullServer.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    });

    it('GET /api/v1/tasks with no auth → 401', async () => {
      const res = await fullServer.inject({
        method: 'GET',
        url: '/api/v1/tasks',
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
