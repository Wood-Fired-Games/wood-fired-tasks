/**
 * Phase 30 Plan 01 Task 3 — POST /auth/device/token integration tests.
 *
 * Drives the full RFC 8628 §3.5 error matrix:
 *   - unsupported_grant_type
 *   - invalid_client
 *   - expired_token (unknown device_code AND past expiresAt)
 *   - slow_down (additive +5 to interval, per §3.5 — NOT multiplicative)
 *   - authorization_pending
 *   - access_denied
 *
 * Plus the content-type handshake: both application/json AND
 * application/x-www-form-urlencoded bodies must be accepted (RFC 8628 §3.4
 * leaves the choice to the server; the openid-client v6 CLI helpers send
 * form-encoded by default).
 *
 * Approved sessions intentionally return `authorization_pending` in this
 * plan — Plan 30-04 wires the actual PAT mint at the approved → token
 * boundary. Test 8 locks that contract so Plan 30-04 has a failing test
 * to flip green.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import deviceTokenRoute from '../device-token.js';
import {
  createSession,
  approve,
  deny,
  findByDeviceCode,
  recordMintedToken,
  _resetForTests,
  type DeviceFlowSession,
} from '../../../../services/device-flow-store.js';
import { initDatabase } from '../../../../db/database.js';
import { runMigrations } from '../../../../db/migrate.js';
import { seedIdentities } from '../../../../services/identity-seeder.js';
import { parseApiKeyEntries } from '../../../../config/env.js';
import { UserRepository } from '../../../../repositories/user.repository.js';
import type Database from 'better-sqlite3';

const EXPECTED_CLIENT_ID = 'cli-test-client.example.com';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

interface BuildResult {
  app: FastifyInstance;
  db: Database.Database;
  legacyUserId: number;
}

async function buildTestApp(): Promise<BuildResult> {
  process.env.API_KEYS = 'device-token-test-key:device-token-key';
  const db = initDatabase(':memory:');
  await runMigrations(db);
  const apiKeyEntries = parseApiKeyEntries(process.env.API_KEYS);
  seedIdentities(db, apiKeyEntries, { info: () => {}, warn: () => {} });
  const userRepo = new UserRepository(db);
  const legacyUser = userRepo.findLegacyByDisplayName('device-token-key');
  if (!legacyUser) throw new Error('test setup: legacy user not seeded');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app: any = Fastify({ logger: false });
  app.decorate('userRepository', userRepo);
  await app.register(fastifyFormbody);
  await app.register(deviceTokenRoute, {
    expectedClientId: EXPECTED_CLIENT_ID,
  });
  await app.ready();
  return { app, db, legacyUserId: legacyUser.id };
}

function pollJson(
  app: FastifyInstance,
  body: Record<string, string>,
): ReturnType<FastifyInstance['inject']> {
  return app.inject({
    method: 'POST',
    url: '/auth/device/token',
    headers: { 'content-type': 'application/json' },
    payload: body,
  });
}

describe('POST /auth/device/token', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let legacyUserId: number;
  let session: DeviceFlowSession;

  beforeEach(async () => {
    _resetForTests();
    ({ app, db, legacyUserId } = await buildTestApp());
    session = createSession({ clientId: EXPECTED_CLIENT_ID, hostname: null });
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('1. unsupported_grant_type: wrong grant_type → 400', async () => {
    const r = await pollJson(app, {
      grant_type: 'password',
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'unsupported_grant_type' });
  });

  it('2. invalid_client: wrong client_id → 400', async () => {
    const r = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: 'wrong-client',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('3. expired_token: unknown device_code → 400', async () => {
    const r = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: 'not-a-real-code',
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'expired_token' });
  });

  it('4. expired_token: known device_code with expiresAt in the past → 400', async () => {
    const ref = findByDeviceCode(session.deviceCode);
    expect(ref).toBeDefined();
    if (ref) ref.expiresAt = Date.now() - 1;
    const r = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'expired_token' });
  });

  it('5. authorization_pending: fresh first poll → 400 and lastPollAt updated', async () => {
    const before = session.lastPollAt;
    const r = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'authorization_pending' });
    const after = findByDeviceCode(session.deviceCode);
    expect(after?.lastPollAt).toBeGreaterThan(before);
  });

  it('6. slow_down: second poll within (interval-1)s → 400 and interval bumped 5→10', async () => {
    // Mutate lastPollAt directly instead of vi.useFakeTimers — the latter
    // interferes with fastify.inject's promise scheduling and deadlocks
    // the afterEach app.close(). The route reads Date.now() vs lastPollAt,
    // so seeding lastPollAt to "1 second ago" is equivalent to "polled 1s ago".
    const r1 = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r1.json()).toMatchObject({ error: 'authorization_pending' });
    const afterFirst = findByDeviceCode(session.deviceCode);
    expect(afterFirst?.interval).toBe(5);
    // Pull lastPollAt back to (now - 1000) so the next poll lands inside
    // the (5 - 1) = 4s cooldown window.
    if (afterFirst) afterFirst.lastPollAt = Date.now() - 1000;

    const r2 = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r2.statusCode).toBe(400);
    expect(r2.json()).toMatchObject({ error: 'slow_down' });
    const afterSecond = findByDeviceCode(session.deviceCode);
    expect(afterSecond?.interval).toBe(10);
  });

  it('7b. (WR-04) slow_down interval is capped at 60s under spam', async () => {
    // Force the session.interval to a value that would jump past the
    // cap on the next +5. The handler must clamp to 60 instead of 65.
    const ref = findByDeviceCode(session.deviceCode);
    if (!ref) throw new Error('test setup: session vanished');
    ref.interval = 58;
    ref.lastPollAt = Date.now() - 1000; // inside (58-1)*1000ms window

    const r = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r.json()).toMatchObject({ error: 'slow_down' });
    const after = findByDeviceCode(session.deviceCode);
    // 58 + 5 = 63, clamped to 60. Confirms the Math.min cap fires.
    expect(after?.interval).toBe(60);

    // Subsequent slow_down hits stay pinned at 60.
    if (after) after.lastPollAt = Date.now() - 1000;
    const r2 = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r2.json()).toMatchObject({ error: 'slow_down' });
    expect(findByDeviceCode(session.deviceCode)?.interval).toBe(60);
  });

  it('7. slow_down is additive: third poll within window bumps 10→15 (not 20)', async () => {
    // First poll: authorization_pending, lastPollAt now.
    await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    const ref1 = findByDeviceCode(session.deviceCode);
    if (ref1) ref1.lastPollAt = Date.now() - 1000;

    // Second poll: slow_down, interval 5→10.
    await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    const ref2 = findByDeviceCode(session.deviceCode);
    expect(ref2?.interval).toBe(10);
    // Pull lastPollAt back again so the next poll is inside (10-1)=9s window.
    if (ref2) ref2.lastPollAt = Date.now() - 1000;

    const r3 = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r3.json()).toMatchObject({ error: 'slow_down' });
    const after = findByDeviceCode(session.deviceCode);
    // Additive: 10 + 5 = 15. NOT multiplicative (would be 20).
    expect(after?.interval).toBe(15);
  });

  it('8a. (Plan 30-04) approved but unminted → still authorization_pending', async () => {
    // Narrow window: verify handler called approve() but the
    // recordMintedToken step has not run yet (e.g. DB outage path).
    // The CLI must continue polling rather than receiving a half-built
    // response.
    expect(approve(session.userCode, legacyUserId)).toBe(true);
    const r = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'authorization_pending' });
  });

  it('8b. (Plan 30-04) approved AND minted → 200 success envelope; replay → expired_token', async () => {
    expect(approve(session.userCode, legacyUserId)).toBe(true);
    expect(
      recordMintedToken(session.userCode, {
        tokenId: 999,
        token: 'wft_pat_MINTED1234567890ABCDEFGHIJKLMNOP',
      }),
    ).toBe(true);

    const r = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      token: string;
      token_type: string;
      token_id: number;
      user: {
        id: number;
        displayName: string;
        email: string | null;
        isLegacy: boolean;
        isServiceAccount: boolean;
      };
    };
    expect(body.token).toBe('wft_pat_MINTED1234567890ABCDEFGHIJKLMNOP');
    expect(body.token_type).toBe('PAT');
    expect(body.token_id).toBe(999);
    expect(body.user.id).toBe(legacyUserId);
    expect(body.user.displayName).toBe('device-token-key');
    expect(body.user.isLegacy).toBe(true);

    // Replay rejected — session was removed after the 200.
    const r2 = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r2.statusCode).toBe(400);
    expect(r2.json()).toMatchObject({ error: 'expired_token' });
  });

  it('9. denied session → access_denied', async () => {
    expect(deny(session.userCode)).toBe(true);
    const r = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'access_denied' });
  });

  it('10. form-encoded body: application/x-www-form-urlencoded works', async () => {
    const formBody = new URLSearchParams({
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    }).toString();
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'authorization_pending' });
  });

  it('11. JSON body works equivalently', async () => {
    const r = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'authorization_pending' });
  });

  it('12. missing required field → 400 invalid_request', async () => {
    const r = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      // client_id missing
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid_request' });
  });
});
