/**
 * Tests for the GracefulShutdown coordinator (task #432).
 *
 * Coverage matches the acceptance criterion "graceful-shutdown.test.ts
 * asserts in-flight drain on SIGTERM" and exercises:
 *
 *   - SIGTERM triggers every registered drain callback in parallel.
 *   - waitForShutdown resolves with drainedCleanly: true when all
 *     drain callbacks settle before the grace timer fires.
 *   - waitForShutdown resolves with drainedCleanly: false and
 *     signal: 'GRACE_TIMEOUT' when the grace timer fires before
 *     drain completes.
 *   - A second signal during drain resolves immediately with the
 *     second signal and drainedCleanly: false (per spec line 478).
 *   - dispose() unregisters signal handlers via proc.off.
 *
 * Process abstraction is injected via the options bag — NO
 * vi.useFakeTimers(), NO process.exit mocking.
 */

import { describe, expect, it } from 'vitest';

import { GracefulShutdown, type ShutdownProc } from '../index.js';

// ---------------------------------------------------------------------------
// Fake EventEmitter-shaped process
// ---------------------------------------------------------------------------

interface FakeProc extends ShutdownProc {
  emit: (sig: NodeJS.Signals) => void;
  listenerCount: (sig: NodeJS.Signals) => number;
  exitCalls: number[];
}

function makeFakeProc(): FakeProc {
  const listeners = new Map<NodeJS.Signals, Set<() => void>>();
  const exitCalls: number[] = [];
  return {
    on: (sig, fn) => {
      let set = listeners.get(sig);
      if (set === undefined) {
        set = new Set();
        listeners.set(sig, set);
      }
      set.add(fn);
    },
    off: (sig, fn) => {
      listeners.get(sig)?.delete(fn);
    },
    exit: (code) => {
      exitCalls.push(code);
    },
    emit: (sig) => {
      const set = listeners.get(sig);
      if (set === undefined) return;
      // Snapshot — handlers may dispose themselves during fire.
      for (const fn of Array.from(set)) {
        fn();
      }
    },
    listenerCount: (sig) => listeners.get(sig)?.size ?? 0,
    exitCalls,
  };
}

// ---------------------------------------------------------------------------
// Fake timer host
// ---------------------------------------------------------------------------

interface FakeTimerHost {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  fireAll: () => void;
  pendingCount: () => number;
}

function makeFakeTimerHost(): FakeTimerHost {
  const timers = new Map<number, { fn: () => void; fired: boolean }>();
  let nextId = 1;
  return {
    setTimer: (fn) => {
      const id = nextId++;
      timers.set(id, { fn, fired: false });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    fireAll: () => {
      const snap = Array.from(timers.entries());
      for (const [id, t] of snap) {
        if (timers.has(id) && !t.fired) {
          t.fired = true;
          timers.delete(id);
          t.fn();
        }
      }
    },
    pendingCount: () => timers.size,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GracefulShutdown.constructor', () => {
  it('registers signal handlers immediately so a signal between construction and waitForShutdown is not lost', () => {
    const proc = makeFakeProc();
    const host = makeFakeTimerHost();
    const gs = new GracefulShutdown({
      proc,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    expect(proc.listenerCount('SIGINT')).toBe(1);
    gs.dispose();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });
});

describe('GracefulShutdown.waitForShutdown (clean drain)', () => {
  it('resolves drainedCleanly: true when all drain callbacks settle before grace', async () => {
    const proc = makeFakeProc();
    const host = makeFakeTimerHost();
    const gs = new GracefulShutdown({
      proc,
      graceMs: 1_000_000,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });

    let drainRan = 0;
    gs.onDrain(async () => {
      drainRan++;
    });
    gs.onDrain(() => {
      drainRan++;
    });

    const waiter = gs.waitForShutdown();
    proc.emit('SIGTERM');
    const result = await waiter;
    expect(drainRan).toBe(2);
    expect(result.drainedCleanly).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    // Grace timer was cleared on clean drain.
    expect(host.pendingCount()).toBe(0);
    gs.dispose();
  });

  it('runs drain callbacks in parallel and does not abort on a failing callback', async () => {
    const proc = makeFakeProc();
    const host = makeFakeTimerHost();
    const gs = new GracefulShutdown({
      proc,
      graceMs: 1_000_000,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });

    let bRan = false;
    gs.onDrain(async () => {
      throw new Error('a failed');
    });
    gs.onDrain(async () => {
      bRan = true;
    });

    const waiter = gs.waitForShutdown();
    proc.emit('SIGINT');
    const result = await waiter;
    expect(bRan).toBe(true);
    // Failing drain via allSettled does NOT degrade drainedCleanly.
    expect(result.drainedCleanly).toBe(true);
    expect(result.signal).toBe('SIGINT');
    gs.dispose();
  });
});

describe('GracefulShutdown.waitForShutdown (grace timeout)', () => {
  it('resolves drainedCleanly: false and signal: GRACE_TIMEOUT when the grace timer fires first', async () => {
    const proc = makeFakeProc();
    const host = makeFakeTimerHost();
    const gs = new GracefulShutdown({
      proc,
      graceMs: 100,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });

    // A drain callback that never resolves.
    gs.onDrain(
      () =>
        new Promise<void>(() => {
          /* hang */
        }),
    );

    const waiter = gs.waitForShutdown();
    proc.emit('SIGTERM');
    // Trigger the grace timer explicitly (fake timer host doesn't auto-fire).
    host.fireAll();
    const result = await waiter;
    expect(result.signal).toBe('GRACE_TIMEOUT');
    expect(result.drainedCleanly).toBe(false);
    gs.dispose();
  });
});

describe('GracefulShutdown (second signal during drain)', () => {
  it('a second SIGTERM during drain resolves immediately with that signal and drainedCleanly: false', async () => {
    const proc = makeFakeProc();
    const host = makeFakeTimerHost();
    const gs = new GracefulShutdown({
      proc,
      graceMs: 1_000_000,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });

    // A drain callback that never resolves (so first signal hangs in
    // draining state).
    gs.onDrain(
      () =>
        new Promise<void>(() => {
          /* hang */
        }),
    );

    const waiter = gs.waitForShutdown();
    proc.emit('SIGTERM');
    // Second signal arrives BEFORE drain completes and BEFORE grace timer.
    proc.emit('SIGTERM');
    const result = await waiter;
    expect(result.signal).toBe('SIGTERM');
    expect(result.drainedCleanly).toBe(false);
    // Grace timer cleared on second-signal exit.
    expect(host.pendingCount()).toBe(0);
    gs.dispose();
  });
});

describe('GracefulShutdown.dispose', () => {
  it('unregisters signal handlers via proc.off', () => {
    const proc = makeFakeProc();
    const host = makeFakeTimerHost();
    const gs = new GracefulShutdown({
      proc,
      signals: ['SIGTERM' as NodeJS.Signals, 'SIGINT' as NodeJS.Signals, 'SIGHUP' as NodeJS.Signals],
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    expect(proc.listenerCount('SIGHUP' as NodeJS.Signals)).toBe(1);
    gs.dispose();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGHUP' as NodeJS.Signals)).toBe(0);
  });
});

describe('GracefulShutdown (process.exit opt-in)', () => {
  it('calls proc.exit(0) on clean drain when proc.exit is provided', async () => {
    const proc = makeFakeProc();
    const host = makeFakeTimerHost();
    const gs = new GracefulShutdown({
      proc,
      graceMs: 1_000_000,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });
    gs.onDrain(() => {
      /* sync no-op */
    });
    const waiter = gs.waitForShutdown();
    proc.emit('SIGTERM');
    await waiter;
    expect(proc.exitCalls).toEqual([0]);
    gs.dispose();
  });
});
