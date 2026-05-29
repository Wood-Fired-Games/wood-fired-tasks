import { afterEach, describe, expect, it } from 'vitest';

import { createFixtureStore, type FixtureStore } from './harness.js';

describe('fix-2 / pending-reconcile', () => {
  let fx: FixtureStore;

  afterEach(() => {
    fx?.dispose();
  });

  // fix-2 / pending-reconcile: the router is killed between `PENDING` and
  // handler invoke; on restart the rule re-fires exactly once. Killed between
  // handler return and cursor advance: idempotency primary key suppresses
  // re-fire on the next replay.
  it('replays a leftover PENDING row, then the PK suppresses a later replay', async () => {
    fx = createFixtureStore();
    const claimInput = {
      rule_name: 'reconcile',
      event_id: 'evt-reconcile-1',
      rendered_with_json: '{"command":"true"}',
      task_id: 1,
      to_status: 'closed',
      emitted_at_ms: 1_700_000_000_000,
    };

    // Run 1: the handler claimed (PENDING written) but the process was killed
    // before the terminal write — the row is left PENDING on disk.
    expect(fx.store.claim(claimInput).kind).toBe('CLAIMED');

    // Restart: the SAME on-disk store still holds the PENDING row, so the
    // crash-replay path surfaces it for exactly one re-fire.
    fx.store.close();
    const afterCrash = fx.reopen();
    const survivors = afterCrash.replayPending();
    expect(survivors.map((r) => r.event_id)).toEqual(['evt-reconcile-1']);
    expect(survivors).toHaveLength(1);

    // The re-fire completes successfully this time (handler returns → terminal
    // write happens before the cursor advances).
    expect(afterCrash.complete('reconcile', 'evt-reconcile-1', 'SUCCEEDED')).toBe(true);

    // Killed between handler return and cursor advance → the same event is
    // delivered again on the next restart. The idempotency primary key now
    // holds a terminal row, so the re-claim is suppressed (ALREADY_DONE) and
    // the rule does NOT re-fire.
    afterCrash.close();
    const afterSecondRestart = fx.reopen();
    expect(afterSecondRestart.replayPending()).toEqual([]);
    expect(afterSecondRestart.claim(claimInput)).toEqual({
      kind: 'ALREADY_DONE',
      status: 'SUCCEEDED',
    });
  });
});
