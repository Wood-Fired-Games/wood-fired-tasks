/**
 * Barrel for the wft-router handlers slice (task #428).
 *
 * Re-exports the shared handler contract (`types.ts`), the shared HTTP
 * transport (`http-client.ts`), and the v1 core handlers so callers can pull
 * a single specifier; the underlying file layout stays an internal detail.
 *
 * The sibling handler tasks (#429 webhook_post, #430 shell_exec) add their
 * own re-exports here as they land. This barrel mirrors the style of
 * `src/dispatch/index.ts`.
 */

export type {
  DispatchIdentity,
  Handler,
  HandlerContext,
  HandlerLogger,
  HandlerOutcome,
} from './types.js';

export {
  DEFAULT_HTTP_TIMEOUT_MS,
  httpRequest,
  HttpNetworkError,
  HttpTimeoutError,
} from './http-client.js';
export type { HttpRequestOptions, HttpResponse } from './http-client.js';

export { createTaskInProject } from './create-task-in-project.js';
