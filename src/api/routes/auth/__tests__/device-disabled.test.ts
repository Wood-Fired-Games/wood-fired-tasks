/**
 * Phase 30 Plan 08 Task 1 — /auth/device/* 501 stub + effectiveOrigin.
 *
 * Two clusters in one file:
 *
 *   1. device-disabled-stub plugin
 *      - Registers all four device-flow routes returning 501.
 *      - Body shape:
 *          { error: 'OIDC_DISABLED', message: '...Set OIDC_REDIRECT_URI...' }
 *      - Content-Type: application/json; charset=utf-8.
 *      - All routes carry `config: { skipAuth: true }` (mirrors Phase 29's
 *        disabled-stub.ts pattern; we don't drive auth here, just assert
 *        the stub is reachable on a bare Fastify instance with no auth
 *        chain so the only way it could 501 is by reaching the handler).
 *
 *   2. effectiveOrigin(env) helper
 *      - With OIDC_REDIRECT_URI set → derives origin from new URL().origin.
 *      - Without OIDC_REDIRECT_URI → falls back to http://localhost:PORT.
 *
 * The stub is intentionally parameterless — when OIDC is disabled there is
 * no origin / clientId to inject; the routes always return the same body.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import deviceDisabledStub from '../device-disabled-stub.js';
import { effectiveOrigin } from '../../../../config/env.js';

async function buildStubApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(deviceDisabledStub, { prefix: '/auth' });
  await app.ready();
  return app;
}

describe('device-disabled-stub plugin', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildStubApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('POST /auth/device/code → 501 with OIDC_DISABLED body', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/code',
      headers: { 'content-type': 'application/json' },
      payload: { client_id: 'whatever' },
    });
    expect(r.statusCode).toBe(501);
    expect(r.headers['content-type']).toMatch(/application\/json/i);
    const body = r.json();
    expect(body.error).toBe('OIDC_DISABLED');
    expect(typeof body.message).toBe('string');
    expect(body.message).toMatch(/OIDC_REDIRECT_URI/);
  });

  it('POST /auth/device/token → 501 with OIDC_DISABLED body', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/token',
      headers: { 'content-type': 'application/json' },
      payload: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'whatever',
        client_id: 'whatever',
      },
    });
    expect(r.statusCode).toBe(501);
    expect(r.headers['content-type']).toMatch(/application\/json/i);
    expect(r.json().error).toBe('OIDC_DISABLED');
  });

  it('GET /auth/device → 501 with OIDC_DISABLED body', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/device' });
    expect(r.statusCode).toBe(501);
    expect(r.headers['content-type']).toMatch(/application\/json/i);
    expect(r.json().error).toBe('OIDC_DISABLED');
  });

  it('POST /auth/device/verify → 501 with OIDC_DISABLED body', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/auth/device/verify',
      headers: { 'content-type': 'application/json' },
      payload: { user_code: 'ABCDEFGH', _csrf: 'x' },
    });
    expect(r.statusCode).toBe(501);
    expect(r.headers['content-type']).toMatch(/application\/json/i);
    expect(r.json().error).toBe('OIDC_DISABLED');
  });

  it('all four routes carry the same body shape', async () => {
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/auth/device/code', payload: {} }),
      app.inject({ method: 'POST', url: '/auth/device/token', payload: {} }),
      app.inject({ method: 'GET', url: '/auth/device' }),
      app.inject({
        method: 'POST',
        url: '/auth/device/verify',
        payload: {},
      }),
    ]);
    for (const r of responses) {
      expect(r.statusCode).toBe(501);
      const body = r.json();
      expect(body.error).toBe('OIDC_DISABLED');
      expect(body.message).toMatch(/Set OIDC_REDIRECT_URI/);
    }
  });
});

describe('effectiveOrigin', () => {
  it('derives from OIDC_REDIRECT_URI when present', () => {
    expect(
      effectiveOrigin({
        OIDC_REDIRECT_URI: 'https://wft.local/auth/callback',
        PORT: 3000,
      }),
    ).toBe('https://wft.local');
  });

  it('strips path/query from the redirect URI', () => {
    expect(
      effectiveOrigin({
        OIDC_REDIRECT_URI: 'https://wft.local:8443/some/deep/path?x=1',
        PORT: 3000,
      }),
    ).toBe('https://wft.local:8443');
  });

  it('falls back to http://localhost:PORT when OIDC_REDIRECT_URI absent', () => {
    expect(effectiveOrigin({ PORT: 3001 })).toBe('http://localhost:3001');
  });

  it('falls back to localhost when OIDC_REDIRECT_URI is empty string', () => {
    expect(effectiveOrigin({ OIDC_REDIRECT_URI: '', PORT: 4000 })).toBe(
      'http://localhost:4000',
    );
  });
});
