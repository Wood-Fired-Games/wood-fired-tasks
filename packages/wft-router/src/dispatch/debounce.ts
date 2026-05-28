/**
 * Trailing-edge debouncer keyed by `(rule_id, event_key)` (task #432).
 *
 * Implements the spec's debounce semantics
 * (docs/event-router-design.md §"Debounce", line 416-423):
 *
 *   > Per-rule `debounce_ms` collapses rapid status flaps.
 *   > Debounce keys on `(rule_name, task_id)` (so two flapping tasks
 *   > under one rule don't clobber each other). **The last event in
 *   > the window is dispatched** (matches user intent — "the latest
 *   > status is the truth"); earlier events in the window are merged
 *   > into a single dispatch row with `coalesced_count: N` in the
 *   > log.
 *
 * Behaviour pinned by the tests:
 *
 *   - N rapid `push()` calls within `windowMs` collapse to a single
 *     resolved Promise carrying the LAST payload and
 *     `coalesced_count: N`.
 *   - Every push restarts the timer (trailing-edge debounce, not
 *     leading-edge throttle).
 *   - Two distinct `(rule, eventKey)` pairs do not interfere.
 *   - `flushAll()` and `cancelAll()` are the graceful-shutdown
 *     escape hatches — flushAll resolves every pending bucket with
 *     its current state; cancelAll silently drops without resolving.
 *
 * Scope split: the dispatch loop (task #433) owns the
 * `(rule, event_key)` compound — the most common `event_key` is the
 * task_id, but a rule with no task context (e.g. project-level event)
 * may pass a different stable key. This module just trusts whatever
 * the caller hands it.
 *
 * Compound key encoding: `${ruleId}\0${eventKey}` — NUL is reserved
 * by sqlite text columns and by reasonable rule-name validators, so
 * we know it cannot appear inside either component and produce a
 * collision.
 *
 * Standalone-package isolation: no imports from root `src/`. Only
 * dependency is the local defaults constant.
 */

import { WFT_ROUTER_DEFAULTS } from './defaults.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DebounceOptions {
  /** Window ms. Default WFT_ROUTER_DEFAULTS.debounce_ms. */
  windowMs?: number;
  /** Clock for tests. */
  now?: () => number;
  /** Setter for timers (injection point for fake timers; defaults to globalThis.setTimeout / clearTimeout). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Trailing-edge resolution payload. `coalesced_count` is at least 1
 * (a single push that closed the window without being joined still
 * fires with N=1).
 */
export interface DebouncedResult<TPayload> {
  payload: TPayload;
  coalesced_count: number;
}

// ---------------------------------------------------------------------------
// Internal bucket state
// ---------------------------------------------------------------------------

interface Bucket<TPayload> {
  /** Most recent payload — wins per the "latest status is truth" rule. */
  latestPayload: TPayload;
  /** Number of pushes coalesced into this window so far. */
  coalescedCount: number;
  /** Active timer handle, or null when the bucket is being flushed. */
  timerHandle: unknown;
  /** All push()-issued Promises that resolve when the window closes. */
  subscribers: Array<(value: DebouncedResult<TPayload>) => void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class Debouncer<TPayload> {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly buckets: Map<string, Bucket<TPayload>> = new Map();

  constructor(options: DebounceOptions = {}) {
    this.windowMs = options.windowMs ?? WFT_ROUTER_DEFAULTS.debounce_ms;
    this.now = options.now ?? Date.now;
    // Bind through arrow wrappers so callers that destructure
    // `setTimeout` off `globalThis` don't accidentally lose `this`.
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Push an event into the `(ruleId, eventKey)` bucket. The latest
   * payload wins; the returned Promise resolves once the window
   * closes (trailing edge) with that payload and the total
   * `coalesced_count` of pushes that were folded into the window.
   *
   * Every push resets the window — this is debounce, not throttle.
   *
   * All Promises pushed into the same bucket share the same final
   * `DebouncedResult` instance: when the timer fires, every
   * subscriber gets `{ payload: latestPayload, coalesced_count: N }`,
   * and the bucket is removed.
   */
  push(ruleId: string, eventKey: string, payload: TPayload): Promise<DebouncedResult<TPayload>> {
    const key = compoundKey(ruleId, eventKey);
    const existing = this.buckets.get(key);

    if (existing !== undefined) {
      // Reset window: clear the old timer, update latest payload,
      // increment count, re-arm timer. Subscribers stay attached.
      this.clearTimer(existing.timerHandle);
      existing.latestPayload = payload;
      existing.coalescedCount += 1;
      existing.timerHandle = this.scheduleFire(key, existing);
      return new Promise<DebouncedResult<TPayload>>((resolve) => {
        existing.subscribers.push(resolve);
      });
    }

    // Fresh bucket. coalescedCount starts at 1 (this push).
    const bucket: Bucket<TPayload> = {
      latestPayload: payload,
      coalescedCount: 1,
      timerHandle: undefined as unknown,
      subscribers: [],
    };
    bucket.timerHandle = this.scheduleFire(key, bucket);
    this.buckets.set(key, bucket);
    return new Promise<DebouncedResult<TPayload>>((resolve) => {
      bucket.subscribers.push(resolve);
    });
  }

  /**
   * Drain every pending bucket immediately, firing the trailing-edge
   * resolution synchronously (from the caller's perspective). Used
   * by the graceful-shutdown path to coalesce on the way down rather
   * than waiting `windowMs` per rule.
   *
   * Each bucket's resolution payload is identical to what a normal
   * trailing-edge fire would have produced — i.e. the latest payload
   * + the coalesced count so far — so callers downstream don't need
   * a separate "flushed early" code path.
   *
   * The returned Promise resolves once every subscriber's
   * microtask has settled, which lets shutdown coordinators
   * sequence "flush → close db" correctly.
   */
  async flushAll(): Promise<void> {
    const snapshot = Array.from(this.buckets.entries());
    for (const [key, bucket] of snapshot) {
      this.clearTimer(bucket.timerHandle);
      this.fireBucket(key, bucket);
    }
    // Resolve after all microtasks scheduled by the synchronous
    // resolves have drained.
    await Promise.resolve();
  }

  /**
   * Clear every pending timer without firing any subscriber. Test
   * helper — production never calls this. Subscribers' Promises
   * are left UNRESOLVED on purpose (callers in production paths
   * await them through the dispatch loop, which itself will be
   * torn down).
   */
  cancelAll(): void {
    for (const bucket of this.buckets.values()) {
      this.clearTimer(bucket.timerHandle);
    }
    this.buckets.clear();
  }

  /**
   * Arm the trailing-edge timer for `bucket`. When it fires we
   * lookup the current bucket state under `key` (it may have been
   * mutated by an intermediate push that did NOT cancel us — see
   * note below), resolve every subscriber with the latest state,
   * and remove the bucket.
   *
   * Note: every push that joins an existing bucket DOES cancel and
   * re-arm via clearTimer/setTimer, so the timer that finally fires
   * is always the most recent one. This indirection keeps the
   * concurrency window between "clearTimer" and "fireBucket"
   * harmless — even if some host's setTimeout API has a quirky
   * unscheduled-fire path, we still see the latest state.
   */
  private scheduleFire(key: string, bucket: Bucket<TPayload>): unknown {
    return this.setTimer(() => {
      const current = this.buckets.get(key);
      if (current !== bucket) {
        // Re-armed by a newer push; drop this stale tick.
        return;
      }
      this.fireBucket(key, current);
    }, this.windowMs);
  }

  /**
   * Synchronously resolve every subscriber on `bucket` and remove
   * the bucket from the map. Shared by the normal trailing-edge
   * path and by `flushAll`.
   */
  private fireBucket(key: string, bucket: Bucket<TPayload>): void {
    const result: DebouncedResult<TPayload> = {
      payload: bucket.latestPayload,
      coalesced_count: bucket.coalescedCount,
    };
    this.buckets.delete(key);
    for (const resolve of bucket.subscribers) {
      resolve(result);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compound key for the bucket map: `${ruleId}\0${eventKey}`. NUL
 * separator is reserved by both sqlite TEXT columns and any
 * reasonable rule-id validator, so we know it cannot appear inside
 * either component and produce a collision.
 */
function compoundKey(ruleId: string, eventKey: string): string {
  return `${ruleId} ${eventKey}`;
}
