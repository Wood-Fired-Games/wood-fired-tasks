import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ValidationError, BusinessError, NotFoundError } from '../../services/errors.js';

/**
 * Resolve the HTTP status code this handler will respond with, mirroring the
 * branch logic in {@link errorHandler}. Extracted so the logging decision can
 * be made from the SAME status the client receives, without duplicating the
 * branch order. Project error classes have fixed statuses; statusCode-bearing
 * errors carry their own; everything else is an unhandled 500.
 */
function resolveStatusCode(error: FastifyError | Error): number {
  if (error instanceof ValidationError) return 400;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof BusinessError) return 422;
  if ('statusCode' in error) {
    return (error as FastifyError).statusCode || 400;
  }
  return 500;
}

/**
 * Log the error server-side at a severity matching whether it is an EXPECTED
 * client error or an UNEXPECTED server error.
 *
 * - 5xx / unhandled (statusCode >= 500 or no statusCode): logged at `error`
 *   level WITH the full error object (stack included) so real failures stay
 *   diagnosable. This is unchanged from the original behavior.
 * - 4xx (expected validation / auth / not-found / rate-limit cases): these are
 *   deliberately exercised by the test suite and by normal client misuse in
 *   production; logging each one at `error` with a full stack trace floods
 *   stdout/stderr and makes a healthy run look alarming. They are downgraded:
 *     • under test (NODE_ENV==='test') → `debug`, which sits below the default
 *       `info` log level and is therefore suppressed entirely in a green run.
 *     • otherwise → `warn`, still visible to operators but without the
 *       error-level stack-trace noise.
 *
 * The distinction is computed from the resolved response status (the same one
 * the client receives), never a blanket silence: a 500 — or any error that
 * fails to map to a 4xx — always logs at `error`.
 */
function logErrorByStatus(request: FastifyRequest, error: FastifyError | Error): void {
  const statusCode = resolveStatusCode(error);

  if (statusCode >= 500) {
    // Unexpected server error — keep the full error + stack at error level.
    request.log.error(error);
    return;
  }

  // Expected client (4xx) error. Downgrade to keep healthy runs quiet while
  // preserving an operator-visible breadcrumb outside of tests.
  if (process.env['NODE_ENV'] === 'test') {
    request.log.debug({ err: error, statusCode }, 'expected client error');
  } else {
    request.log.warn(
      { err: error, statusCode, code: (error as FastifyError).code },
      'expected client error',
    );
  }
}

/**
 * Generic, status-appropriate messages used when an error's raw `message` is
 * NOT trusted for verbatim forwarding to the client. These never echo
 * third-party / upstream detail.
 */
const GENERIC_STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Resource not found',
  405: 'Method not allowed',
  406: 'Not acceptable',
  408: 'Request timeout',
  409: 'Conflict',
  413: 'Payload too large',
  414: 'URI too long',
  415: 'Unsupported media type',
  422: 'Unprocessable entity',
  429: 'Too many requests',
};

/**
 * Allowlist of Fastify/framework error code prefixes whose `message` is
 * framework-generated (not third-party/upstream content) and therefore safe to
 * forward verbatim. These describe how the *client's own request* was malformed
 * (validation, body parsing, content-type, payload size) and never carry
 * internal/upstream secrets.
 */
const ALLOWLISTED_CODE_PREFIXES = [
  'FST_ERR_VALIDATION', // Zod / JSON-schema request validation failures
  'FST_ERR_CTP_', // content-type parser errors (e.g. invalid/empty JSON body)
  'FST_ERR_RTE_', // routing errors
];

/**
 * Project-authored error codes whose `message` is intentionally client-facing
 * and safe to forward verbatim. Unlike the FST_ERR_* framework codes above,
 * these are constructed by this codebase (not Fastify), so they are matched
 * exactly rather than by prefix. Keep this set minimal — only codes whose
 * message is guaranteed not to carry internal/upstream detail.
 *   - TOO_MANY_REQUESTS: @fastify/rate-limit errorResponseBuilder in server.ts
 *     emits "Rate limit exceeded, retry in <after>" — a documented, safe
 *     client-facing message (see server.ts errorResponseBuilder contract).
 */
const ALLOWLISTED_EXACT_CODES = new Set<string>(['TOO_MANY_REQUESTS']);

/**
 * Decide whether an error's raw `message` may be surfaced verbatim to the
 * client. Only errors the project explicitly trusts qualify:
 *   - Fastify request-validation errors (carry a `validation` array),
 *   - errors whose Fastify `code` matches a known-safe framework prefix, and
 *   - project-authored error codes whose message is intentionally client-facing
 *     (ALLOWLISTED_EXACT_CODES, e.g. TOO_MANY_REQUESTS).
 * Everything else with a `statusCode` gets a generic status message instead,
 * so third-party / upstream error detail is never leaked.
 *
 * The project's own error classes (ValidationError / BusinessError /
 * NotFoundError) are handled by dedicated branches earlier and do not pass
 * through here.
 */
function isMessageAllowlisted(error: FastifyError): boolean {
  // Fastify attaches a `validation` array to request-schema validation errors.
  if (Array.isArray((error as FastifyError).validation)) {
    return true;
  }

  const code = error.code;
  if (typeof code === 'string' && code.length > 0) {
    if (ALLOWLISTED_EXACT_CODES.has(code)) {
      return true;
    }
    return ALLOWLISTED_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
  }

  return false;
}

/**
 * Custom error handler that maps Phase 1 service errors to structured HTTP responses
 * with machine-readable error codes.
 */
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  // Log server-side for debugging. Unexpected (5xx / unhandled) errors keep the
  // full error + stack at `error` level — the only place the raw message/stack
  // of a non-allowlisted error is exposed. Expected 4xx errors (validation /
  // auth / not-found / rate-limit) are downgraded so a healthy run is not
  // flooded with stack traces. See logErrorByStatus.
  logErrorByStatus(request, error);

  // Map Phase 1 custom errors FIRST (before checking Fastify-specific properties)
  if (error instanceof ValidationError) {
    reply.code(400).send({
      error: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: error.fieldErrors,
    });
    return;
  }

  if (error instanceof NotFoundError) {
    reply.code(404).send({
      error: 'NOT_FOUND',
      message: error.message,
      details: { entity: error.entity, id: error.id },
    });
    return;
  }

  if (error instanceof BusinessError) {
    reply.code(422).send({
      error: 'BUSINESS_RULE_VIOLATION',
      message: error.message,
    });
    return;
  }

  // statusCode-bearing errors (Fastify validation, body parsing, and arbitrary
  // third-party errors that happen to carry a statusCode).
  if ('statusCode' in error) {
    const fastifyError = error as FastifyError;
    const statusCode = fastifyError.statusCode || 400;

    // Only surface the raw message for errors the project explicitly trusts
    // (audit C7). Everything else gets a generic, status-appropriate message so
    // internal/upstream detail is never forwarded verbatim.
    const message = isMessageAllowlisted(fastifyError)
      ? error.message
      : (GENERIC_STATUS_MESSAGES[statusCode] ?? 'An unexpected error occurred');

    reply.code(statusCode).send({
      error: fastifyError.code || 'REQUEST_ERROR',
      message,
    });
    return;
  }

  // Fallback for unexpected errors - do NOT leak stack traces
  reply.code(500).send({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
  });
}
