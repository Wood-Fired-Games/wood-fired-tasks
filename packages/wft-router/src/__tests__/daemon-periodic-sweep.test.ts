/**
 * Periodic re-sweep tests (task #1035) — the deferred "on an interval" half
 * of the #1005 cold-start sweep. Acceptance criteria:
 *
 *   AC #1 — with `sweep_interval_s` set and an open matching backlog, a timer
 *           tick kicks the idle target EXACTLY ONCE per bucket window, with NO
 *           router restart and NO new SSE event (the SSE source is empty).
 *   AC #2 — a second tick inside the same idempotency bucket sends NONE (the
 *           sweep re-runs, mints the SAME `sweep:<rule>:<bucket>` id, and the
 *           handler's `store.claim(...)` suppresses); a tick after the bucket
 *           rolls kicks again.
 *   AC #3 — absent / non-positive `sweep_interval_s` = zero behavior change:
 *           no timer is scheduled, no task-list query, no dispatch.
 *   AC #4 — a tick error logs WARN and the timer keeps firing; per-rule timers
 *           are isolated (one rule's failure never stalls another's).
 *   AC #5 — `stop()` clears the interval timer; a tick captured before stop is
 *           a no-op afterwards.
 *
 * Determinism: the interval scheduler is INJECTED (a fake that captures each
 * tick callback) and the clock is INJECTED (a mutable `clock` the test drives
 * the sweep buckets with). The two advance under explicit test control — no
 * real timers, no wall-clock races. The handler fakes run the REAL
 * claim/complete protocol against a shared `:memory:` IdempotencyStore, the
 * layer the in-window suppression actually lives in.
 */

import { describe, expect, it } from 'vitest';

import type { TriggersConfig } from '../config/triggers-schema.js';
import { IdempotencyStore } from '../dispatch/index.js';
import { ExitCode } from '../sse/index.js';
import {
  WftRouterDaemon,
  type DaemonDeps,
  type HandlerRegistry,
  type IntervalHandle,
  type IntervalScheduler,
} from '../daemon.js';
import type { Handler, HandlerContext, HandlerOutcome } from '../handlers/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A recording logger that captures WARN events for assertions. */
function recordingLogger(): DaemonDeps['logger'] & { warns: Record<string, unknown>[] } {
  const warns: Record<string, unknown>[] = [];
  return {
    warns,
    info: () => undefined,
    warn: (obj: Record<string, unknown>) => {
      warns.push(obj);
    },
    error: () => undefined,
  };
}

/** An SSE source that yields nothing and returns immediately. */
function emptySSESource(): DaemonDeps['sseSource'] {
  return async function* gen(_signal: AbortSignal) {
    return ExitCode.CleanShutdown;
  };
}

/** A fake interval scheduler that captures each tick callback for manual firing. */
interface FakeScheduler {
  scheduler: IntervalScheduler;
  /** Every `set()` call, in order: the callback, its period, and its handle. */
  ticks: { cb: () => void; ms: number; handle: IntervalHandle }[];
  /** Handles passed to `clear()`, in order. */
  cleared: IntervalHandle[];
  /** Invoke every still-live (un-cleared) tick callback once. */
  tickLive(): void;
}

function fakeScheduler(): FakeScheduler {
  const ticks: FakeScheduler['ticks'] = [];
  const cleared: IntervalHandle[] = [];
  const live = new Map<number, () => void>();
  let nextHandle = 1;
  const scheduler: IntervalScheduler = {
    set(cb: () => void, ms: number): IntervalHandle {
      const handle = nextHandle;
      nextHandle += 1;
      ticks.push({ cb, ms, handle });
      live.set(handle, cb);
      return handle;
    },
    clear(handle: IntervalHandle): void {
      cleared.push(handle);
      live.delete(handle as number);
    },
  };
  return {
    scheduler,
    ticks,
    cleared,
    tickLive(): void {
      for (const cb of live.values()) {
        cb();
      }
    },
  };
}

/** Record of claimed (kicked) vs suppressed dispatch event ids. */
interface KickRecord {
  kicks: string[];
  suppressed: string[];
}

/**
 * A fake handler running the REAL idempotency claim/complete protocol:
 * claim → if not CLAIMED, suppress; else record a "kick" and complete.
 */
function claimingHandler(record: KickRecord): Handler {
  return async (ctx: HandlerContext): Promise<HandlerOutcome> => {
    const claim = ctx.store.claim({
      rule_name: ctx.identity.rule_name,
      event_id: ctx.identity.event_id,
      rendered_with_json: '{}',
      task_id: ctx.identity.task_id,
      to_status: ctx.identity.to_status,
      emitted_at_ms: ctx.identity.emitted_at_ms,
    });
    if (claim.kind !== 'CLAIMED') {
      record.suppressed.push(ctx.identity.event_id);
      return {
        kind: 'suppressed',
        reason: claim.kind === 'ALREADY_PENDING' ? 'already_pending' : 'already_done',
      };
    }
    record.kicks.push(ctx.identity.event_id);
    ctx.store.complete(ctx.identity.rule_name, ctx.identity.event_id, 'SUCCEEDED');
    return { kind: 'succeeded', sessionId: 'session-under-test' };
  };
}

/** Registry routing every handler name to the same claiming fake. */
function claimingRegistry(record: KickRecord): HandlerRegistry {
  const h = claimingHandler(record);
  return {
    create_task_in_project: h,
    webhook_post: h,
    shell_exec: h,
    agent_session_dispatch: h,
  };
}

/** A fake fetch serving `GET /api/v1/tasks` with a fixed row set. */
function taskListFetch(rows: readonly Record<string, unknown>[], calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    const body = JSON.stringify({ data: rows, total: rows.length, limit: 500, offset: 0 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const OPEN_BACKLOG = [
  { id: 11, project_id: 5, status: 'open', tags: ['ready'], parent_task_id: null, assignee: null },
  { id: 12, project_id: 5, status: 'open', tags: ['ready'], parent_task_id: null, assignee: null },
  { id: 13, project_id: 9, status: 'open', tags: [], parent_task_id: null, assignee: null },
];

/** Config: one rule on a 30 s re-sweep interval, 60 s idempotency window. */
function periodicConfig(): TriggersConfig {
  return {
    version: 1,
    rules: [
      {
        name: 'wake-on-backlog',
        on: 'task.created',
        where: { project: 5, tags_contains_any: ['ready'] },
        do: 'agent_session_dispatch',
        with: { adapter: 'session-adapter' },
        debounce_ms: 0,
        idempotency_window_s: 60,
        sweep_interval_s: 30,
      },
    ],
  } as unknown as TriggersConfig;
}

/** Build a daemon wired for periodic-sweep tests. */
function periodicDaemon(opts: {
  config: TriggersConfig;
  store: IdempotencyStore;
  record: KickRecord;
  fetchImpl: typeof fetch;
  scheduler: IntervalScheduler;
  now: () => number;
  logger?: DaemonDeps['logger'];
}): WftRouterDaemon {
  return new WftRouterDaemon({
    config: opts.config,
    store: opts.store,
    sseSource: emptySSESource(),
    handlers: claimingRegistry(opts.record),
    logger: opts.logger ?? recordingLogger(),
    apiBaseUrl: 'https://api.test',
    apiKey: 'wft_pat_sweep',
    fetchImpl: opts.fetchImpl,
    intervalScheduler: opts.scheduler,
    now: opts.now,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WftRouterDaemon — periodic re-sweep (task #1035)', () => {
  it('AC #1: a timer tick over an open backlog kicks the idle target exactly once — no restart, no SSE event', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];
    const sched = fakeScheduler();
    let clock = 10_000_000;

    const daemon = periodicDaemon({
      config: periodicConfig(),
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
      scheduler: sched.scheduler,
      now: () => clock,
    });
    daemon.start();
    await daemon.waitForSweep(); // no sweep_on_start → no-op

    // The timer is armed at the configured 30 s period, but NOTHING has fired
    // yet: no startup sweep, no SSE event, no kick.
    expect(sched.ticks).toHaveLength(1);
    expect(sched.ticks[0]?.ms).toBe(30_000);
    expect(record.kicks).toHaveLength(0);
    expect(calls).toHaveLength(0);

    // One tick: two tasks match, exactly ONE kick is synthesized.
    sched.tickLive();
    await daemon.settle();

    expect(record.kicks).toEqual(['sweep:wake-on-backlog:166']); // floor(10_000_000 / 60_000)
    expect(record.suppressed).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/api/v1/tasks?');
    expect(calls[0]).toContain('status=open');
    expect(calls[0]).toContain('project_id=5');

    await daemon.stop();
    store.close();
  });

  it('AC #2: a tick within the same bucket suppresses; a tick past the window kicks again', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];
    const sched = fakeScheduler();
    let clock = 10_000_000;

    const daemon = periodicDaemon({
      config: periodicConfig(),
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
      scheduler: sched.scheduler,
      now: () => clock,
    });
    daemon.start();
    await daemon.waitForSweep();

    // Tick 1 (bucket 166): one kick.
    sched.tickLive();
    await daemon.settle();
    expect(record.kicks).toEqual(['sweep:wake-on-backlog:166']);

    // Tick 2, +10 s — still inside bucket 166 ([9.96M, 10.02M)): the sweep
    // RE-RUNS (a second query) but the dispatch is SUPPRESSED at claim time.
    clock = 10_010_000;
    sched.tickLive();
    await daemon.settle();
    expect(record.kicks).toHaveLength(1);
    expect(record.suppressed).toEqual(['sweep:wake-on-backlog:166']);
    expect(calls).toHaveLength(2);

    // Tick 3, bucket rolls 166 → 167: a fresh id, so it kicks again.
    clock = 10_000_000 + 60_000;
    sched.tickLive();
    await daemon.settle();
    expect(record.kicks).toEqual(['sweep:wake-on-backlog:166', 'sweep:wake-on-backlog:167']);

    await daemon.stop();
    store.close();
  });

  it('AC #3: absent sweep_interval_s schedules no timer and changes nothing', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];
    const sched = fakeScheduler();

    const config = periodicConfig();
    delete (config.rules[0] as { sweep_interval_s?: number }).sweep_interval_s;

    const daemon = periodicDaemon({
      config,
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
      scheduler: sched.scheduler,
      now: () => 10_000_000,
    });
    daemon.start();
    await daemon.waitForSweep();

    expect(sched.ticks).toHaveLength(0);
    sched.tickLive(); // nothing live to fire
    await daemon.settle();
    expect(record.kicks).toHaveLength(0);
    expect(calls).toHaveLength(0);

    await daemon.stop();
    store.close();
  });

  it('honours a defaults-level sweep_interval_s when the rule omits its own', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];
    const sched = fakeScheduler();

    const config = {
      version: 1,
      defaults: { sweep_interval_s: 45, idempotency_window_s: 60 },
      rules: [
        {
          name: 'wake-on-backlog',
          on: 'task.created',
          where: { project: 5, tags_contains_any: ['ready'] },
          do: 'agent_session_dispatch',
          with: { adapter: 'session-adapter' },
          debounce_ms: 0,
        },
      ],
    } as unknown as TriggersConfig;

    const daemon = periodicDaemon({
      config,
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
      scheduler: sched.scheduler,
      now: () => 10_000_000,
    });
    daemon.start();
    await daemon.waitForSweep();

    expect(sched.ticks).toHaveLength(1);
    expect(sched.ticks[0]?.ms).toBe(45_000);

    sched.tickLive();
    await daemon.settle();
    expect(record.kicks).toEqual(['sweep:wake-on-backlog:166']);

    await daemon.stop();
    store.close();
  });

  it('AC #4: a tick failure logs WARN and the timer keeps firing (recovers on the next tick)', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];
    const sched = fakeScheduler();
    const logger = recordingLogger();
    let failNext = true;

    const flakyFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      calls.push(String(input));
      if (failNext) {
        failNext = false;
        throw new Error('connection refused');
      }
      const body = JSON.stringify({ data: OPEN_BACKLOG, total: OPEN_BACKLOG.length });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const daemon = periodicDaemon({
      config: periodicConfig(),
      store,
      record,
      fetchImpl: flakyFetch,
      scheduler: sched.scheduler,
      now: () => 10_000_000,
      logger,
    });
    daemon.start();
    await daemon.waitForSweep();

    // Tick 1: the query throws — isolated to a WARN, no kick, timer NOT cleared.
    sched.tickLive();
    await daemon.settle();
    expect(record.kicks).toHaveLength(0);
    expect(logger.warns.some((w) => w['rule_name'] === 'wake-on-backlog')).toBe(true);
    expect(sched.cleared).toHaveLength(0);

    // Tick 2: the same live timer fires again and now succeeds.
    sched.tickLive();
    await daemon.settle();
    expect(record.kicks).toEqual(['sweep:wake-on-backlog:166']);

    await daemon.stop();
    store.close();
  });

  it('isolates per-rule timers: one rule failing does not stall another rule kicking', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];
    const sched = fakeScheduler();

    // A fetch that throws for project 5's query but serves project 9's.
    const splitFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.includes('project_id=5')) {
        throw new Error('connection refused');
      }
      const rows = OPEN_BACKLOG.filter((r) => r.project_id === 9).map((r) => ({
        ...r,
        tags: ['ready'],
      }));
      const body = JSON.stringify({ data: rows, total: rows.length });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const config = {
      version: 1,
      rules: [
        {
          name: 'rule-p5-fails',
          on: 'task.created',
          where: { project: 5, tags_contains_any: ['ready'] },
          do: 'agent_session_dispatch',
          with: { adapter: 'session-adapter' },
          debounce_ms: 0,
          idempotency_window_s: 60,
          sweep_interval_s: 30,
        },
        {
          name: 'rule-p9-ok',
          on: 'task.created',
          where: { project: 9, tags_contains_any: ['ready'] },
          do: 'agent_session_dispatch',
          with: { adapter: 'session-adapter' },
          debounce_ms: 0,
          idempotency_window_s: 60,
          sweep_interval_s: 30,
        },
      ],
    } as unknown as TriggersConfig;

    const daemon = periodicDaemon({
      config,
      store,
      record,
      fetchImpl: splitFetch,
      scheduler: sched.scheduler,
      now: () => 10_000_000,
    });
    daemon.start();
    await daemon.waitForSweep();

    // Two independent timers, one per rule.
    expect(sched.ticks).toHaveLength(2);

    sched.tickLive();
    await daemon.settle();

    // The failing rule kicked nobody; the healthy rule still kicked.
    expect(record.kicks).toEqual(['sweep:rule-p9-ok:166']);

    await daemon.stop();
    store.close();
  });

  it('AC #5: stop() clears the interval timer and a captured tick becomes a no-op', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];
    const sched = fakeScheduler();

    const daemon = periodicDaemon({
      config: periodicConfig(),
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
      scheduler: sched.scheduler,
      now: () => 10_000_000,
    });
    daemon.start();
    await daemon.waitForSweep();
    expect(sched.ticks).toHaveLength(1);
    expect(sched.cleared).toHaveLength(0);

    await daemon.stop();

    // The timer handle was handed to clear() exactly once.
    expect(sched.cleared).toEqual([sched.ticks[0]?.handle]);

    // A tick callback captured before stop fires into a stopped daemon: the
    // phase guard makes it a no-op — no query, no kick.
    sched.ticks[0]?.cb();
    await daemon.settle();
    expect(calls).toHaveLength(0);
    expect(record.kicks).toHaveLength(0);

    store.close();
  });
});
