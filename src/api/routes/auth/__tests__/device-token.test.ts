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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import deviceTokenRoute from '../device-token.js';
import {
  createSession,
  approve,
  deny,
  findByDeviceCode,
  _resetForTests,
  type DeviceFlowSession,
} from '../../../../services/device-flow-store.js';

const EXPECTED_CLIENT_ID = 'cli-test-client.example.com';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyFormbody);
  await app.register(deviceTokenRoute, {
    expectedClientId: EXPECTED_CLIENT_ID,
  });
  await app.ready();
  return app;
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
  let session: DeviceFlowSession;

  beforeEach(async () => {
    _resetForTests();
    app = await buildTestApp();
    session = createSession({ clientId: EXPECTED_CLIENT_ID, hostname: null });
  });
  afterEach(async () => {
    await app.close();
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
    vi.useFakeTimers();
    try {
      // First poll: authorization_pending. Sets lastPollAt = now.
      const r1 = await pollJson(app, {
        grant_type: GRANT_TYPE,
        device_code: session.deviceCode,
        client_id: EXPECTED_CLIENT_ID,
      });
      expect(r1.json()).toMatchObject({ error: 'authorization_pending' });
      const afterFirst = findByDeviceCode(session.deviceCode);
      expect(afterFirst?.interval).toBe(5);

      // Advance 1 second — well inside (5 - 1) = 4 second cooldown window.
      vi.advanceTimersByTime(1000);

      const r2 = await pollJson(app, {
        grant_type: GRANT_TYPE,
        device_code: session.deviceCode,
        client_id: EXPECTED_CLIENT_ID,
      });
      expect(r2.statusCode).toBe(400);
      expect(r2.json()).toMatchObject({ error: 'slow_down' });
      const afterSecond = findByDeviceCode(session.deviceCode);
      expect(afterSecond?.interval).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('7. slow_down is additive: third poll within window bumps 10→15 (not 20)', async () => {
    vi.useFakeTimers();
    try {
      await pollJson(app, {
        grant_type: GRANT_TYPE,
        device_code: session.deviceCode,
        client_id: EXPECTED_CLIENT_ID,
      });
      vi.advanceTimersByTime(1000);
      await pollJson(app, {
        grant_type: GRANT_TYPE,
        device_code: session.deviceCode,
        client_id: EXPECTED_CLIENT_ID,
      });
      // Interval is now 10. Cooldown = (10 - 1) = 9s. Poll again at +1s → slow_down.
      vi.advanceTimersByTime(1000);
      const r3 = await pollJson(app, {
        grant_type: GRANT_TYPE,
        device_code: session.deviceCode,
        client_id: EXPECTED_CLIENT_ID,
      });
      expect(r3.json()).toMatchObject({ error: 'slow_down' });
      const after = findByDeviceCode(session.deviceCode);
      // Additive: 10 + 5 = 15. NOT multiplicative (would be 20).
      expect(after?.interval).toBe(15);
    } finally {
      vi.useRealTimers();
    }
  });

  it('8. approved session still returns authorization_pending (Plan 30-04 wires the mint)', async () => {
    expect(approve(session.userCode, 42)).toBe(true);
    const r = await pollJson(app, {
      grant_type: GRANT_TYPE,
      device_code: session.deviceCode,
      client_id: EXPECTED_CLIENT_ID,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'authorization_pending' });
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
