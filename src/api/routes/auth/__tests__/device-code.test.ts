/**
 * Phase 30 Plan 01 Task 2 — POST /auth/device/code integration tests.
 *
 * The route is a Fastify plugin factory that takes `{ origin, expectedClientId }`
 * so the test harness can mount it inline with a fixed expected client_id
 * without standing up the full server.ts stack.
 *
 * Coverage:
 *   1. Happy path: returns RFC 8628 envelope with all six fields, user_code
 *      matches the locked alphabet, verification_uri_complete embeds the
 *      user_code so the user doesn't have to retype it on the desktop.
 *   2. Missing client_id → 400 invalid_request.
 *   3. Wrong client_id → 400 invalid_client.
 *   4. Optional hostname is honored; absent → null in the underlying session.
 *   5. Empty body → 400 invalid_request.
 *   6. Audit log emits event=device_flow_started with NO secrets.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import deviceCodeRoute from '../device-code.js';
import {
  findByDeviceCode,
  _resetForTests,
} from '../../../../services/device-flow-store.js';

const EXPECTED_CLIENT_ID = 'cli-test-client.example.com';
const ORIGIN = 'http://localhost:3000';

interface LogEntry {
  level: string;
  msg: string;
  event?: string;
  clientId?: string;
  hostname?: string | null;
}

async function buildTestApp(): Promise<{
  app: FastifyInstance;
  logs: LogEntry[];
}> {
  const logs: LogEntry[] = [];
  const app = Fastify({
    logger: {
      level: 'info',
      // Custom write stream so we can inspect the structured log entries
      // emitted by request.log.info (no real stdout chatter).
      stream: {
        write(line: string) {
          try {
            const obj = JSON.parse(line);
            logs.push(obj as LogEntry);
          } catch {
            // Non-JSON line (e.g. fastify startup banner) — ignore.
          }
        },
      },
    },
  });
  await app.register(deviceCodeRoute, {
    origin: ORIGIN,
    expectedClientId: EXPECTED_CLIENT_ID,
  });
  await app.ready();
  return { app, logs };
}

describe('POST /auth/device/code', () => {
  let app: FastifyInstance;
  let logs: LogEntry[];

  beforeEach(async () => {
    _resetForTests();
    ({ app, logs } = await buildTestApp());
  });
  afterEach(async () => {
    await app.close();
  });

  it('happy path: returns RFC 8628 envelope with all six fields', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/code',
      headers: { 'content-type': 'application/json' },
      payload: { client_id: EXPECTED_CLIENT_ID, hostname: 'laptop' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, unknown>;
    expect(body.device_code).toBeTypeOf('string');
    expect(body.user_code).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);
    expect(body.verification_uri).toBe(`${ORIGIN}/auth/device`);
    expect(body.verification_uri_complete).toBe(
      `${ORIGIN}/auth/device?user_code=${body.user_code as string}`,
    );
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
  });

  it('missing client_id → 400 invalid_request', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/code',
      headers: { 'content-type': 'application/json' },
      payload: { hostname: 'laptop' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('client_id mismatch → 400 invalid_client', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/code',
      headers: { 'content-type': 'application/json' },
      payload: { client_id: 'not-the-right-client' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid_client' });
  });

  it('no hostname → session has hostname=null', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/code',
      headers: { 'content-type': 'application/json' },
      payload: { client_id: EXPECTED_CLIENT_ID },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { device_code: string };
    const session = findByDeviceCode(body.device_code);
    expect(session).toBeDefined();
    expect(session?.hostname).toBeNull();
  });

  it('empty body → 400 invalid_request', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/code',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('logger emits event=device_flow_started with clientId + hostname (no secrets)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/code',
      headers: { 'content-type': 'application/json' },
      payload: { client_id: EXPECTED_CLIENT_ID, hostname: 'laptop' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { device_code: string; user_code: string };
    const started = logs.find((l) => l.event === 'device_flow_started');
    expect(started).toBeDefined();
    expect(started?.clientId).toBe(EXPECTED_CLIENT_ID);
    expect(started?.hostname).toBe('laptop');
    // CRITICAL: device_code and user_code MUST NEVER appear in any log line.
    const allLogText = JSON.stringify(logs);
    expect(allLogText).not.toContain(body.device_code);
    expect(allLogText).not.toContain(body.user_code);
  });
});
