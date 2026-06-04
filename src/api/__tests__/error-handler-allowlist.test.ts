import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { errorHandler } from '../hooks/error-handler.js';
import { ValidationError, BusinessError, NotFoundError } from '../../services/errors.js';

/**
 * Audit C7 regression coverage: the error handler must NOT forward a
 * non-allowlisted third-party error's raw `message` verbatim, while still
 * surfacing messages from errors the project explicitly trusts.
 */

interface CapturedReply {
  statusCode: number;
  body: { error?: string; message?: string; details?: unknown };
}

/**
 * Build a minimal FastifyReply/FastifyRequest pair that captures the response
 * the handler produces, plus the logged error for server-side-logging asserts.
 */
function makeHarness(): {
  request: FastifyRequest;
  reply: FastifyReply;
  captured: CapturedReply;
  loggedErrors: unknown[];
  logCalls: { level: 'error' | 'warn' | 'info' | 'debug'; args: unknown[] }[];
} {
  const captured: CapturedReply = { statusCode: 0, body: {} };
  const loggedErrors: unknown[] = [];
  const logCalls: { level: 'error' | 'warn' | 'info' | 'debug'; args: unknown[] }[] = [];

  const reply = {
    code(status: number) {
      captured.statusCode = status;
      return this;
    },
    send(payload: CapturedReply['body']) {
      captured.body = payload;
      return this;
    },
  } as unknown as FastifyReply;

  const request = {
    log: {
      // Only error-level logs feed `loggedErrors` — that's the channel the
      // audit C7 5xx assertion checks. Expected 4xx errors are now downgraded
      // to debug/warn (see logErrorByStatus in error-handler.ts); those methods
      // must exist on the mock so the handler doesn't throw, but they are not
      // counted as "logged errors" for the C7 leak assertion. `logCalls`
      // records every call (with level) for the noise-downgrade assertions.
      error: (...args: unknown[]) => {
        loggedErrors.push(args[0]);
        logCalls.push({ level: 'error', args });
      },
      warn: (...args: unknown[]) => {
        logCalls.push({ level: 'warn', args });
      },
      info: (...args: unknown[]) => {
        logCalls.push({ level: 'info', args });
      },
      debug: (...args: unknown[]) => {
        logCalls.push({ level: 'debug', args });
      },
    },
  } as unknown as FastifyRequest;

  return { request, reply, captured, loggedErrors, logCalls };
}

describe('errorHandler allowlist (audit C7)', () => {
  it('does NOT leak the raw message of a non-allowlisted statusCode-bearing third-party error', () => {
    const { request, reply, captured, loggedErrors } = makeHarness();

    const upstreamError = Object.assign(new Error('secret upstream detail: db at 10.0.0.5 timed out'), {
      statusCode: 502,
      // No `validation` array and no allowlisted `code` -> NOT trusted.
      code: 'SOME_THIRDPARTY_CODE',
    }) as unknown as FastifyError;

    errorHandler(upstreamError, request, reply);

    // The raw, sensitive message must not appear anywhere in the response.
    expect(JSON.stringify(captured.body)).not.toContain('secret upstream detail');
    expect(JSON.stringify(captured.body)).not.toContain('10.0.0.5');
    expect(captured.body.message).not.toBe('secret upstream detail: db at 10.0.0.5 timed out');

    // 502 isn't in the generic map -> safe fallback message.
    expect(captured.body.message).toBe('An unexpected error occurred');

    // The full error is still logged server-side for debugging.
    expect(loggedErrors).toContain(upstreamError);
  });

  it('substitutes a generic status-appropriate message for a non-allowlisted 409', () => {
    const { request, reply, captured } = makeHarness();

    const conflict = Object.assign(new Error('row id=42 in table secrets violates unique constraint'), {
      statusCode: 409,
      code: 'SQLITE_CONSTRAINT',
    }) as unknown as FastifyError;

    errorHandler(conflict, request, reply);

    expect(captured.statusCode).toBe(409);
    expect(captured.body.message).toBe('Conflict');
    expect(JSON.stringify(captured.body)).not.toContain('secrets');
    expect(JSON.stringify(captured.body)).not.toContain('unique constraint');
  });

  it('surfaces the message of an allowlisted Fastify validation error (has validation array)', () => {
    const { request, reply, captured } = makeHarness();

    const validationError = Object.assign(new Error("body must have required property 'title'"), {
      statusCode: 400,
      code: 'FST_ERR_VALIDATION',
      validation: [{ instancePath: '/title', message: "must have required property 'title'" }],
    }) as unknown as FastifyError;

    errorHandler(validationError, request, reply);

    expect(captured.statusCode).toBe(400);
    expect(captured.body.error).toBe('FST_ERR_VALIDATION');
    expect(captured.body.message).toBe("body must have required property 'title'");
  });

  it('surfaces the message of an allowlisted content-type-parser error (FST_ERR_CTP_ prefix)', () => {
    const { request, reply, captured } = makeHarness();

    const ctpError = Object.assign(new Error('Body cannot be empty when content-type is set to'), {
      statusCode: 400,
      code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
    }) as unknown as FastifyError;

    errorHandler(ctpError, request, reply);

    expect(captured.statusCode).toBe(400);
    expect(captured.body.message).toBe('Body cannot be empty when content-type is set to');
  });

  it('surfaces the message of the project-authored TOO_MANY_REQUESTS 429 (rate-limit contract)', () => {
    const { request, reply, captured } = makeHarness();

    // Mirrors @fastify/rate-limit errorResponseBuilder in server.ts: a
    // project-constructed 429 with a documented, safe client-facing message.
    const rateLimitError = Object.assign(new Error('Rate limit exceeded, retry in 60'), {
      statusCode: 429,
      code: 'TOO_MANY_REQUESTS',
    }) as unknown as FastifyError;

    errorHandler(rateLimitError, request, reply);

    expect(captured.statusCode).toBe(429);
    expect(captured.body.error).toBe('TOO_MANY_REQUESTS');
    expect(captured.body.message).toBe('Rate limit exceeded, retry in 60');
    expect(captured.body.message).toMatch(/Rate limit exceeded/);
  });

  it('still routes the project own error classes through their dedicated branches', () => {
    // ValidationError -> 400 with fixed "Validation failed" message
    {
      const { request, reply, captured } = makeHarness();
      errorHandler(new ValidationError({ title: ['Required'] }), request, reply);
      expect(captured.statusCode).toBe(400);
      expect(captured.body.error).toBe('VALIDATION_ERROR');
      expect(captured.body.message).toBe('Validation failed');
    }

    // NotFoundError -> 404, message surfaced (project-owned, trusted)
    {
      const { request, reply, captured } = makeHarness();
      errorHandler(new NotFoundError('Task', 99999), request, reply);
      expect(captured.statusCode).toBe(404);
      expect(captured.body.error).toBe('NOT_FOUND');
      expect(captured.body.message).toContain('Task');
    }

    // BusinessError -> 422, message surfaced (project-owned, trusted)
    {
      const { request, reply, captured } = makeHarness();
      errorHandler(new BusinessError('Project already exists'), request, reply);
      expect(captured.statusCode).toBe(422);
      expect(captured.body.error).toBe('BUSINESS_RULE_VIOLATION');
      expect(captured.body.message).toBe('Project already exists');
    }
  });

  it('falls back to 500 generic message for an error with no statusCode', () => {
    const { request, reply, captured } = makeHarness();
    errorHandler(new Error('internal boom with stack secrets'), request, reply);
    expect(captured.statusCode).toBe(500);
    expect(captured.body.error).toBe('INTERNAL_ERROR');
    expect(captured.body.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(captured.body)).not.toContain('boom');
  });
});

/**
 * Task #709: expected client (4xx) errors must NOT be logged at `error` level
 * (which floods a healthy test run with stack traces), while unexpected
 * (5xx / unhandled) errors MUST stay at `error` level so real failures remain
 * diagnosable. The handler reads NODE_ENV to pick debug (test) vs warn (else)
 * for the 4xx downgrade.
 */
describe('errorHandler log-level routing (task #709 — expected vs unexpected)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('does NOT log expected 4xx errors at error level (downgraded to debug under test)', () => {
    process.env.NODE_ENV = 'test';
    for (const err of [
      new ValidationError({ title: ['Required'] }),
      new NotFoundError('Task', 99999),
      new BusinessError('Project already exists'),
      Object.assign(new Error('querystring/limit Too big'), {
        statusCode: 400,
        code: 'FST_ERR_VALIDATION',
        validation: [{ instancePath: '/limit', message: 'Too big' }],
      }) as unknown as FastifyError,
      Object.assign(new Error('Rate limit exceeded, retry in 60'), {
        statusCode: 429,
        code: 'TOO_MANY_REQUESTS',
      }) as unknown as FastifyError,
    ]) {
      const { request, reply, loggedErrors, logCalls } = makeHarness();
      errorHandler(err, request, reply);
      // No error-level log for an expected client error...
      expect(loggedErrors).toHaveLength(0);
      expect(logCalls.some((c) => c.level === 'error')).toBe(false);
      // ...but the downgraded breadcrumb is still emitted (at debug under test).
      expect(logCalls.some((c) => c.level === 'debug')).toBe(true);
    }
  });

  it('logs unexpected 5xx / unhandled errors at error level with the full error', () => {
    process.env.NODE_ENV = 'test';

    // No statusCode -> 500 unhandled.
    {
      const { request, reply, loggedErrors, logCalls } = makeHarness();
      const boom = new Error('internal boom');
      errorHandler(boom, request, reply);
      expect(loggedErrors).toContain(boom);
      expect(logCalls.some((c) => c.level === 'error')).toBe(true);
    }

    // statusCode >= 500 third-party error.
    {
      const { request, reply, loggedErrors, logCalls } = makeHarness();
      const upstream = Object.assign(new Error('db at 10.0.0.5 timed out'), {
        statusCode: 502,
        code: 'SOME_THIRDPARTY_CODE',
      }) as unknown as FastifyError;
      errorHandler(upstream, request, reply);
      expect(loggedErrors).toContain(upstream);
      expect(logCalls.some((c) => c.level === 'error')).toBe(true);
    }
  });

  it('downgrades expected 4xx to warn (not error) outside the test env', () => {
    process.env.NODE_ENV = 'production';
    const { request, reply, loggedErrors, logCalls } = makeHarness();
    errorHandler(new NotFoundError('Task', 1), request, reply);
    expect(loggedErrors).toHaveLength(0);
    expect(logCalls.some((c) => c.level === 'error')).toBe(false);
    expect(logCalls.some((c) => c.level === 'warn')).toBe(true);
  });
});
