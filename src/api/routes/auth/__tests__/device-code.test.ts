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
import deviceCodeRoute, { resolveVerificationOrigin } from '../device-code.js';
import { findByDeviceCode, _resetForTests } from '../../../../services/device-flow-store.js';

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

  it('happy path: returns RFC 8628 envelope; verification_uri uses the request Host (#834)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/code',
      // #834: the client connected over the LAN, not localhost.
      headers: { 'content-type': 'application/json', host: '192.168.69.69:3000' },
      payload: { client_id: EXPECTED_CLIENT_ID, hostname: 'laptop' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, unknown>;
    expect(body.device_code).toBeTypeOf('string');
    expect(body.user_code).toMatch(/^[A-HJ-KM-NP-Z2-9]{8}$/);
    // Built from the address the client reached (Host), NOT the configured
    // localhost ORIGIN — so a remote/LAN client gets a routable URL.
    expect(body.verification_uri).toBe('http://192.168.69.69:3000/auth/device');
    expect(body.verification_uri_complete).toBe(
      `http://192.168.69.69:3000/auth/device?user_code=${body.user_code as string}`,
    );
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
  });

  it('#834: honors X-Forwarded-Host/Proto from a trusted reverse proxy', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/code',
      headers: {
        'content-type': 'application/json',
        host: 'internal-backend:3000',
        'x-forwarded-host': 'tasks.example.com',
        'x-forwarded-proto': 'https',
      },
      payload: { client_id: EXPECTED_CLIENT_ID },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, unknown>;
    // Public host + scheme win over the internal Host.
    expect(body.verification_uri).toBe('https://tasks.example.com/auth/device');
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

  it('no hostname → session.hostname is sanitized to "unknown" (Plan 30-04)', async () => {
    // Plan 30-01 originally stored the raw `null`; Plan 30-04 moves the
    // hostname sanitization into createSession itself so a downstream
    // `tokenName(session.hostname)` call can be safely uncondtional.
    // null/empty are deterministically mapped to 'unknown'.
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
    expect(session?.hostname).toBe('unknown');
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

describe('resolveVerificationOrigin (#834)', () => {
  const FALLBACK = 'http://localhost:3000';

  it('uses the Host header (scheme defaults to the request protocol)', () => {
    expect(
      resolveVerificationOrigin(
        { headers: { host: '192.168.69.69:3000' }, protocol: 'http' },
        FALLBACK,
      ),
    ).toBe('http://192.168.69.69:3000');
  });

  it('prefers X-Forwarded-Host and X-Forwarded-Proto over Host/protocol', () => {
    expect(
      resolveVerificationOrigin(
        {
          headers: {
            host: 'internal:3000',
            'x-forwarded-host': 'tasks.example.com',
            'x-forwarded-proto': 'https',
          },
          protocol: 'http',
        },
        FALLBACK,
      ),
    ).toBe('https://tasks.example.com');
  });

  it('takes the FIRST value of a comma-joined forwarded header', () => {
    expect(
      resolveVerificationOrigin(
        {
          headers: {
            'x-forwarded-host': 'edge.example.com, internal',
            'x-forwarded-proto': 'https, http',
          },
        },
        FALLBACK,
      ),
    ).toBe('https://edge.example.com');
  });

  it('falls back to the configured origin when there is no Host header', () => {
    expect(resolveVerificationOrigin({ headers: {} }, FALLBACK)).toBe(FALLBACK);
  });

  it('defaults the scheme to http when neither forwarded-proto nor protocol is present', () => {
    expect(resolveVerificationOrigin({ headers: { host: 'box.local:3000' } }, FALLBACK)).toBe(
      'http://box.local:3000',
    );
  });

  // Issue #68 (finding 2) — optional operator allowlist.
  describe('trustedHosts allowlist (#68)', () => {
    it('honors a Host whose hostname is on the allowlist (port ignored in match)', () => {
      expect(
        resolveVerificationOrigin(
          { headers: { host: 'tasks.example.com:3000' }, protocol: 'https' },
          FALLBACK,
          ['tasks.example.com'],
        ),
      ).toBe('https://tasks.example.com:3000');
    });

    it('falls back to the configured origin when the Host is NOT on the allowlist', () => {
      expect(
        resolveVerificationOrigin(
          { headers: { host: 'evil.example.com' }, protocol: 'https' },
          FALLBACK,
          ['tasks.example.com'],
        ),
      ).toBe(FALLBACK);
    });

    it('applies the allowlist to X-Forwarded-Host too', () => {
      expect(
        resolveVerificationOrigin(
          {
            headers: { 'x-forwarded-host': 'spoofed.example.com', 'x-forwarded-proto': 'https' },
          },
          FALLBACK,
          ['tasks.example.com'],
        ),
      ).toBe(FALLBACK);
    });

    it('matches case-insensitively', () => {
      expect(
        resolveVerificationOrigin(
          { headers: { host: 'Tasks.Example.COM' }, protocol: 'https' },
          FALLBACK,
          ['tasks.example.com'],
        ),
      ).toBe('https://Tasks.Example.COM');
    });

    it('honors every Host when the allowlist is empty (backward compatible default)', () => {
      expect(
        resolveVerificationOrigin(
          { headers: { host: 'anything.example.com' }, protocol: 'https' },
          FALLBACK,
          [],
        ),
      ).toBe('https://anything.example.com');
    });
  });
});
