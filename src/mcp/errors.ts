import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ValidationError, NotFoundError, BusinessError } from '../services/errors.js';

/** Max number of fields named inline in the McpError message before "(+N more)". */
const MAX_FIELDS_IN_MESSAGE = 3;

/** Overall cap on the summarized message length; truncated cleanly if exceeded. */
const MAX_MESSAGE_LENGTH = 300;

/**
 * Flatten a ValidationError's fieldErrors into a single teaching message, e.g.
 * "Validation failed: wsjf.jobSize: <detail>; title: <detail> (+2 more)".
 *
 * Clients that render only `McpError.message` (not `data.fieldErrors`) would
 * otherwise see the useless "Validation failed" with no remediation detail.
 * `data.fieldErrors` remains the full, unabridged structured payload.
 */
function summarizeFieldErrors(fieldErrors: Record<string, string[]>): string {
  const entries = Object.entries(fieldErrors);
  const shown = entries.slice(0, MAX_FIELDS_IN_MESSAGE);
  const remaining = entries.length - shown.length;
  const suffix = remaining > 0 ? ` (+${remaining} more)` : '';
  const prefix = 'Validation failed: ';

  let detail = shown.map(([field, messages]) => `${field}: ${messages.join(', ')}`).join('; ');
  let message = `${prefix}${detail}${suffix}`;

  if (message.length > MAX_MESSAGE_LENGTH) {
    const ellipsis = '...';
    const budget = MAX_MESSAGE_LENGTH - prefix.length - suffix.length - ellipsis.length;
    detail = detail.slice(0, Math.max(0, budget)) + ellipsis;
    message = `${prefix}${detail}${suffix}`;
  }

  return message;
}

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
  // ValidationError: structured field errors, named inline in the message
  if (error instanceof ValidationError) {
    return new McpError(ErrorCode.InvalidParams, summarizeFieldErrors(error.fieldErrors), {
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
