import { afterEach, describe, expect, it } from 'vitest';

import { WftRouterDaemon } from '../../src/daemon.js';
import {
  configWith,
  createFixtureStore,
  registryWith,
  silentLogger,
  sseSourceFromEvents,
  taskEvent,
  type FixtureStore,
} from './harness.js';

describe('fix-1 / smoke', () => {
  let fx: FixtureStore;

  afterEach(() => {
    fx?.dispose();
  });

  // fix-1 / smoke: a fake SSE server emits one `task.status_changed` matching
  // one rule; the router dispatches once and persists the cursor.
  it('dispatches once for a single matching event', async () => {
    fx = createFixtureStore();
    const { handlers, rec } = registryWith();
    const config = configWith([
      {
        name: 'smoke',
        on: 'task.status_changed',
        where: { to_status: 'done' },
        do: 'webhook_post',
        with: { url: 'https://downstream.test/hook' },
        debounce_ms: 0,
      },
    ]);
    const event = taskEvent(
      'evt-smoke-1',
      'task.status_changed',
      { id: 7, status: 'done' },
      { to: 'done', source: 'user' },
    );

    const daemon = new WftRouterDaemon({
      config,
      store: fx.store,
      sseSource: sseSourceFromEvents([event]),
      handlers,
      logger: silentLogger(),
      apiBaseUrl: 'https://api.test',
      apiKey: 'wft_pat_x',
    });
    daemon.start();
    await daemon.wait();
    await daemon.stop();

    // Dispatched exactly once, for the emitted event, and the daemon exited
    // cleanly (cursor advance + clean shutdown are part of the same drain).
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.event_id).toBe('evt-smoke-1');
    expect(daemon.getExitCode()).toBe(0);
  });
});
