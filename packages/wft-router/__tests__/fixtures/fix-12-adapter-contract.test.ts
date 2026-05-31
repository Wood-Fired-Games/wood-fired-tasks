import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { agentSessionDispatch } from '../../src/handlers/agent-session-dispatch.js';
import type { HandlerContext } from '../../src/handlers/index.js';
import { MetricsRegistry } from '../../src/metrics.js';
import { WftRouterDaemon } from '../../src/daemon.js';
import {
  configWith,
  createFixtureStore,
  silentLogger,
  sseSourceFromEvents,
  taskEvent,
  type FixtureStore,
} from './harness.js';

// fix-12 / adapter-contract: a reference cross-platform adapter receives the
// expected stdin JSON shape, the expected argv pairs (including the addressing
// primitive `target=…` surviving intact), and a scrubbed env (no WFT_API_KEY,
// no foreign *_token_env). Non-zero adapter exits surface as a counted handler
// error WITHOUT crashing the router. The adapter is a Node script (runs on
// every OS) so the contract is asserted cross-platform on a single host.

/**
 * Write a reference adapter: a Node script the handler spawns by basename. It
 * captures stdin (the event JSON), reflects argv + a scrubbed view of its env
 * to a probe file, then exits with `exitCode`. Echoing to a file (not stdout)
 * keeps stdout free for the session-id channel.
 */
function writeAdapter(
  dir: string,
  name: string,
  probePath: string,
  exitCode: number,
): void {
  const script = `
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({
    argv: process.argv.slice(2),
    stdin,
    has_wft_api_key: process.env.WFT_API_KEY !== undefined,
    has_foreign_token: process.env.RULE_B_TOKEN_ENV !== undefined,
    own_token: process.env.RULE_A_TOKEN_ENV ?? null,
  }));
  if (${exitCode} === 0) { process.stdout.write('session-xyz\\n'); }
  process.exit(${exitCode});
});
`;
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
  chmodSync(file, 0o755);
}

describe('fix-12 / adapter-contract', () => {
  let fx: FixtureStore;
  let adaptersDir: string;
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, ORIGINAL);
    fx?.dispose();
    if (adaptersDir !== undefined) {
      rmSync(adaptersDir, { recursive: true, force: true });
    }
  });

  it('passes the expected stdin JSON, argv pairs (target= intact), and a scrubbed env', async () => {
    fx = createFixtureStore();
    adaptersDir = mkdtempSync(join(tmpdir(), 'wft-adapters-'));
    const probePath = join(adaptersDir, 'probe.json');
    // The adapter is invoked via Node so it runs on Linux/macOS/Windows alike.
    writeAdapter(adaptersDir, 'reflect', probePath, 0);

    process.env.RULE_A_TOKEN_ENV = 'a-secret';
    process.env.RULE_B_TOKEN_ENV = 'b-secret';
    process.env.WFT_API_KEY = 'master-key';

    const event = taskEvent('evt-adapter-1', 'task.status_changed', { id: 42, status: 'done' });

    const ctx: HandlerContext = {
      store: fx.store,
      logger: silentLogger(),
      identity: {
        rule_name: 'rule-a',
        event_id: 'evt-adapter-1',
        task_id: 42,
        to_status: 'done',
        emitted_at_ms: 1_700_000_000_000,
      },
      event,
      // The reflect adapter is a `#!/usr/bin/env node` script; the rendered
      // `target` is the addressing primitive that carries channel/session
      // identity through to the adapter as a single argv element.
      renderedWith: {
        adapter: 'reflect',
        prompt: 'epic {{task.id}} closed',
        target: 'my-project/session-7',
      },
      adaptersPath: [adaptersDir],
      tokenEnv: 'RULE_A_TOKEN_ENV',
    };

    const outcome = await agentSessionDispatch(ctx);
    expect(outcome.kind).toBe('succeeded');

    const probe = JSON.parse(await readProbe(probePath)) as {
      argv: string[];
      stdin: string;
      has_wft_api_key: boolean;
      has_foreign_token: boolean;
      own_token: string | null;
    };

    // ARGV: one `key=value` element per rendered with-key other than `adapter`.
    // The addressing primitive `target=…` survives intact as a single element
    // (never split on whitespace, never re-quoted), even though the value
    // contains a `/`. `adapter` itself is consumed, never passed as argv.
    expect(probe.argv).toContain('target=my-project/session-7');
    expect(probe.argv).toContain('prompt=epic {{task.id}} closed');
    expect(probe.argv).not.toContain('adapter=reflect');

    // STDIN: exactly `JSON.stringify(ctx.event)` — the event reaches the
    // adapter only via stdin, never spliced into argv.
    expect(probe.stdin).toBe(JSON.stringify(event));

    // ENV: scrubbed — own token survives, WFT_API_KEY + foreign token absent.
    expect(probe.own_token).toBe('a-secret');
    expect(probe.has_wft_api_key).toBe(false);
    expect(probe.has_foreign_token).toBe(false);

    // The PENDING→SUCCEEDED store row is the round-trip; the session id rides
    // alongside it on the additive outcome field.
    expect(outcome).toEqual({ kind: 'succeeded', sessionId: 'session-xyz' });
  });

  it('surfaces a non-zero adapter exit as a counted failure without crashing the router', async () => {
    fx = createFixtureStore();
    adaptersDir = mkdtempSync(join(tmpdir(), 'wft-adapters-'));
    const probePath = join(adaptersDir, 'probe.json');
    // Adapter exits non-zero → retryable failure, NOT a thrown handler.
    writeAdapter(adaptersDir, 'failing', probePath, 3);

    const metrics = new MetricsRegistry();
    const event = taskEvent(
      'evt-adapter-2',
      'task.status_changed',
      { id: 43, status: 'done' },
      { to: 'done', source: 'user' },
    );

    const daemon = new WftRouterDaemon({
      config: configWith([
        {
          name: 'dispatch-fail',
          on: 'task.status_changed',
          where: { to_status: 'done' },
          do: 'agent_session_dispatch',
          with: { adapter: 'failing', target: 'p/s' },
          debounce_ms: 0,
        },
      ]),
      store: fx.store,
      sseSource: sseSourceFromEvents([event]),
      handlers: { agent_session_dispatch: agentSessionDispatch } as never,
      logger: silentLogger(),
      apiBaseUrl: 'https://api.test',
      apiKey: 'wft_pat_x',
      adaptersPath: [adaptersDir],
      metrics,
    });

    // The router must NOT crash on the non-zero adapter exit.
    daemon.start();
    await daemon.wait();
    await daemon.stop();
    expect(daemon.getExitCode()).toBe(0);

    // The dead adapter produced a FAILED store row (one attempt, retryable),
    // and the failure is counted in the metrics registry. NOTE: a non-zero
    // exit returns a `failed` outcome (it does NOT throw), so the daemon counts
    // it on `wft_router_dispatched_total{status="failed"}` rather than the
    // throw-only `wft_router_handler_errors_total`. See the per-fixture report
    // for the AC-vs-design-doc reconciliation on the counter name. We assert on
    // the rendered Prometheus exposition text (the registry's only read API).
    const exposition = metrics.render();
    expect(exposition).toContain(
      'wft_router_dispatched_total{handler="agent_session_dispatch",status="failed"} 1',
    );
    // The throw-only handler-errors counter stayed at zero (no series emitted
    // for it) — the failure surfaced as a counted dispatch, not a crash.
    expect(exposition).not.toContain(
      'wft_router_handler_errors_total{handler="agent_session_dispatch"}',
    );

    // The store row is the durable proof: PENDING→FAILED for this one attempt.
    expect(
      fx.store.claim({
        rule_name: 'dispatch-fail',
        event_id: 'evt-adapter-2',
        rendered_with_json: '{}',
        task_id: null,
        to_status: null,
        emitted_at_ms: null,
      }),
    ).toEqual({ kind: 'ALREADY_DONE', status: 'FAILED' });
  });
});

/** Read the adapter's probe file (it is written synchronously on stdin end). */
async function readProbe(path: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  return readFileSync(path, 'utf8');
}
