/**
 * Public entrypoint for the wft-router package.
 *
 * `package.json#main` points here so the package is importable as a library
 * (in addition to its `bin` CLI). This is a thin top-level barrel that
 * re-exports the genuinely public surface from the slice barrels and the
 * top-level modules; it must not be imported BY any leaf module (that would
 * create an import cycle — the arrows only ever point down from this file to
 * the slices, never back up).
 *
 * Vendor-neutrality: this file re-exports only neutral router primitives; no
 * provider, AI, chat, or CI vendor name appears here (see
 * docs/event-router-design.md §Vendor-neutral guardrails).
 */

// Main daemon assembly.
export {
  DEFAULT_HANDLER_REGISTRY,
  WftRouterDaemon,
  mapSSEEvent,
} from './daemon.js';
export type {
  DaemonDeps,
  DaemonLogger,
  DispatchPayload,
  HandlerRegistry,
  MappedEvent,
  SSESourceFactory,
} from './daemon.js';

// Prometheus metrics surface.
export {
  DEFAULT_METRICS_BIND,
  METRIC_NAMES,
  MetricsRegistry,
  startMetricsServer,
} from './metrics.js';
export type {
  DispatchStatus,
  MetricsServerHandle,
  StartMetricsServerOptions,
} from './metrics.js';

// triggers.yaml config schema + loader.
export {
  EX_CONFIG,
  TriggersConfigSchema,
  loadAndValidateTriggers,
  validateTemplating,
} from './config/triggers-schema.js';
export type { TriggersConfig, TriggersRule } from './config/triggers-schema.js';

// Allowed SSE event types.
export { ALLOWED_EVENT_TYPES } from './config/event-types.js';
export type { AllowedEventType } from './config/event-types.js';

// Cross-platform default path resolver.
export { getPaths, resolvePaths } from './paths/index.js';
export type { ResolvePathsInput, RouterPaths } from './paths/index.js';

// Slice barrels (logging / SSE client / dispatch / handlers).
export * from './logging/index.js';
export * from './sse/index.js';
export * from './dispatch/index.js';
export * from './handlers/index.js';
