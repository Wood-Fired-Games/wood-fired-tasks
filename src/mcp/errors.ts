import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ValidationError, NotFoundError, BusinessError } from '../services/errors.js';

/**
 * Convert Phase 1 custom errors to MCP-compatible McpError
 *
 * Maps domain errors to appropriate MCP error codes:
 * - ValidationError -> InvalidParams (with field details)
 * - NotFoundError -> InvalidRequest (with entity context)
 * - BusinessError -> InvalidRequest (with message)
 * - Unknown errors -> InternalError (sanitized, logged)
 */
export function convertToMcpError(error: unknown): McpError {
  // ValidationError: structured field errors
  if (error instanceof ValidationError) {
    return new McpError(ErrorCode.InvalidParams, 'Validation failed', {
      fieldErrors: error.fieldErrors,
    });
  }

  // NotFoundError: entity not found
  if (error instanceof NotFoundError) {
    return new McpError(ErrorCode.InvalidRequest, error.message, {
      entity: error.entity,
      id: error.id,
    });
  }

  // BusinessError: business logic violation
  if (error instanceof BusinessError) {
    return new McpError(ErrorCode.InvalidRequest, error.message);
  }

  // Unknown errors: log full details, return sanitized error
  console.error('Unexpected error in MCP handler:', error);
  return new McpError(ErrorCode.InternalError, 'An internal error occurred');
}
