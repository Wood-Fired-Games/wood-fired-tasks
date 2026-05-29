import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { TriggersConfigSchema } from '../../src/config/triggers-schema.js';
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

// fix-11 / vendor-neutrality: a triggers config using ONLY the three core
// handlers (create_task_in_project, webhook_post, shell_exec) parses,
// dispatches, and round-trips end-to-end; and the shipped core handler code
// paths contain no vendor strings. The green-path is asserted with the real
// schema + the real daemon; the "no vendor strings" clause is asserted by
// invoking the authoritative `check:vendor-neutrality` gate (not a
// reimplemented scanner) and requiring it to PASS.

describe('fix-11 / vendor-neutrality', () => {
  let fx: FixtureStore;

  afterEach(() => {
    fx?.dispose();
  });

  it('parses + round-trips a config built from only the three core handlers', async () => {
    fx = createFixtureStore();

    // A config exercising each of the three core action verbs once. Parsing it
    // through the REAL schema proves the core-only surface is valid config.
    const parsed = TriggersConfigSchema.parse({
      version: 1,
      rules: [
        {
          name: 'mirror',
          on: 'task.status_changed',
          where: { to_status: 'done' },
          do: 'create_task_in_project',
          with: { project_slug: 'downstream', title: 'done' },
          debounce_ms: 0,
        },
        {
          name: 'notify',
          on: 'task.status_changed',
          where: { to_status: 'done' },
          do: 'webhook_post',
          with: { url: 'https://downstream.test/hook' },
          debounce_ms: 0,
        },
        {
          name: 'run',
          on: 'task.status_changed',
          where: { to_status: 'done' },
          do: 'shell_exec',
          with: { command: 'true' },
          debounce_ms: 0,
        },
      ],
    });

    // Drive the parsed config through the real daemon with recording handlers
    // so we assert end-to-end dispatch, not just that the config validated.
    const { handlers, rec } = registryWith();
    const event = taskEvent(
      'evt-neutral-1',
      'task.status_changed',
      { id: 11, status: 'done' },
      { to: 'done', source: 'user' },
    );

    const daemon = new WftRouterDaemon({
      config: configWith(parsed.rules),
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

    // All three core-handler rules matched the one event and dispatched.
    expect(rec.calls).toHaveLength(3);
    expect(new Set(rec.calls.map((c) => c.rule_name))).toEqual(
      new Set(['mirror', 'notify', 'run']),
    );
    expect(daemon.getExitCode()).toBe(0);
  });

  it('the authoritative vendor-neutrality gate passes on the shipped code paths', () => {
    // Run the SAME gate CI runs (do NOT reimplement the scanner). A PASS means
    // no AI-vendor / CI-provider / chat-product string is hard-coded in any
    // non-exempt core code path. A non-zero exit throws and fails this test.
    const out = execFileSync('node', ['scripts/vendor-neutrality/check.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(out).toContain('vendor-neutrality gate PASS');
  });
});
