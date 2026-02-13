import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ValidationError, BusinessError, NotFoundError } from '../../services/errors.js';

/**
 * Custom error handler that maps Phase 1 service errors to structured HTTP responses
 * with machine-readable error codes.
 */
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  // Log the error for debugging
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

  // Handle Fastify validation errors (from Zod schema validation)
  if ('statusCode' in error) {
    reply.code((error as FastifyError).statusCode || 400).send({
      error: (error as FastifyError).code || 'REQUEST_ERROR',
      message: error.message,
    });
    return;
  }

  // Fallback for unexpected errors - do NOT leak stack traces
  reply.code(500).send({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
  });
}
