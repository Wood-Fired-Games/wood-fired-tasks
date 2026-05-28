/**
 * Graceful-shutdown coordinator for the wft-router daemon
 * (task #432).
 *
 * Implements the SIGTERM/SIGINT drain story
 * (docs/event-router-design.md §"Graceful shutdown", line 470-479):
 *
 *   > SIGTERM / SIGINT: stop reading new SSE events immediately;
 *   > allow in-flight dispatches up to `shutdown_grace_s` (default
 *   > 30 s). Cursor advances only for events whose dispatches reach
 *   > `SUCCEEDED` or `PERMANENTLY_FAILED`; the rest stay `PENDING`
 *   > for the next restart.
 *   > After grace: SIGTERM to handler subprocesses; after
 *   > `subprocess_grace_s` (default 5 s), SIGKILL.
 *   > A second SIGTERM during shutdown: immediate exit. Cursor not
 *   > advanced. All in-flight rows stay `PENDING`.
 *
 * Scope split: this module owns ONLY the signal-to-drain coordination
 * (i.e. "we got a signal → run drain callbacks → resolve a Promise
 * when they're done or grace expires"). It does NOT:
 *
 *   - Send SIGTERM/SIGKILL to handler subprocesses (handler manager
 *     does that as one of its drain callbacks; see task #441).
 *   - Decide whether to advance the SSE cursor (the dispatch loop
 *     owns that, also as a drain callback; see task #433).
 *   - Call `process.exit` (the orchestrator script does that once
 *     `waitForShutdown` resolves — keeps this module pure and
 *     testable without `process.exit` mocking acrobatics).
 *
 * The `proc.exit` option exists for orchestrators that DO want this
 * module to flip the exit switch (e.g. the eventual `wft-router run`
 * binary). When omitted, this module returns the resolution payload
 * and lets the caller decide.
 *
 * Standalone-package isolation: no imports from root `src/`. Only
 * dependency is the local defaults constant; the
 * `NodeJS.Signals` type comes from `@types/node`, already a
 * transitively-resolved dev dep.
 */

import { WFT_ROUTER_DEFAULTS } from './defaults.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal process abstraction so tests can pass a fake
 * EventEmitter-shaped object instead of `process`. `off` is optional
 * because the test fakes rarely care about un-listening, and `exit`
 * is optional per the JSDoc on the constructor.
 */
export interface ShutdownProc {
  on: (sig: NodeJS.Signals, fn: () => void) => void;
  off?: (sig: NodeJS.Signals, fn: () => void) => void;
  exit?: (code: number) => void;
}

export interface ShutdownOptions {
  /** Grace period in ms before forced exit. Default shutdown_grace_s * 1000. */
  graceMs?: number;
  /** Signals to listen for; default ['SIGTERM', 'SIGINT']. */
  signals?: NodeJS.Signals[];
  /** Process abstraction for tests (default `process`). */
  proc?: ShutdownProc;
  /** Clock for tests. */
  now?: () => number;
  /** Optional setTimeout injection. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Resolution payload of {@link GracefulShutdown.waitForShutdown}.
 *
 * - `signal`: the signal name that triggered shutdown, or
 *   `'GRACE_TIMEOUT'` if the grace timer fired before any drain
 *   callback resolved (i.e. the first signal arrived but drain
 *   couldn't complete in time).
 * - `drainedCleanly`: true iff every drain callback resolved or
 *   rejected before either the grace timer OR a second signal. We
 *   use `Promise.allSettled` so a single failing drain does NOT
 *   abort the others; `drainedCleanly` flips to false only on the
 *   timeout / second-signal path.
 */
export interface ShutdownResult {
  signal: NodeJS.Signals | 'GRACE_TIMEOUT';
  drainedCleanly: boolean;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'draining' | 'done';

interface RegisteredHandler {
  signal: NodeJS.Signals;
  fn: () => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class GracefulShutdown {
  private readonly graceMs: number;
  private readonly signals: NodeJS.Signals[];
  private readonly proc: ShutdownProc;
  // `now` is part of the documented options surface even though we
  // don't currently use it in the implementation — keeping it on the
  // constructor signature lets task #433 swap in a monotonic clock
  // for shutdown-latency metrics without an API break.
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private phase: Phase = 'idle';
  private readonly drainCallbacks: Array<() => Promise<void> | void> = [];
  private readonly registered: RegisteredHandler[] = [];

  private firstSignal: NodeJS.Signals | null = null;
  private graceTimer: unknown = undefined;
  private resolveShutdown: ((value: ShutdownResult) => void) | null = null;
  private shutdownPromise: Promise<ShutdownResult> | null = null;

  /**
   * Wire up signal handlers immediately on construction so a SIGTERM
   * arriving between `new GracefulShutdown()` and the first
   * `waitForShutdown()` call is not lost.
   */
  constructor(options: ShutdownOptions = {}) {
    this.graceMs = options.graceMs ?? WFT_ROUTER_DEFAULTS.shutdown_grace_s * 1000;
    this.signals = options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]);
    this.proc = options.proc ?? (process as unknown as ShutdownProc);
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

    for (const sig of this.signals) {
      const handler = (): void => this.handleSignal(sig);
      this.proc.on(sig, handler);
      this.registered.push({ signal: sig, fn: handler });
    }
  }

  /**
   * Register a drain callback. Callbacks are invoked in parallel via
   * `Promise.allSettled` once the first signal arrives. Returns
   * synchronously; the caller awaits {@link waitForShutdown} for the
   * final settlement.
   */
  onDrain(fn: () => Promise<void> | void): void {
    this.drainCallbacks.push(fn);
  }

  /**
   * Returns a Promise that resolves the first time EITHER:
   *
   *   - all drain callbacks settle (`drainedCleanly: true`), OR
   *   - the grace timer fires (`drainedCleanly: false,
   *     signal: 'GRACE_TIMEOUT'`), OR
   *   - a second signal arrives during draining
   *     (`drainedCleanly: false, signal: <that signal>`).
   *
   * Subsequent calls return the same Promise so multiple subsystems
   * can await shutdown without each registering their own
   * coordination state.
   */
  waitForShutdown(): Promise<ShutdownResult> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    this.shutdownPromise = new Promise<ShutdownResult>((resolve) => {
      this.resolveShutdown = resolve;
    });
    return this.shutdownPromise;
  }

  /**
   * Tear down signal handlers. Test helper; production calls this
   * only after `waitForShutdown` resolves so a stray signal at the
   * tail of the process lifetime cannot retrigger drain.
   */
  dispose(): void {
    if (this.proc.off !== undefined) {
      const offFn = this.proc.off;
      for (const { signal, fn } of this.registered) {
        offFn(signal, fn);
      }
    }
    this.registered.length = 0;
    if (this.graceTimer !== undefined) {
      this.clearTimer(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The signal-handler body. Branches on the current phase:
   *
   *   - `idle` → flip to draining, kick off callbacks, arm grace.
   *   - `draining` → second signal: resolve immediately with the
   *     second signal (per spec).
   *   - `done` → no-op (a stray signal after we've already resolved
   *     just gets swallowed).
   */
  private handleSignal(sig: NodeJS.Signals): void {
    if (this.phase === 'done') {
      return;
    }
    if (this.phase === 'draining') {
      // Second-SIGTERM-during-shutdown: immediate exit per spec
      // (line 478). We resolve with the second signal so the
      // orchestrator can log which signal forced the exit.
      this.finish({ signal: sig, drainedCleanly: false });
      return;
    }

    // phase === 'idle' → transition to draining.
    this.phase = 'draining';
    this.firstSignal = sig;

    // Arm grace timer FIRST so callbacks that throw or hang don't
    // leave the daemon hung indefinitely.
    this.graceTimer = this.setTimer(() => {
      this.finish({ signal: 'GRACE_TIMEOUT', drainedCleanly: false });
    }, this.graceMs);

    // Kick off drain in parallel. allSettled so one failing
    // callback doesn't short-circuit the others — we want every
    // subsystem to attempt its drain.
    void this.runDrain();
  }

  private async runDrain(): Promise<void> {
    const settlements = this.drainCallbacks.map(async (cb) => cb());
    await Promise.allSettled(settlements);
    // If finish() already ran (grace timer or 2nd signal beat us),
    // this is a no-op via the phase guard.
    const sig = this.firstSignal ?? ('SIGTERM' as NodeJS.Signals);
    this.finish({ signal: sig, drainedCleanly: true });
  }

  /**
   * Single-shot resolution point. Idempotent — only the first call
   * resolves the waiter; subsequent calls are no-ops. Tears down
   * the grace timer so it cannot fire after a clean drain.
   */
  private finish(result: ShutdownResult): void {
    if (this.phase === 'done') {
      return;
    }
    this.phase = 'done';
    if (this.graceTimer !== undefined) {
      this.clearTimer(this.graceTimer);
      this.graceTimer = undefined;
    }
    // Ensure waitForShutdown() called AFTER finish() still resolves.
    if (this.shutdownPromise === null) {
      this.shutdownPromise = Promise.resolve(result);
    } else if (this.resolveShutdown !== null) {
      const r = this.resolveShutdown;
      this.resolveShutdown = null;
      r(result);
    }
    // Optional process.exit hook (off by default; orchestrator opts in).
    if (this.proc.exit !== undefined) {
      this.proc.exit(result.drainedCleanly ? 0 : 1);
    }
  }
}
