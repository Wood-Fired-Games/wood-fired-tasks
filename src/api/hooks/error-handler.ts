import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ValidationError, BusinessError, NotFoundError } from '../../services/errors.js';

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
  reply: FastifyReply
): void {
  // Log the FULL error server-side for debugging. This is the only place the
  // raw message/stack of a non-allowlisted error is ever exposed.
  request.log.error(error);

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
      : GENERIC_STATUS_MESSAGES[statusCode] ?? 'An unexpected error occurred';

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
