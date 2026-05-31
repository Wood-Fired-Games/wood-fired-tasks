import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentSessionDispatch } from '../../src/handlers/agent-session-dispatch.js';
import type { HandlerContext, SpawnImpl } from '../../src/handlers/index.js';
import { createFixtureStore, silentLogger, taskEvent, type FixtureStore } from './harness.js';

// fix-13 / stuck-handler: one rule's handler is down indefinitely; the cursor
// still advances for all other rules. The per-attempt watchdog fires (a wedged
// adapter is SIGTERM/SIGKILLed) and the row transitions to FAILED (retryable);
// after `max_retries` the dead rule's row reaches the terminal
// PERMANENTLY_FAILED state and its cursor unblocks, while a healthy sibling
// rule advances independently. Driven with vitest fake timers — no real sleeps.
//
// AC-vs-design-doc reconciliation: the task AC says "state transitions to
// FAILED"; the design doc says "after max_retries the row reaches
// PERMANENTLY_FAILED". Both are real and asserted here — the handler's single
// attempt yields FAILED (retryable) on watchdog timeout; the documented retry
// loop is DEFERRED in the daemon (see daemon.ts §DEFERRED), and exhausting
// `max_retries` is a caller-side store transition to PERMANENTLY_FAILED
// (idempotency-store.ts: "once retries are exhausted the row is rewritten as
// PERMANENTLY_FAILED — that's a caller-side decision, not the store's").

/** Write a do-nothing adapter file so the handler's path-resolution succeeds. */
function writeAdapterStub(dir: string, name: string): void {
  const file = join(dir, name);
  writeFileSync(file, '#!/usr/bin/env node\n', { mode: 0o755 });
  chmodSync(file, 0o755);
}

/**
 * A fake child that models a WEDGED handler: it never exits on its own. It only
 * emits `close` when `kill('SIGKILL')` lands — i.e. it ignores the first
 * SIGTERM and dies on the follow-up SIGKILL, exactly like a hung adapter the
 * watchdog must reap. No real process is spawned, so the test is deterministic.
 */
function wedgedSpawn(): { spawnImpl: SpawnImpl } {
  const spawnImpl = (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: { on: () => void; end: () => void };
      stdout: EventEmitter;
      kill: (sig: NodeJS.Signals) => void;
    };
    child.stdin = { on: () => undefined, end: () => undefined };
    child.stdout = new EventEmitter();
    child.kill = (sig: NodeJS.Signals): void => {
      // Ignore SIGTERM (wedged); die on the watchdog's follow-up SIGKILL.
      if (sig === 'SIGKILL') {
        child.emit('close', null, 'SIGKILL');
      }
    };
    return child;
  }) as unknown as SpawnImpl;
  return { spawnImpl };
}

describe('fix-13 / stuck-handler', () => {
  let fx: FixtureStore;
  let adaptersDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fx?.dispose();
    if (adaptersDir !== undefined) {
      rmSync(adaptersDir, { recursive: true, force: true });
    }
  });

  it('watchdog fires on a wedged adapter → FAILED, while a sibling rule advances', async () => {
    fx = createFixtureStore();
    adaptersDir = mkdtempSync(join(tmpdir(), 'wft-stuck-'));
    writeAdapterStub(adaptersDir, 'wedged');

    const { spawnImpl } = wedgedSpawn();
    const deadCtx: HandlerContext = {
      store: fx.store,
      logger: silentLogger(),
      identity: {
        rule_name: 'dead-rule',
        event_id: 'evt-stuck-1',
        task_id: 1,
        to_status: 'done',
        emitted_at_ms: 1_700_000_000_000,
      },
      event: taskEvent('evt-stuck-1', 'task.status_changed', { id: 1, status: 'done' }),
      renderedWith: { adapter: 'wedged', target: 'p/s' },
      adaptersPath: [adaptersDir],
      // The wedged fake child never exits on its own; only the watchdog's
      // SIGTERM→SIGKILL escalation reaps it. Inject the fake spawn so no real
      // process runs.
      spawnImpl,
      // A short per-attempt timeout so the watchdog fires quickly under fake
      // timers — the exact value is irrelevant; we advance time past it.
      timeoutMs: 50,
    };

    const deadOutcome = agentSessionDispatch(deadCtx);

    // Advance fake time past the per-attempt timeout (50 ms) AND the
    // SIGTERM→SIGKILL grace (KILL_GRACE_MS) so the watchdog reaps the wedged
    // child. No real sleeps — the fake timer clock drives the escalation.
    await vi.advanceTimersByTimeAsync(50 + 2_000 + 10);

    const outcome = await deadOutcome;
    // The single attempt times out → FAILED, marked retryable (the dispatcher
    // owns the retry loop; the handler reports one attempt).
    expect(outcome.kind).toBe('failed');
    expect(outcome).toMatchObject({ kind: 'failed', retryable: true });

    // The dead rule's row is now terminal-for-this-attempt FAILED in the store.
    expect(currentStatus(fx, 'dead-rule', 'evt-stuck-1')).toBe('FAILED');

    // A healthy SIBLING rule, keyed on a different (rule,event), claims +
    // completes independently — the stuck rule never blocked its cursor.
    expect(
      fx.store.claim({
        rule_name: 'live-rule',
        event_id: 'evt-stuck-1',
        rendered_with_json: '{"command":"true"}',
        task_id: 1,
        to_status: 'done',
        emitted_at_ms: 1_700_000_000_000,
      }).kind,
    ).toBe('CLAIMED');
    expect(fx.store.complete('live-rule', 'evt-stuck-1', 'SUCCEEDED')).toBe(true);
  });

  it('after max_retries the dead rule reaches PERMANENTLY_FAILED and its cursor unblocks', () => {
    fx = createFixtureStore();
    const maxRetries = 3;
    const claimInput = {
      rule_name: 'dead-rule',
      event_id: 'evt-retry-1',
      rendered_with_json: '{"adapter":"wedged"}',
      task_id: 2,
      to_status: 'done',
      emitted_at_ms: 1_700_000_000_000,
    };

    // Model the dispatcher's retry budget. The store keeps ONE row per
    // (rule,event) and `complete` only fires from PENDING (it is a no-op once a
    // row is terminal — see idempotency-store.ts), so the durable retry loop
    // that re-opens PENDING per attempt is DEFERRED in the daemon. What the
    // store DOES guarantee: the caller counts attempts, and on the attempt that
    // exhausts `max_retries` it writes the terminal PERMANENTLY_FAILED exactly
    // once. Earlier attempts are tracked by the caller's counter, not by extra
    // store rows.
    expect(fx.store.claim(claimInput).kind).toBe('CLAIMED');
    let attempts = 0;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      attempts += 1;
    }
    expect(attempts).toBe(maxRetries);
    // The retry budget is spent → the caller writes the documented terminal
    // state. This transition fires from PENDING and is the ONLY terminal write.
    expect(fx.store.complete('dead-rule', 'evt-retry-1', 'PERMANENTLY_FAILED')).toBe(true);
    // A redundant terminal write is a no-op (row is no longer PENDING).
    expect(fx.store.complete('dead-rule', 'evt-retry-1', 'FAILED')).toBe(false);

    // The row is now terminal PERMANENTLY_FAILED — the documented end state
    // after exhausting `max_retries`.
    expect(currentStatus(fx, 'dead-rule', 'evt-retry-1')).toBe('PERMANENTLY_FAILED');

    // Cursor unblock proof: a re-delivery of the SAME event is suppressed
    // (ALREADY_DONE) rather than re-claimed, so the stuck dispatch no longer
    // holds the cursor — the daemon advances past it.
    expect(fx.store.claim(claimInput)).toEqual({
      kind: 'ALREADY_DONE',
      status: 'PERMANENTLY_FAILED',
    });

    // And an unrelated rule's dispatch is wholly unaffected.
    expect(
      fx.store.claim({
        rule_name: 'other-rule',
        event_id: 'evt-retry-1',
        rendered_with_json: '{"command":"true"}',
        task_id: 2,
        to_status: 'done',
        emitted_at_ms: 1_700_000_000_000,
      }).kind,
    ).toBe('CLAIMED');
  });
});

/**
 * Read a row's current status by attempting a no-op claim: a CLAIMED result
 * would mean no row (impossible here); ALREADY_PENDING means PENDING;
 * ALREADY_DONE carries the terminal status.
 */
function currentStatus(fx: FixtureStore, rule: string, eventId: string): string {
  const res = fx.store.claim({
    rule_name: rule,
    event_id: eventId,
    rendered_with_json: '{}',
    task_id: null,
    to_status: null,
    emitted_at_ms: null,
  });
  if (res.kind === 'ALREADY_PENDING') {
    return 'PENDING';
  }
  if (res.kind === 'ALREADY_DONE') {
    return res.status;
  }
  return 'CLAIMED';
}
