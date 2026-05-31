/**
 * Tests for the trailing-edge Debouncer (task #432).
 *
 * Coverage matches the acceptance criterion "debounce.test.ts covers
 * trailing-edge collapse of N events into 1" and exercises:
 *
 *   - N rapid push() calls within the window collapse to ONE resolved
 *     value carrying the LAST payload and coalesced_count: N. Every
 *     subscriber (i.e. every push's returned Promise) sees the same
 *     final value.
 *   - Each push restarts the window (trailing-edge debounce, not
 *     leading-edge throttle).
 *   - Two distinct (rule, event_key) pairs do not interfere — their
 *     payloads and counts stay independent.
 *   - Two distinct rule_ids with the SAME event_key do not collide.
 *   - flushAll() fires every pending bucket with its current state,
 *     immediately (no need to wait the window).
 *   - cancelAll() clears timers without firing — pending Promises
 *     stay pending (production guarantee, not asserted by negative
 *     test; we instead assert no extra timer fire happened).
 *
 * Timer/clock injection is via the options bag — NO vi.useFakeTimers().
 * A simple in-memory FakeTimerHost holds queued callbacks and lets
 * the test advance them deterministically.
 */

import { describe, expect, it } from 'vitest';

import { Debouncer, WFT_ROUTER_DEFAULTS } from '../index.js';

// ---------------------------------------------------------------------------
// Fake timer host
// ---------------------------------------------------------------------------

interface ScheduledTimer {
  id: number;
  fn: () => void;
  ms: number;
  fired: boolean;
}

interface FakeTimerHost {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Fire every still-pending timer, regardless of ms. */
  fireAll: () => void;
  /** Inspect outstanding timers. */
  pending: () => ScheduledTimer[];
}

function makeFakeTimerHost(): FakeTimerHost {
  const timers = new Map<number, ScheduledTimer>();
  let nextId = 1;
  return {
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { id, fn, ms, fired: false });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    fireAll: () => {
      const snapshot = Array.from(timers.values());
      for (const t of snapshot) {
        if (timers.has(t.id) && !t.fired) {
          t.fired = true;
          timers.delete(t.id);
          t.fn();
        }
      }
    },
    pending: () => Array.from(timers.values()),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Debouncer (defaults)', () => {
  it('uses WFT_ROUTER_DEFAULTS.debounce_ms when no windowMs given', () => {
    const host = makeFakeTimerHost();
    const deb = new Debouncer<string>({
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    void deb.push('rule', 'k', 'payload');
    const pending = host.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.ms).toBe(WFT_ROUTER_DEFAULTS.debounce_ms);
  });
});

describe('Debouncer (trailing-edge collapse)', () => {
  it('collapses N rapid pushes into one resolution with the LAST payload and coalesced_count: N', async () => {
    const host = makeFakeTimerHost();
    const deb = new Debouncer<{ v: number }>({
      windowMs: 100,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    const p1 = deb.push('rule', 'k', { v: 1 });
    const p2 = deb.push('rule', 'k', { v: 2 });
    const p3 = deb.push('rule', 'k', { v: 3 });
    const p4 = deb.push('rule', 'k', { v: 4 });
    // Only one timer should be active (the prior three were cleared).
    expect(host.pending()).toHaveLength(1);
    host.fireAll();
    const results = await Promise.all([p1, p2, p3, p4]);
    for (const r of results) {
      expect(r.payload).toEqual({ v: 4 });
      expect(r.coalesced_count).toBe(4);
    }
  });

  it('a single push fires with coalesced_count: 1', async () => {
    const host = makeFakeTimerHost();
    const deb = new Debouncer<string>({
      windowMs: 50,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    const p = deb.push('r', 'k', 'only');
    host.fireAll();
    const r = await p;
    expect(r).toEqual({ payload: 'only', coalesced_count: 1 });
  });

  it('clearing the prior timer on every push prevents stale fires', async () => {
    const host = makeFakeTimerHost();
    const deb = new Debouncer<string>({
      windowMs: 100,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    void deb.push('r', 'k', 'a');
    void deb.push('r', 'k', 'b');
    void deb.push('r', 'k', 'c');
    // At all times, exactly one pending timer (the most recent).
    expect(host.pending()).toHaveLength(1);
  });
});

describe('Debouncer (key isolation)', () => {
  it('two distinct (rule, eventKey) pairs do not interfere', async () => {
    const host = makeFakeTimerHost();
    const deb = new Debouncer<string>({
      windowMs: 100,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    const a1 = deb.push('rule-A', 'k', 'a1');
    const a2 = deb.push('rule-A', 'k', 'a2');
    const b1 = deb.push('rule-B', 'k', 'b1');
    expect(host.pending()).toHaveLength(2);
    host.fireAll();
    const [resA1, resA2, resB1] = await Promise.all([a1, a2, b1]);
    expect(resA1.payload).toBe('a2');
    expect(resA1.coalesced_count).toBe(2);
    expect(resA2.payload).toBe('a2');
    expect(resA2.coalesced_count).toBe(2);
    expect(resB1.payload).toBe('b1');
    expect(resB1.coalesced_count).toBe(1);
  });

  it('same rule_id with different event_keys (e.g. different task_ids) do not collide', async () => {
    const host = makeFakeTimerHost();
    const deb = new Debouncer<number>({
      windowMs: 50,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    const t1a = deb.push('rule', 'task-1', 100);
    const t1b = deb.push('rule', 'task-1', 101);
    const t2 = deb.push('rule', 'task-2', 200);
    expect(host.pending()).toHaveLength(2);
    host.fireAll();
    const [r1a, r1b, r2] = await Promise.all([t1a, t1b, t2]);
    expect(r1a.payload).toBe(101);
    expect(r1a.coalesced_count).toBe(2);
    expect(r1b.payload).toBe(101);
    expect(r1b.coalesced_count).toBe(2);
    expect(r2.payload).toBe(200);
    expect(r2.coalesced_count).toBe(1);
  });
});

describe('Debouncer.flushAll', () => {
  it('fires every pending bucket immediately with its current latest payload + count', async () => {
    const host = makeFakeTimerHost();
    const deb = new Debouncer<string>({
      windowMs: 999_999, // huge — would never fire naturally during the test
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    const a1 = deb.push('r1', 'k', 'a');
    const a2 = deb.push('r1', 'k', 'b');
    const c = deb.push('r2', 'k', 'c');
    await deb.flushAll();
    const [resA1, resA2, resC] = await Promise.all([a1, a2, c]);
    expect(resA1.payload).toBe('b');
    expect(resA1.coalesced_count).toBe(2);
    expect(resA2.payload).toBe('b');
    expect(resA2.coalesced_count).toBe(2);
    expect(resC.payload).toBe('c');
    expect(resC.coalesced_count).toBe(1);
    // All pending timers are cleared.
    expect(host.pending()).toHaveLength(0);
  });

  it('flushAll with no pending buckets resolves immediately', async () => {
    const host = makeFakeTimerHost();
    const deb = new Debouncer<string>({
      windowMs: 100,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    await expect(deb.flushAll()).resolves.toBeUndefined();
  });
});

describe('Debouncer.cancelAll', () => {
  it('clears every pending timer without firing subscribers', async () => {
    const host = makeFakeTimerHost();
    const deb = new Debouncer<string>({
      windowMs: 100,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    let fired = false;
    void deb.push('r', 'k', 'x').then(() => {
      fired = true;
    });
    expect(host.pending()).toHaveLength(1);
    deb.cancelAll();
    expect(host.pending()).toHaveLength(0);
    // Even firing any leftover timers (there should be none) must not
    // resolve the subscriber.
    host.fireAll();
    // Yield to microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(fired).toBe(false);
  });
});
