import { afterEach, describe, expect, it } from 'vitest';

import { Debouncer } from '../../src/dispatch/index.js';
import { makeFakeTimerHost, type FakeTimerHost } from './harness.js';

// Payload shape mirrors what the daemon threads through the debouncer for one
// matched (rule, event) pair: the trailing-edge "last wins" identity is what a
// handler would receive.
interface DebouncePayload {
  event_id: string;
  status: string;
}

describe('fix-3 / debounce', () => {
  let host: FakeTimerHost;

  afterEach(() => {
    // No real timers were armed; nothing to clean beyond GC.
    host = undefined as unknown as FakeTimerHost;
  });

  // fix-3 / debounce: three rapid `status_changed` events in `debounce_ms`
  // collapse to one dispatch; the *last* event's payload is the one delivered;
  // `coalesced_count: 3` is logged.
  it('collapses three rapid events into one dispatch carrying the last payload', async () => {
    // Drive the REAL production Debouncer (the module that owns coalescing)
    // through a manual timer host — the house style from
    // dispatch/__tests__/debounce.test.ts. The trailing-edge timer fires ONLY
    // on fireAll(), so the three pushes are guaranteed to land in one window
    // before it closes: byte-deterministic, no real timer, no sleep.
    host = makeFakeTimerHost();
    const debouncer = new Debouncer<DebouncePayload>({
      windowMs: 100,
      setTimer: host.setTimer,
      clearTimer: host.clearTimer,
    });

    // Three rapid transitions on the SAME (rule, task) bucket key.
    const p1 = debouncer.push('rule', '5', { event_id: 'evt-d1', status: 'closed' });
    const p2 = debouncer.push('rule', '5', { event_id: 'evt-d2', status: 'reopened' });
    const p3 = debouncer.push('rule', '5', { event_id: 'evt-d3', status: 'closed' });

    // All three pushes coalesced into ONE outstanding trailing-edge timer
    // (i.e. one bucket / one dispatch), not three independent windows.
    expect(host.pending()).toHaveLength(1);

    // Close the window: the single timer fires the bucket's trailing edge.
    host.fireAll();
    const results = await Promise.all([p1, p2, p3]);

    // Every subscriber resolves with the SAME single collapsed result:
    // the LAST event's payload + coalesced_count: 3 (the value the daemon logs
    // as `coalesced_count` on its one dispatch line).
    for (const r of results) {
      expect(r.coalesced_count).toBe(3);
      expect(r.payload.event_id).toBe('evt-d3');
    }
    // No further timers were armed by firing.
    expect(host.pending()).toHaveLength(0);
  });
});
