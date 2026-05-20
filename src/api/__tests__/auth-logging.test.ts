import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Writable } from 'stream';
import Fastify from 'fastify';
import pino from 'pino';
import { LOGGER_REDACT_CONFIG } from '../server.js';
import authPlugin from '../plugins/auth.js';

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
    const captured: string[] = [];

    beforeAll(async () => {
      process.env.API_KEYS = 'test-key';
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
      await server.register(authPlugin);
      server.get('/api/v1/tasks', async () => ({ ok: true }));
      await server.ready();
    });

    afterAll(async () => {
      await server.close();
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
      expect(allLogs).toMatch(/Auth failure: invalid X-API-Key/);
      expect(allLogs).toContain('127.0.0.1'); // ip recorded
      expect(allLogs).toContain('/api/v1/tasks'); // route recorded
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
      expect(allLogs).toMatch(/Auth failure: missing X-API-Key/);
    });
  });
});
