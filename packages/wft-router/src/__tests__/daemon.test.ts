/**
 * Integration tests for the wft-router main daemon (task #433).
 *
 * The daemon is the integration seam composing every prior slice:
 *
 *   SSE generator → parse → predicate → debounce → rate-limit
 *                 → Promise.allSettled fan-out → handler dispatch
 *
 * These tests drive the WHOLE pipeline against a MOCK SSE stream (an async
 * generator we fully control) plus a `:memory:` IdempotencyStore, and assert:
 *
 *   AC #1 — handler INVOCATION ORDER for a crafted multi-rule config + event
 *           stream, using a registry of recording fakes.
 *   AC #2 — Promise.allSettled fan-out: when one rule's handler REJECTS, the
 *           sibling rules that matched the same event still dispatch.
 *   AC #3 — start()/stop() lifecycle: start subscribes; stop drains +
 *           unsubscribes; stop is safe to call twice.
 *   AC #4 — the no-flag boot path (`createDaemon` / `runDaemon`) tails events
 *           end-to-end against a STUBBED API (injected fake SSE source +
 *           fake fetch) and asserts events flow through to handler dispatch.
 *
 * No real network, no real clock waits — debounce windows are pinned to 0
 * (immediate trailing edge) via per-rule `debounce_ms: 0` or an injected
 * Debouncer, and the SSE source is a hand-rolled generator.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TriggersConfig } from '../config/triggers-schema.js';
import { IdempotencyStore } from '../dispatch/index.js';
import { ExitCode, type SSEEvent } from '../sse/index.js';
import { WftRouterDaemon, mapSSEEvent, type DaemonDeps, type HandlerRegistry } from '../daemon.js';
import type { Handler, HandlerContext, HandlerOutcome } from '../handlers/index.js';
import { createDaemon, runDaemon } from '../bin/wft-router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A no-op pino-shaped logger that swallows everything. */
function silentLogger(): DaemonDeps['logger'] {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/** Build an in-memory idempotency store. */
function memStore(): IdempotencyStore {
  return new IdempotencyStore({ dbPath: ':memory:' });
}

/**
 * Build an SSE source factory from a fixed list of events. Yields each event
 * then returns a clean exit code. Honours the AbortSignal — if aborted
 * before exhaustion, it stops early.
 */
function sseSourceFromEvents(events: readonly SSEEvent[]): DaemonDeps['sseSource'] {
  return async function* gen(signal: AbortSignal) {
    for (const ev of events) {
      if (signal.aborted) break;
      yield ev;
      // Yield to the microtask queue so dispatch can interleave.
      await Promise.resolve();
    }
    return ExitCode.CleanShutdown;
  };
}

/**
 * A recording fake handler. Pushes a label onto `order` on invocation and
 * returns a `succeeded` outcome (or a custom one).
 */
function recordingHandler(
  order: string[],
  label: string,
  outcome: HandlerOutcome = { kind: 'succeeded' },
): Handler {
  return async (_ctx: HandlerContext): Promise<HandlerOutcome> => {
    order.push(label);
    return outcome;
  };
}

/** Wrap an SSE event JSON body for a task event. */
function taskEvent(
  id: string,
  eventType: string,
  taskFields: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): SSEEvent {
  const body = {
    eventType,
    timestamp: new Date(1_700_000_000_000).toISOString(),
    data: taskFields,
    metadata: metadata ?? { source: 'user' },
  };
  return { id, event: eventType, data: JSON.stringify(body) };
}

/** Minimal config with the given rules. */
function configWith(rules: TriggersConfig['rules']): TriggersConfig {
  return { version: 1, rules } as TriggersConfig;
}

// ---------------------------------------------------------------------------
// mapSSEEvent
// ---------------------------------------------------------------------------

describe('mapSSEEvent', () => {
  it('maps a well-formed task event to the predicate payload + identity', () => {
    const ev = taskEvent(
      '42',
      'task.status_changed',
      {
        id: 7,
        project_slug: 'demo',
        status: 'done',
        tags: ['x'],
        parent_task_id: 3,
        assignee: 'owner@example.com',
      },
      { from: 'in_progress', to: 'done', source: 'user' },
    );
    const mapped = mapSSEEvent(ev);
    expect(mapped).not.toBeNull();
    expect(mapped?.eventId).toBe('42');
    expect(mapped?.payload.type).toBe('task.status_changed');
    expect(mapped?.payload.task?.id).toBe(7);
    expect(mapped?.payload.task?.parent_task_id).toBe(3);
    expect(mapped?.payload.task?.assignee).toBe('owner@example.com');
    expect(mapped?.payload.metadata?.to).toBe('done');
    expect(mapped?.emittedAtMs).toBe(1_700_000_000_000);
  });

  it('returns null on malformed JSON', () => {
    expect(mapSSEEvent({ id: '1', event: 'task.created', data: '{not json' })).toBeNull();
  });

  it('returns null when there is no event id', () => {
    const ev = taskEvent('', 'task.created', { id: 1 });
    expect(mapSSEEvent({ ...ev, id: undefined })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC #1 — handler invocation order
// ---------------------------------------------------------------------------

describe('WftRouterDaemon — handler invocation order (AC #1)', () => {
  it('fires matched rules in config order for a multi-rule event stream', async () => {
    const order: string[] = [];
    const store = memStore();

    // Three rules: two match task.status_changed→done, one matches
    // task.created. Crafted so a single status_changed event fires rule A
    // then rule B (config order), and a later created event fires rule C.
    const config = configWith([
      {
        name: 'ruleA',
        on: 'task.status_changed',
        where: { to_status: 'done' },
        do: 'create_task_in_project',
        with: { project: 'p' },
      },
      {
        name: 'ruleB',
        on: 'task.status_changed',
        where: { to_status: 'done' },
        do: 'webhook_post',
        with: { url: 'https://example.test/h' },
      },
      {
        name: 'ruleC',
        on: 'task.created',
        where: {},
        do: 'shell_exec',
        with: { command: 'true' },
      },
    ] as unknown as TriggersConfig['rules']);

    const handlers: HandlerRegistry = {
      create_task_in_project: recordingHandler(order, 'ruleA'),
      webhook_post: recordingHandler(order, 'ruleB'),
      shell_exec: recordingHandler(order, 'ruleC'),
      agent_session_dispatch: recordingHandler(order, 'unused'),
    };

    const events: SSEEvent[] = [
      taskEvent(
        '1',
        'task.status_changed',
        { id: 100, status: 'done' },
        { to: 'done', source: 'user' },
      ),
      taskEvent('2', 'task.created', { id: 101, status: 'open' }),
    ];

    const daemon = new WftRouterDaemon({
      config,
      store,
      sseSource: sseSourceFromEvents(events),
      handlers,
      logger: silentLogger(),
      apiBaseUrl: 'https://api.test',
      apiKey: 'wft_pat_x',
      // Per-rule debounce_ms:0 is set below via config; pin window to 0 too.
      debouncer: undefined,
    });

    // Set every rule's debounce to 0 so the trailing edge fires immediately.
    for (const r of config.rules) (r as { debounce_ms?: number }).debounce_ms = 0;

    daemon.start();
    await daemon.wait();
    await daemon.stop();

    // ruleA before ruleB (config order for the same event); ruleC last.
    expect(order).toEqual(['ruleA', 'ruleB', 'ruleC']);
  });
});

// ---------------------------------------------------------------------------
// AC #2 — Promise.allSettled per-rule isolation
// ---------------------------------------------------------------------------

describe('WftRouterDaemon — Promise.allSettled fan-out (AC #2)', () => {
  it('isolates a rejecting rule so siblings still dispatch', async () => {
    const order: string[] = [];
    const store = memStore();

    const config = configWith([
      {
        name: 'boom',
        on: 'task.created',
        where: {},
        do: 'create_task_in_project',
        with: { project: 'p' },
        debounce_ms: 0,
      },
      {
        name: 'survivor',
        on: 'task.created',
        where: {},
        do: 'webhook_post',
        with: { url: 'https://example.test/h' },
        debounce_ms: 0,
      },
    ] as unknown as TriggersConfig['rules']);

    const throwing: Handler = async () => {
      order.push('boom');
      throw new Error('handler exploded');
    };

    const handlers: HandlerRegistry = {
      create_task_in_project: throwing,
      webhook_post: recordingHandler(order, 'survivor'),
      shell_exec: recordingHandler(order, 'unused'),
      agent_session_dispatch: recordingHandler(order, 'unused'),
    };

    const daemon = new WftRouterDaemon({
      config,
      store,
      sseSource: sseSourceFromEvents([taskEvent('1', 'task.created', { id: 1 })]),
      handlers,
      logger: silentLogger(),
      apiBaseUrl: 'https://api.test',
      apiKey: 'wft_pat_x',
    });

    daemon.start();
    await daemon.wait();
    await daemon.stop();

    expect(order).toContain('boom');
    expect(order).toContain('survivor');
  });
});

// ---------------------------------------------------------------------------
// AC #3 — lifecycle
// ---------------------------------------------------------------------------

describe('WftRouterDaemon — lifecycle (AC #3)', () => {
  it('start subscribes, stop drains, and stop is idempotent', async () => {
    const order: string[] = [];
    const store = memStore();
    const config = configWith([
      {
        name: 'r',
        on: 'task.created',
        where: {},
        do: 'shell_exec',
        with: { command: 'true' },
        debounce_ms: 0,
      },
    ] as unknown as TriggersConfig['rules']);

    const handlers: HandlerRegistry = {
      create_task_in_project: recordingHandler(order, 'x'),
      webhook_post: recordingHandler(order, 'x'),
      shell_exec: recordingHandler(order, 'r'),
      agent_session_dispatch: recordingHandler(order, 'x'),
    };

    const daemon = new WftRouterDaemon({
      config,
      store,
      sseSource: sseSourceFromEvents([taskEvent('1', 'task.created', { id: 1 })]),
      handlers,
      logger: silentLogger(),
      apiBaseUrl: 'https://api.test',
      apiKey: 'wft_pat_x',
    });

    daemon.start();
    // start() twice is a no-op.
    daemon.start();
    await daemon.wait();
    await daemon.stop();
    // stop() twice is safe.
    await daemon.stop();

    expect(order).toEqual(['r']);
    expect(daemon.getExitCode()).toBe(ExitCode.CleanShutdown);
  });

  it('stop() before start() is safe', async () => {
    const daemon = new WftRouterDaemon({
      config: configWith([
        {
          name: 'r',
          on: 'task.created',
          where: {},
          do: 'shell_exec',
          with: { command: 'true' },
        },
      ] as unknown as TriggersConfig['rules']),
      store: memStore(),
      sseSource: sseSourceFromEvents([]),
      handlers: {
        create_task_in_project: recordingHandler([], 'x'),
        webhook_post: recordingHandler([], 'x'),
        shell_exec: recordingHandler([], 'x'),
        agent_session_dispatch: recordingHandler([], 'x'),
      },
      logger: silentLogger(),
      apiBaseUrl: 'https://api.test',
      apiKey: 'wft_pat_x',
    });
    await expect(daemon.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC #4 — no-flag boot path end-to-end against a stubbed API
// ---------------------------------------------------------------------------

describe('createDaemon / runDaemon — no-flag boot (AC #4)', () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wft-router-daemon-'));
    configPath = join(tmp, 'triggers.yaml');
    writeFileSync(
      configPath,
      [
        'version: 1',
        'rules:',
        '  - name: file-a-task',
        '    on: task.status_changed',
        '    where:',
        '      to_status: done',
        '    do: webhook_post',
        '    with:',
        '      url: https://downstream.test/hook',
        '    debounce_ms: 0',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('boots from a config file and tails an injected SSE source through to handler dispatch', async () => {
    const order: string[] = [];
    const store = memStore();

    const events: SSEEvent[] = [
      taskEvent(
        '99',
        'task.status_changed',
        { id: 5, status: 'done' },
        { to: 'done', source: 'user' },
      ),
    ];

    const code = await runDaemon({
      configPath,
      endpoint: 'https://api.test',
      apiKey: 'wft_pat_boot',
      stateDir: tmp,
      store,
      sseSourceFactory: sseSourceFromEvents(events),
      handlers: {
        create_task_in_project: recordingHandler(order, 'create'),
        webhook_post: recordingHandler(order, 'webhook'),
        shell_exec: recordingHandler(order, 'shell'),
        agent_session_dispatch: recordingHandler(order, 'agent'),
      },
    });

    expect(order).toEqual(['webhook']);
    expect(code).toBe(ExitCode.CleanShutdown);
  });

  it('createDaemon rejects an invalid config with EX_CONFIG', async () => {
    const badPath = join(tmp, 'bad.yaml');
    writeFileSync(badPath, 'version: 2\nrules: []\n', 'utf8');
    await expect(
      createDaemon({
        configPath: badPath,
        endpoint: 'https://api.test',
        apiKey: 'k',
        stateDir: tmp,
      }),
    ).rejects.toMatchObject({ exitCode: 78 });
  });
});
