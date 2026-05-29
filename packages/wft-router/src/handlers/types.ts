/**
 * Shared handler contract for the wft-router action handlers (task #428).
 *
 * This file is authored by the FIRST handler task (#428,
 * create_task_in_project) and is REUSED VERBATIM by the sibling handler
 * tasks (#429 webhook_post, #430 shell_exec). It is the single source of
 * truth for:
 *
 *   - {@link HandlerOutcome} — the discriminated result a handler reports
 *     after exactly ONE attempt.
 *   - {@link HandlerContext} — the dependency-injected inputs every handler
 *     receives (idempotency store, logger, event identity, secondary key,
 *     rendered payload, target/auth, and the `fetchImpl` test seam).
 *   - {@link Handler} — the callable shape itself.
 *
 * Design rationale (docs/event-router-design.md §"At-least-once dispatch
 * protocol" + §"Idempotency"):
 *
 *   A handler performs ONE attempt per call and reports an outcome. It does
 *   NOT own the retry/backoff loop — that belongs to the daemon dispatcher
 *   (task #433). Concretely:
 *
 *     - 2xx                       → store.complete(..., 'SUCCEEDED'),
 *                                   return { kind: 'succeeded' }.
 *     - 4xx                       → terminal; store.complete(...,
 *                                   'PERMANENTLY_FAILED'), return
 *                                   { kind: 'failed', retryable: false }.
 *     - 5xx / network / timeout   → retryable; store.complete(..., 'FAILED'),
 *                                   return { kind: 'failed', retryable: true }.
 *     - claim() not CLAIMED       → return { kind: 'suppressed' } WITHOUT
 *                                   performing the side-effect. This is the
 *                                   "idempotent replay" guarantee.
 *
 * Standalone-package isolation: this module imports ONLY types from within
 * `packages/wft-router/src/` (the dispatch barrel). No root-`src/` reach-in.
 *
 * Vendor-neutrality: no AI provider, chat platform, or CI vendor name appears
 * in this file (docs/event-router-design.md §Vendor-neutral guardrails).
 */

import type { spawn as nodeSpawn } from 'node:child_process';

import type {
  EventPayloadShape,
  IdempotencyStore,
} from '../dispatch/index.js';

/**
 * Injectable shape of `child_process.spawn`. The `shell_exec` handler (#430)
 * defaults this to the real `node:child_process` `spawn` and lets unit tests
 * pin a fake. Aliased to the builtin's own signature so the seam stays exact.
 */
export type SpawnImpl = typeof nodeSpawn;

/**
 * Minimal logger surface a handler needs. Structurally compatible with a
 * pino child logger (`createRuleLogger`) and with the in-memory recorders
 * the tests inject. Redaction is the caller's responsibility BEFORE values
 * reach this surface (handler delivery is verbatim; only LOG surfaces are
 * redacted — see util/redaction.ts).
 */
export interface HandlerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/**
 * Outcome of a single handler attempt. The daemon dispatcher (#433) reads
 * this to decide whether to re-enqueue (only when `retryable: true`).
 *
 *   - `succeeded`  — the side-effect committed; the idempotency row is now
 *     SUCCEEDED.
 *   - `suppressed` — no side-effect was performed because the dispatch was
 *     already claimed (PENDING) or already terminal (DONE). The `reason`
 *     distinguishes the two so callers can log at the right level.
 *   - `failed`     — the side-effect was attempted and did not succeed.
 *     `retryable` is `false` for terminal 4xx failures and `true` for 5xx /
 *     network / timeout failures. `detail` is a short, already-safe-to-log
 *     summary (never the verbatim payload).
 */
export type HandlerOutcome =
  | { kind: 'succeeded' }
  | { kind: 'suppressed'; reason: 'already_pending' | 'already_done' }
  | { kind: 'failed'; retryable: boolean; detail: string };

/**
 * Identity + secondary-key fields a handler needs to drive the idempotency
 * store. `rule_name` + `event_id` form the primary key; the
 * `task_id`/`to_status`/`emitted_at_ms` triple is the defense-in-depth
 * secondary key the store records on claim (see
 * IdempotencyStore.claim). All three secondary fields are nullable because
 * not every event carries them.
 */
export interface DispatchIdentity {
  rule_name: string;
  event_id: string;
  task_id: number | null;
  to_status: string | null;
  emitted_at_ms: number | null;
}

/**
 * Everything a handler is handed for a single attempt. Mirrors the
 * dependency-injection style of `src/sse/client.ts`: every external surface
 * is injectable so unit tests can pin it.
 *
 * The handler receives the RAW `with:` block plus the `event`, and renders
 * the block itself via `renderWith` — this keeps the rendered values out of
 * the context object until the moment they are needed and lets the handler
 * apply handler-specific render options. A pre-rendered block MAY be passed
 * via `renderedWith` to bypass rendering (used by crash-replay, where the
 * rendered JSON was persisted at claim time).
 */
export interface HandlerContext {
  /** The PENDING→terminal idempotency protocol owner. */
  store: IdempotencyStore;
  /** Structured logger; redaction is baked in for pino children. */
  logger: HandlerLogger;
  /** The live SSE event payload the `with:` block is rendered against. */
  event: EventPayloadShape;
  /** Primary + secondary idempotency keys for this dispatch. */
  identity: DispatchIdentity;
  /**
   * The rule's raw `with:` block (pre-render). Rendered via `renderWith` by
   * the handler. Mutually exclusive with `renderedWith`.
   */
  withBlock?: Record<string, unknown>;
  /**
   * A pre-rendered `with:` block (post-render). When present the handler
   * skips rendering and uses this directly — the crash-replay path.
   */
  renderedWith?: Record<string, unknown>;
  /** API base URL, e.g. `https://tasks.example.com` (no trailing slash required). */
  apiBaseUrl: string;
  /** Auth token; `wft_pat_...` → Bearer, otherwise → X-API-Key. */
  authToken: string;
  /** Per-attempt timeout in ms for the HTTP call. Optional; handler picks a default. */
  timeoutMs?: number;
  /** Test seam — defaults to `globalThis.fetch` inside the handler. */
  fetchImpl?: typeof fetch;
  /**
   * OPTIONAL test seam for the `shell_exec` handler (#430) — defaults to the
   * real `node:child_process` `spawn`. The HTTP handlers (#428/#429) ignore
   * it. Additive field; never required, never read by existing handlers.
   */
  spawnImpl?: SpawnImpl;
  /**
   * OPTIONAL name of the parent-process env var holding a credential the rule
   * wants forwarded into the child (the rule's `token_env`). Read by
   * `shell_exec` (#430) ONLY; the HTTP handlers ignore it. When set, the
   * handler copies `process.env[tokenEnv]` (if present) into the child env
   * allowlist. Additive field; never required.
   */
  tokenEnv?: string;
}

/**
 * The callable handler shape. One attempt, one outcome. Async because the
 * side-effect is an HTTP round-trip. Implementations MUST NOT mutate the
 * context or its `withBlock`/`event` inputs.
 */
export type Handler = (ctx: HandlerContext) => Promise<HandlerOutcome>;
