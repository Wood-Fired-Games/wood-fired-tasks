import { afterEach, describe, expect, it } from 'vitest';

import { createFixtureStore, type FixtureStore } from './harness.js';

const MIN = 60_000;
const BASE = 1_700_000_000_000;

describe('fix-4 / idempotency', () => {
  let fx: FixtureStore;

  afterEach(() => {
    fx?.dispose();
  });

  // fix-4 / idempotency: a duplicate event (same `event_id`) within the window
  // does not re-dispatch; a legitimate `closed → reopened → closed` cycle that
  // straddles `emitted_at_minute` *does* re-dispatch (the secondary coalescer
  // doesn't collapse legitimate retransitions).
  it('suppresses same-event_id duplicates but allows a straddling transition cycle', () => {
    fx = createFixtureStore();
    const rule = 'idem';

    // --- Part A: duplicate event_id within the window -----------------------
    const dup = {
      rule_name: rule,
      event_id: 'evt-dup',
      rendered_with_json: '{}',
      task_id: 42,
      to_status: 'closed',
      emitted_at_ms: BASE,
    };
    expect(fx.store.claim(dup).kind).toBe('CLAIMED');
    fx.store.complete(rule, 'evt-dup', 'SUCCEEDED');
    // Re-delivery of the SAME event_id is suppressed → no re-dispatch.
    expect(fx.store.claim(dup)).toEqual({ kind: 'ALREADY_DONE', status: 'SUCCEEDED' });

    // --- Part B: legitimate closed → reopened → closed across minutes -------
    // Each transition is a distinct event_id emitted in a distinct minute, so
    // each claims fresh AND the secondary key (rule, task, to_status, minute)
    // does not collapse the two `closed` transitions — they straddle the
    // emitted_at_minute boundary.
    const c1 = {
      rule_name: rule,
      event_id: 'evt-c1',
      rendered_with_json: '{}',
      task_id: 42,
      to_status: 'closed',
      emitted_at_ms: BASE + 1 * MIN,
    };
    const c2 = {
      rule_name: rule,
      event_id: 'evt-c2',
      rendered_with_json: '{}',
      task_id: 42,
      to_status: 'reopened',
      emitted_at_ms: BASE + 2 * MIN,
    };
    const c3 = {
      rule_name: rule,
      event_id: 'evt-c3',
      rendered_with_json: '{}',
      task_id: 42,
      to_status: 'closed',
      emitted_at_ms: BASE + 3 * MIN,
    };

    for (const c of [c1, c2, c3]) {
      expect(fx.store.claim(c).kind).toBe('CLAIMED');
      fx.store.complete(rule, c.event_id, 'SUCCEEDED');
    }

    // The second `closed` is a SUCCEEDED row in its OWN minute bucket — the
    // secondary lookup for the first `closed` minute must not match it, proving
    // the coalescer didn't collapse the legitimate retransition.
    expect(
      fx.store.lookupBySecondaryKey({
        rule_name: rule,
        task_id: 42,
        to_status: 'closed',
        emitted_at_ms: BASE + 1 * MIN,
      }),
    ).toBe('evt-c1');
    expect(
      fx.store.lookupBySecondaryKey({
        rule_name: rule,
        task_id: 42,
        to_status: 'closed',
        emitted_at_ms: BASE + 3 * MIN,
      }),
    ).toBe('evt-c3');
  });
});
