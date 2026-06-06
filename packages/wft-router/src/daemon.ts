/**
 * wft-router main daemon — the integration seam (task #433).
 *
 * This module composes every prior slice of the package into one running
 * subscriber:
 *
 *   SSE generator → parse → predicate → debounce → rate-limit
 *                 → Promise.allSettled fan-out → handler dispatch
 *
 * It is modelled structurally on the in-repo notifier subscriber template
 * ("subscribe to the bus, look up matching rules, fan out to handlers via
 * Promise.allSettled"): the constructor wires injected deps, `start()`
 * begins consuming the SSE async-generator in a background loop, dispatch
 * runs all rules that matched one event under a SINGLE `Promise.allSettled`
 * (so one rule's rejection cannot abort its siblings), and `stop()` aborts
 * the generator and drains in-flight work via `GracefulShutdown`.
 *
 * Dependency-injection is mandatory for testability — exactly like
 * `sse/client.ts` and the handlers. Every external surface is injectable:
 *   - the SSE source factory (`runSSEClient`-shaped) + its options
 *     (including the `fetchImpl` test seam),
 *   - the `IdempotencyStore` (a `:memory:` store in tests),
 *   - the handler registry (recording fakes in tests; the real four
 *     handlers in production),
 *   - the rate limiter, debouncer, logger, and clock.
 *
 * What this module OWNS:
 *   - Mapping a raw {@link SSEEvent} to the predicate's
 *     {@link EventPayloadShape} plus the {@link DispatchIdentity} a handler
 *     needs (rule_name / event_id / task_id / to_status / emitted_at_ms).
 *   - The per-event pipeline: type-match → predicate → debounce →
 *     rate-limit gate → build context → dispatch.
 *   - The `Promise.allSettled` fan-out across every rule that matched one
 *     event, giving per-rule error isolation.
 *   - Lifecycle (`start`/`stop`), graceful drain, idempotent stop.
 *
 * What this module does NOT own (handlers own it): `store.claim(...)` /
 * `store.complete(...)`. The daemon builds the context + identity and
 * invokes the handler; the handler performs ONE attempt and reports a
 * {@link HandlerOutcome}.
 *
 * DEFERRED (see task report + docs/event-router-design.md §"Operational
 * properties"): the full at-least-once retry/backoff loop on
 * `retryable` outcomes, per-rule cursor persistence, crash reconciliation
 * (`store.replayPending()` re-fire on boot), and the bounded rate-limit
 * overflow queue. The seam is present (a `retryable` failure is logged and
 * counted; the last-event-id cursor is tracked in memory) but the durable
 * state machine is intentionally left for follow-on tasks rather than
 * half-built silently.
 *
 * Standalone-package isolation: imports ONLY from within
 * `packages/wft-router/src/` + `node:` builtins.
 *
 * Vendor-neutrality: no AI provider, chat platform, or CI vendor name
 * appears in this file (see docs/event-router-design.md §Vendor-neutral
 * guardrails).
 */

import type { TriggersConfig, TriggersRule } from './config/triggers-schema.js';
import {
  Debouncer,
  GracefulShutdown,
  RateLimiter,
  WFT_ROUTER_DEFAULTS,
  evaluateWhere,
  type EventPayloadShape,
  type IdempotencyStore,
} from './dispatch/index.js';
import {
  agentSessionDispatch,
  createTaskInProject,
  shellExec,
  webhookPost,
  type DispatchIdentity,
  type Handler,
  type HandlerContext,
  type HandlerLogger,
  type HandlerOutcome,
} from './handlers/index.js';
import type { MetricsRegistry } from './metrics.js';
import { ExitCode, type SSEEvent } from './sse/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The handler `do:` name → callable mapping. The daemon dispatches a rule by
 * looking its `do:` value up in this registry. Production uses
 * {@link DEFAULT_HANDLER_REGISTRY} (the four real handlers); tests inject a
 * registry of recording fakes to assert invocation order.
 */
export type HandlerRegistry = Record<TriggersRule['do'], Handler>;

/**
 * An SSE source: anything shaped like `runSSEClient` — a function returning
 * an async-generator that yields {@link SSEEvent} and returns an
 * {@link ExitCode}. The daemon never imports `runSSEClient` directly through
 * this seam so tests can hand it a fake generator they fully control.
 */
export type SSESourceFactory = (signal: AbortSignal) => AsyncGenerator<SSEEvent, ExitCode>;

/** Minimal structured-logger surface the daemon needs (pino-compatible). */
export interface DaemonLogger extends HandlerLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** Injected dependencies for the daemon. Every external surface is here. */
export interface DaemonDeps {
  /** Validated triggers config (rules + defaults). */
  config: TriggersConfig;
  /** Idempotency store — handlers own claim/complete; the daemon just threads it. */
  store: IdempotencyStore;
  /** SSE source factory; given an AbortSignal, yields events. */
  sseSource: SSESourceFactory;
  /** Handler registry mapping `rule.do` → handler fn. */
  handlers: HandlerRegistry;
  /** Structured logger. */
  logger: DaemonLogger;
  /** API base URL handlers POST against (the daemon `--endpoint`). */
  apiBaseUrl: string;
  /** Fallback auth token when a rule does not name a `with.token_env`. */
  apiKey: string;
  /** Optional per-rule rate limiter. Default: a fresh {@link RateLimiter}. */
  rateLimiter?: RateLimiter;
  /** Optional debouncer. Default: a fresh {@link Debouncer}. */
  debouncer?: Debouncer<DispatchPayload>;
  /** Optional graceful-shutdown coordinator. Default: a fresh {@link GracefulShutdown}. */
  shutdown?: GracefulShutdown;
  /** Test seam threaded to handlers' HTTP calls. */
  fetchImpl?: typeof fetch;
  /** Test seam threaded to the `shell_exec` / `agent_session_dispatch` handlers. */
  spawnImpl?: HandlerContext['spawnImpl'];
  /** Optional adapters-path override threaded to `agent_session_dispatch`. */
  adaptersPath?: readonly string[];
  /** Process env lookup seam (for `token_env` resolution). Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected clock for debounce/rate-limit math in tests. Default: Date.now. */
  now?: () => number;
  /**
   * Optional Prometheus metrics registry. ADDITIVE (task #434): when present,
   * the daemon increments it at the pipeline points it already tracks (events
   * received, rules matched, dispatches by handler+status, handler errors,
   * permanently-failed, rate-limit drops). Absent in existing tests, which
   * keep passing unchanged. The bin entry only constructs one when
   * `--metrics-port` is given.
   */
  metrics?: MetricsRegistry;
}

/**
 * Payload carried through the debouncer for one matched (rule, event) pair.
 * The trailing-edge "last wins" payload is exactly what the handler needs.
 */
export interface DispatchPayload {
  rule: TriggersRule;
  event: EventPayloadShape;
  identity: DispatchIdentity;
}

/**
 * The default production handler registry: the four real handlers keyed by
 * their `do:` name. Tests override this with recording fakes.
 */
export const DEFAULT_HANDLER_REGISTRY: HandlerRegistry = {
  create_task_in_project: createTaskInProject,
  webhook_post: webhookPost,
  shell_exec: shellExec,
  agent_session_dispatch: agentSessionDispatch,
};

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

/**
 * Raw wire shape of the JSON carried in an SSE event's `data:` field. Mirrors
 * the server's `EventPayload<Task & { tags }>` (src/events/types.ts) without
 * importing it (standalone-package isolation). All fields optional — a
 * malformed event must degrade gracefully, not throw.
 */
interface WireEventPayload {
  eventType?: string;
  timestamp?: string;
  data?: {
    id?: number;
    project_id?: number;
    project_slug?: string;
    status?: string;
    tags?: readonly string[];
    parent_task_id?: number | null;
    assignee?: string | null;
  };
  metadata?: {
    from?: string;
    to?: string;
    source?: 'user' | 'workflow';
  };
}

/** The result of mapping an {@link SSEEvent} into pipeline inputs. */
export interface MappedEvent {
  /** The predicate-facing payload shape. */
  payload: EventPayloadShape;
  /** The SSE event id (drives the idempotency primary key). */
  eventId: string;
  /** Emitted-at epoch ms (parsed from the wire `timestamp`), or null. */
  emittedAtMs: number | null;
}

/**
 * Map a raw {@link SSEEvent} to the predicate {@link EventPayloadShape} plus
 * the identity-bearing fields the handler context needs. Returns `null` when
 * the event cannot be parsed (bad JSON / no usable type) — the caller skips
 * such events with a WARN rather than crashing the loop.
 *
 * Type resolution precedence: the SSE `event:` name field, falling back to
 * the JSON body's `eventType`. The `id:` field is the idempotency event id;
 * a synthetic id is NOT fabricated — an event with no id is skipped (the
 * idempotency store keys on a stable id).
 */
export function mapSSEEvent(ev: SSEEvent): MappedEvent | null {
  let parsed: WireEventPayload;
  try {
    parsed = JSON.parse(ev.data) as WireEventPayload;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }

  const type = ev.event ?? parsed.eventType;
  if (typeof type !== 'string' || type.length === 0) {
    return null;
  }
  if (ev.id === undefined || ev.id.length === 0) {
    return null;
  }

  const payload: EventPayloadShape = { type };
  if (parsed.data !== undefined && parsed.data !== null) {
    payload.task = {
      id: parsed.data.id,
      project_id: parsed.data.project_id,
      project_slug: parsed.data.project_slug,
      status: parsed.data.status,
      tags: parsed.data.tags,
      parent_task_id: parsed.data.parent_task_id,
      assignee: parsed.data.assignee,
    };
  }
  if (parsed.metadata !== undefined && parsed.metadata !== null) {
    payload.metadata = {
      from: parsed.metadata.from,
      to: parsed.metadata.to,
      source: parsed.metadata.source,
    };
  }

  let emittedAtMs: number | null = null;
  if (typeof parsed.timestamp === 'string') {
    const t = Date.parse(parsed.timestamp);
    emittedAtMs = Number.isNaN(t) ? null : t;
  }

  return { payload, eventId: ev.id, emittedAtMs };
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

/** Phase of the daemon lifecycle. */
type DaemonPhase = 'idle' | 'running' | 'stopping' | 'stopped';

/**
 * The composed wft-router daemon. Lifecycle mirrors the notifier subscriber
 * template: `start()` kicks off the SSE consume loop (does NOT block the
 * caller forever); `stop()` aborts the generator, drains in-flight
 * dispatches via {@link GracefulShutdown}, and is safe to call more than
 * once.
 */
export class WftRouterDaemon {
  private readonly config: TriggersConfig;
  private readonly store: IdempotencyStore;
  private readonly sseSource: SSESourceFactory;
  private readonly handlers: HandlerRegistry;
  private readonly logger: DaemonLogger;
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly rateLimiter: RateLimiter;
  private readonly debouncer: Debouncer<DispatchPayload>;
  private readonly shutdown: GracefulShutdown;
  private readonly fetchImpl?: typeof fetch;
  private readonly spawnImpl?: HandlerContext['spawnImpl'];
  private readonly adaptersPath?: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  /** Optional metrics registry (task #434); incremented only when injected. */
  private readonly metrics?: MetricsRegistry;

  private phase: DaemonPhase = 'idle';
  private readonly abortController = new AbortController();
  /** The background consume loop; awaited by `stop()` so drain is ordered. */
  private consumeLoop: Promise<ExitCode> | null = null;
  /** Every in-flight dispatch fan-out; drained on stop. */
  private readonly inFlight: Set<Promise<void>> = new Set();
  /** Last non-empty SSE event id seen — the in-memory cursor seam. */
  private lastEventId: string | undefined;
  /** Count of rate-limited events dropped (the bounded-queue is deferred). */
  private rateLimitedDropped = 0;
  /** Resolved exit code once the consume loop finishes. */
  private exitCode: ExitCode = ExitCode.CleanShutdown;

  constructor(deps: DaemonDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.sseSource = deps.sseSource;
    this.handlers = deps.handlers;
    this.logger = deps.logger;
    this.apiBaseUrl = deps.apiBaseUrl;
    this.apiKey = deps.apiKey;
    this.fetchImpl = deps.fetchImpl;
    this.spawnImpl = deps.spawnImpl;
    this.adaptersPath = deps.adaptersPath;
    this.env = deps.env ?? process.env;
    this.metrics = deps.metrics;

    const now = deps.now ?? Date.now;
    this.rateLimiter =
      deps.rateLimiter ??
      new RateLimiter({
        tokensPerMinute:
          this.config.defaults?.max_dispatches_per_minute ??
          WFT_ROUTER_DEFAULTS.max_dispatches_per_minute,
        now,
      });
    this.debouncer =
      deps.debouncer ??
      new Debouncer<DispatchPayload>({
        windowMs: this.config.defaults?.debounce_ms ?? WFT_ROUTER_DEFAULTS.debounce_ms,
        now,
      });
    this.shutdown = deps.shutdown ?? new GracefulShutdown();
  }

  /**
   * Begin consuming the SSE generator in a background loop. Returns
   * immediately (the loop runs detached) — mirror of the notifier template's
   * `start()`, which kicks off the subscription without blocking the caller.
   * Calling `start()` more than once is a no-op after the first.
   */
  start(): void {
    if (this.phase !== 'idle') {
      return;
    }
    this.phase = 'running';

    // Register a drain callback so a SIGTERM/SIGINT routed through the
    // shared GracefulShutdown coordinator triggers `stop()` here too.
    this.shutdown.onDrain(async () => {
      await this.stop();
    });

    this.consumeLoop = this.runConsumeLoop();
  }

  /**
   * Abort the SSE generator, then drain all in-flight dispatch fan-outs and
   * any pending debounced buckets. Idempotent — a second call returns the
   * same settled state and never re-aborts. Mirrors the notifier template's
   * `stop()` (unsubscribe + drain).
   */
  async stop(): Promise<void> {
    if (this.phase === 'idle') {
      this.phase = 'stopped';
      return;
    }
    if (this.phase === 'stopping' || this.phase === 'stopped') {
      // Already stopping/stopped — await the loop if it exists so callers
      // racing stop() all observe a drained daemon.
      if (this.consumeLoop !== null) {
        await this.consumeLoop.catch(() => undefined);
      }
      return;
    }

    this.phase = 'stopping';
    // 1. Stop reading new SSE events immediately.
    this.abortController.abort();
    // 2. Flush debounced buckets so their trailing-edge dispatch fires now
    //    rather than waiting the full window on the way down.
    await this.debouncer.flushAll();
    // 3. Wait for the consume loop to exit.
    if (this.consumeLoop !== null) {
      this.exitCode = await this.consumeLoop.catch(() => ExitCode.CleanShutdown);
    }
    // 4. Drain in-flight dispatch fan-outs (per-rule isolation already
    //    applied inside each via Promise.allSettled).
    await Promise.allSettled(Array.from(this.inFlight));

    this.phase = 'stopped';
    this.logger.info(
      { rate_limited_dropped: this.rateLimitedDropped, exit_code: this.exitCode },
      'wft_router_stopped',
    );
  }

  /** The resolved exit code (valid once `stop()` has returned). */
  getExitCode(): ExitCode {
    return this.exitCode;
  }

  /**
   * Await the background consume loop's natural completion (e.g. the SSE
   * source returned a fatal exit code on its own). Resolves with the exit
   * code. Used by the bin entry path to keep the process alive until the
   * stream ends or a signal forces `stop()`.
   */
  async wait(): Promise<ExitCode> {
    if (this.consumeLoop === null) {
      return this.exitCode;
    }
    this.exitCode = await this.consumeLoop.catch(() => this.exitCode);
    return this.exitCode;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The background loop: iterate the SSE async-generator, route each event
   * through the pipeline. The generator's return value is the daemon exit
   * code. Any throw is logged and treated as a clean shutdown so a single
   * bad event never leaks an unhandled rejection.
   */
  private async runConsumeLoop(): Promise<ExitCode> {
    const gen = this.sseSource(this.abortController.signal);
    try {
      for (;;) {
        const next = await gen.next();
        if (next.done === true) {
          return next.value;
        }
        this.onEvent(next.value);
      }
    } catch (err) {
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'wft_router_consume_loop_error',
      );
      return ExitCode.CleanShutdown;
    }
  }

  /**
   * Route ONE raw SSE event through the pipeline:
   *   parse → for each rule: type-match → predicate → debounce → rate-limit
   *   → collect → Promise.allSettled fan-out → handler dispatch.
   *
   * The fan-out across all rules that matched this one event runs under a
   * SINGLE `Promise.allSettled` so a rejection in one rule's handler can
   * never abort its siblings (per-rule error isolation, exactly like the
   * notifier subscriber template).
   */
  private onEvent(ev: SSEEvent): void {
    this.metrics?.incEventsReceived();

    if (ev.id !== undefined && ev.id.length > 0) {
      this.lastEventId = ev.id; // in-memory cursor seam (durable persist deferred)
    }

    const mapped = mapSSEEvent(ev);
    if (mapped === null) {
      this.logger.warn({ event_id: ev.id, event_name: ev.event }, 'wft_router_event_unmappable');
      return;
    }

    // Stage 1+2: which rules match this event (type + predicate)?
    const matched = this.config.rules.filter(
      (rule) => rule.on === mapped.payload.type && evaluateWhere(rule.where, mapped.payload),
    );
    if (matched.length === 0) {
      return;
    }
    this.metrics?.incMatchedRules(matched.length);

    // For each matched rule, run stage 3 (debounce) and stage 4 (rate-limit),
    // then collect the dispatch promises. We launch ALL of them and join them
    // under one Promise.allSettled so per-rule errors are isolated.
    const dispatches: Array<Promise<void>> = [];
    for (const rule of matched) {
      dispatches.push(this.dispatchRule(rule, mapped));
    }

    // Single allSettled fan-out across every matched rule for this event.
    const fanOut = (async (): Promise<void> => {
      await Promise.allSettled(dispatches);
    })();
    this.track(fanOut);
  }

  /**
   * Stage 3 + 4 + 5 for a single rule: debounce on (rule.name, task_id),
   * then on the trailing edge apply the rate-limit gate and dispatch the
   * matching handler. Resolves when this rule's dispatch (if any) settles —
   * a rejection here is caught so the outer `Promise.allSettled` always
   * settles cleanly.
   */
  private async dispatchRule(rule: TriggersRule, mapped: MappedEvent): Promise<void> {
    const taskId = mapped.payload.task?.id;
    const eventKey = taskId !== undefined ? String(taskId) : mapped.eventId;

    const identity: DispatchIdentity = {
      rule_name: rule.name,
      event_id: mapped.eventId,
      task_id: taskId ?? null,
      to_status: mapped.payload.metadata?.to ?? null,
      emitted_at_ms: mapped.emittedAtMs,
    };

    const payload: DispatchPayload = { rule, event: mapped.payload, identity };

    // Stage 3: debounce. The trailing-edge "last wins" payload is what we
    // dispatch. Per-rule debounce_ms override is honoured by keying a
    // dedicated bucket window — but the Debouncer is constructed with the
    // defaults window; per-rule override is applied below if present.
    const windowMs = rule.debounce_ms;
    const result =
      windowMs !== undefined && windowMs === 0
        ? { payload, coalesced_count: 1 }
        : await this.debouncer.push(rule.name, eventKey, payload);

    // The debounced bucket resolves with the LAST event's payload — use it.
    const winner = result.payload;
    const coalesced = result.coalesced_count;

    // Stage 4: rate-limit gate.
    if (!this.rateLimiter.tryAcquire(rule.name)) {
      // Bounded overflow queue is DEFERRED — drop with a WARN + counter.
      this.rateLimitedDropped += 1;
      this.metrics?.incRateLimitDropped(rule.name);
      this.logger.warn(
        {
          rule_name: rule.name,
          event_id: winner.identity.event_id,
          dropped_total: this.rateLimitedDropped,
        },
        'wft_router_rate_limited_dropped',
      );
      return;
    }

    // Stage 5: build context + dispatch the matching handler.
    const handler = this.handlers[rule.do];
    if (handler === undefined) {
      this.logger.error({ rule_name: rule.name, do: rule.do }, 'wft_router_no_handler_for_rule');
      return;
    }

    const ctx = this.buildContext(winner.rule, winner.event, winner.identity);

    try {
      const outcome = await handler(ctx);
      this.onOutcome(winner.rule, winner.identity, outcome, coalesced);
    } catch (err) {
      // A handler that throws (rather than returning a failed outcome) is
      // logged and isolated — it must not abort sibling rules' dispatches.
      this.metrics?.incHandlerError(winner.rule.do);
      this.logger.error(
        {
          rule_name: rule.name,
          event_id: winner.identity.event_id,
          error: err instanceof Error ? err.message : String(err),
        },
        'wft_router_handler_threw',
      );
    }
  }

  /**
   * Build the {@link HandlerContext} for one dispatch.
   *
   * - `withBlock = rule.with` (RAW — the handler renders it; we never
   *   pre-render).
   * - `apiBaseUrl` = the daemon endpoint.
   * - `authToken` = `process.env[rule.with.token_env]` when the rule names a
   *   `token_env` and it resolves, else the daemon's configured `apiKey`.
   * - `tokenEnv` = the rule's `with.token_env` NAME (read by `shell_exec`).
   * - default `spawnImpl` / `fetchImpl` / `adaptersPath` are threaded from
   *   the injected deps (tests inject fakes).
   */
  private buildContext(
    rule: TriggersRule,
    event: EventPayloadShape,
    identity: DispatchIdentity,
  ): HandlerContext {
    const tokenEnvName = readTokenEnv(rule.with);
    const resolvedFromEnv = tokenEnvName !== undefined ? this.env[tokenEnvName] : undefined;
    const authToken =
      resolvedFromEnv !== undefined && resolvedFromEnv.length > 0 ? resolvedFromEnv : this.apiKey;

    const ctx: HandlerContext = {
      store: this.store,
      logger: this.logger,
      event,
      identity,
      withBlock: rule.with,
      apiBaseUrl: this.apiBaseUrl,
      authToken,
    };
    if (tokenEnvName !== undefined) ctx.tokenEnv = tokenEnvName;
    if (this.fetchImpl !== undefined) ctx.fetchImpl = this.fetchImpl;
    if (this.spawnImpl !== undefined) ctx.spawnImpl = this.spawnImpl;
    if (this.adaptersPath !== undefined) ctx.adaptersPath = this.adaptersPath;
    return ctx;
  }

  /**
   * Log a handler outcome at the right level. The retry/backoff loop on
   * `retryable: true` is DEFERRED — here we only surface the seam (a WARN
   * that an at-least-once redelivery would re-fire). Suppressed/succeeded
   * are info; non-retryable failures are errors.
   */
  private onOutcome(
    rule: TriggersRule,
    identity: DispatchIdentity,
    outcome: HandlerOutcome,
    coalescedCount: number,
  ): void {
    const base = {
      rule_name: rule.name,
      event_id: identity.event_id,
      coalesced_count: coalescedCount,
    };
    // Record the dispatch outcome by handler + status (task #434). The
    // outcome kind maps 1:1 onto the `status` label values.
    this.metrics?.incDispatched(rule.do, outcome.kind);
    switch (outcome.kind) {
      case 'succeeded':
        this.logger.info(
          { ...base, session_id: outcome.sessionId },
          'wft_router_dispatch_succeeded',
        );
        return;
      case 'suppressed':
        this.logger.info({ ...base, reason: outcome.reason }, 'wft_router_dispatch_suppressed');
        return;
      case 'failed':
        if (outcome.retryable) {
          // DEFERRED: enqueue for retry/backoff. For now, surface the seam.
          this.logger.warn(
            { ...base, detail: outcome.detail, retryable: true },
            'wft_router_dispatch_failed_retryable',
          );
        } else {
          this.metrics?.incPermanentlyFailed(rule.name);
          this.logger.error(
            { ...base, detail: outcome.detail, retryable: false },
            'wft_router_dispatch_failed_permanent',
          );
        }
        return;
      default: {
        const _exhaustive: never = outcome;
        throw new Error(`unreachable outcome: ${String(_exhaustive)}`);
      }
    }
  }

  /** Track an in-flight fan-out so `stop()` can drain it. */
  private track(p: Promise<void>): void {
    this.inFlight.add(p);
    void p.finally(() => {
      this.inFlight.delete(p);
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the `token_env` NAME from a rule's raw `with:` block, if present and
 * a non-empty string. The schema already validated its env-var-name shape.
 */
function readTokenEnv(withBlock: Record<string, unknown>): string | undefined {
  const v = withBlock['token_env'];
  if (typeof v === 'string' && v.length > 0) {
    return v;
  }
  return undefined;
}
