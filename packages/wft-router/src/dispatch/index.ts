/**
 * Barrel for the wft-router dispatch slice. Re-exports the
 * idempotency store, predicate evaluator, template renderer, and the
 * three dispatch primitives (rate limiter, debouncer, graceful
 * shutdown) so callers can pull a single specifier; the underlying
 * file paths stay an internal layout detail.
 */

export { IdempotencyStore, IdempotencyStoreCorruptError } from './idempotency-store.js';
export type {
  ClaimResult,
  DispatchStatus,
  IdempotencyStoreOptions,
  PendingRow,
} from './idempotency-store.js';

export { evaluateWhere } from './predicate.js';
export type { EventPayloadShape } from './predicate.js';

export { renderWith, TemplatingError } from './template.js';
export type { RenderOptions, TemplateLogger } from './template.js';

export { WFT_ROUTER_DEFAULTS } from './defaults.js';
export type { WftRouterDefaults } from './defaults.js';

export { RateLimiter } from './rate-limit.js';
export type { RateLimitOptions } from './rate-limit.js';

export { Debouncer } from './debounce.js';
export type { DebouncedResult, DebounceOptions } from './debounce.js';

export { GracefulShutdown } from './graceful-shutdown.js';
export type { ShutdownOptions, ShutdownProc, ShutdownResult } from './graceful-shutdown.js';
