/**
 * Barrel for the wft-router dispatch slice. Re-exports the idempotency
 * store + its public types so callers can pull a single specifier; the
 * underlying file paths stay an internal layout detail.
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
