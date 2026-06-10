/**
 * Barrel for the wft-router SSE client slice.
 *
 * Consumers in the daemon assembly (task #433) should import from this
 * module rather than reaching into individual files; that keeps the
 * public surface small and lets us refactor internals without churning
 * downstream callers.
 */

export { authHeader, PAT_PREFIX, type AuthHeader } from './auth.js';
export { createSSEParser, type SSEEvent, type SSEParser } from './parser.js';
export {
  runSSEClient,
  computeBackoffMs,
  defaultClock,
  defaultLogger,
  isControlEvent,
  CONTROL_EVENT_NAMES,
  ExitCode,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_UNREACHABLE_LIMIT_MS,
  type SSEClientOptions,
  type SSEClock,
  type SSELogger,
} from './client.js';
