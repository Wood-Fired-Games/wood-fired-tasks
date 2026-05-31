/**
 * Single source of truth for the wft-router's documented default
 * timings, capacities, and grace periods (task #432).
 *
 * Why a hand-written constants module instead of pulling
 * `.default()` values from the zod schema in `triggers-schema.ts`?
 * Zod's defaults are exposed on the parser, not as plain values —
 * extracting them at runtime requires either reaching into
 * `_def.defaultValue` (which is officially private) or invoking
 * `.parse({})` against every sub-schema and reading the result back.
 * Both options couple the dispatch layer to the parser's
 * implementation, and both pay a per-startup CPU/allocation cost.
 *
 * The duplication is intentional: the zod schema enforces user-input
 * validity ("if the operator overrides this, use that"), while
 * `WFT_ROUTER_DEFAULTS` is the runtime fallback when a rule does not
 * override anything. The two must agree numerically; CI rg-greps the
 * schema and this file together when either changes.
 *
 * Every field cites the design-doc section + line range
 * (`docs/event-router-design.md`) so reviewers can trace the value
 * back to the spec without re-reading the schema.
 */

/**
 * Default timings + capacities for the dispatch pipeline. Each field
 * is the SAME number the zod schema defaults to in
 * `triggers-schema.ts`; the duplication is the documented price for
 * decoupling the dispatch layer from the parser internals.
 */
export const WFT_ROUTER_DEFAULTS = {
  /**
   * Trailing-edge debounce window in ms.
   *
   * Spec §"Debounce" (line 159, line 418-423): the LAST event in a
   * `debounce_ms` window wins; intermediate events merge into a
   * single dispatch with `coalesced_count: N`.
   */
  debounce_ms: 1500,

  /**
   * Idempotency window in seconds. PENDING rows older than this on
   * crash-replay are abandoned (PERMANENTLY_FAILED) rather than
   * re-fired — the upstream event is presumed gone from the SSE
   * server's retention buffer.
   *
   * Spec §"Idempotency" (line 405-414); mirrors the
   * `IdempotencyStore`'s `idempotencyWindowMs` default of
   * 3600 * 1000.
   */
  idempotency_window_s: 3600,

  /**
   * Steady-state cap on dispatches per rule per minute. Token bucket
   * refill rate; bucket capacity (burst) defaults to the same number
   * so a steady-state caller observes exactly N/min, but a burst
   * caller drains the bucket in one tick and then refills smoothly.
   *
   * Spec §"Rate limiting (outbound)" (line 448-454).
   */
  max_dispatches_per_minute: 60,

  /**
   * How many times a transient handler failure may retry before the
   * dispatch transitions to PERMANENTLY_FAILED. Lives here because
   * the retry counter is consulted by the same dispatch loop that
   * owns the rate limiter and debouncer.
   *
   * Spec §"At-least-once dispatch protocol" + §"Resume + cursor" WFT-NEUTRALITY-EXEMPT-LINE
   * (line 383-433): a handler that's down indefinitely transitions
   * its rule's events to PERMANENTLY_FAILED after `max_retries`,
   * unblocking the cursor for that rule. WFT-NEUTRALITY-EXEMPT-LINE
   */
  max_retries: 3,

  /**
   * Graceful-shutdown grace period in seconds. After SIGTERM/SIGINT
   * the daemon stops reading new SSE events, drains in-flight
   * dispatches, and bails out after this many seconds even if some
   * dispatches are still PENDING.
   *
   * Spec §"Graceful shutdown" (line 470-479).
   */
  shutdown_grace_s: 30,

  /**
   * Subprocess grace period in seconds. After the outer
   * `shutdown_grace_s` budget elapses, the daemon SIGTERMs handler
   * subprocesses, waits `subprocess_grace_s` for them to exit, then
   * SIGKILLs the survivors.
   *
   * Spec §"Graceful shutdown" (line 476-477).
   */
  subprocess_grace_s: 5,

  /**
   * Bounded depth of the per-rule rate-limit overflow queue. Surplus
   * events past the bucket capacity are queued up to this depth; the
   * (queue-depth + 1)th event drops with a WARN and increments the
   * `wft_router_rate_limit_dropped_total` counter.
   *
   * Spec §"Rate limiting (outbound)" (line 448-454, specifically
   * "bounded; default 1000 deep").
   *
   * NOTE: the queue is owned by the daemon-loop (task #433), not by
   * the `RateLimiter` primitive — the limiter's `tryAcquire()` is the
   * gate; everything else is the dispatch layer's bookkeeping.
   */
  rate_limit_queue_depth: 1000,
} as const;

/**
 * Convenience type alias so downstream layers can refer to the
 * shape without re-deriving it from `typeof WFT_ROUTER_DEFAULTS`.
 */
export type WftRouterDefaults = typeof WFT_ROUTER_DEFAULTS;
