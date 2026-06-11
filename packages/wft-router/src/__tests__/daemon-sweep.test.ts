/**
 * Cold-start sweep tests (task #1005) — acceptance criteria:
 *
 *   AC #1 — with an open matching backlog and a fresh router start, the
 *           target receives EXACTLY ONE kick (even when many tasks match).
 *   AC #2 — a second restart within the idempotency window sends NONE:
 *           the sweep re-runs, mints the SAME deterministic event id
 *           (`sweep:<rule>:<bucket>`), and the handler's `store.claim(...)`
 *           suppresses the dispatch.
 *   Plus  — `sweep_on_start` is OFF by default (no task-list query, no
 *           dispatch), the defaults-level opt-in applies to every rule, a
 *           rolled idempotency bucket kicks again, and the synthesized
 *           payload's `metadata.to` lets `to_status: open` rules match.
 *
 * The handler fakes here perform the REAL claim/complete protocol against a
 * shared `:memory:` IdempotencyStore — that is the layer the second-restart
 * suppression lives in, so a recording-only fake would prove nothing.
 */

import { describe, expect, it } from 'vitest';

import type { TriggersConfig } from '../config/triggers-schema.js';
import { IdempotencyStore } from '../dispatch/index.js';
import { ExitCode } from '../sse/index.js';
import { WftRouterDaemon, type DaemonDeps, type HandlerRegistry } from '../daemon.js';
import type { Handler, HandlerContext, HandlerOutcome } from '../handlers/index.js';

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

/** An SSE source that yields nothing and returns immediately. */
function emptySSESource(): DaemonDeps['sseSource'] {
  return async function* gen(_signal: AbortSignal) {
    return ExitCode.CleanShutdown;
  };
}

/** Record of claimed (kicked) vs suppressed dispatch event ids. */
interface KickRecord {
  kicks: string[];
  suppressed: string[];
}

/**
 * A fake handler that performs the REAL idempotency claim/complete protocol
 * (mirroring the production handlers): claim → if not CLAIMED, suppress
 * without side-effect; else record a "kick" and complete SUCCEEDED.
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
    const url = String(input);
    calls.push(url);
    const body = JSON.stringify({ data: rows, total: rows.length, limit: 500, offset: 0 });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** Build a daemon wired for sweep tests around a shared store + clock. */
function sweepDaemon(opts: {
  config: TriggersConfig;
  store: IdempotencyStore;
  record: KickRecord;
  fetchImpl: typeof fetch;
  now?: () => number;
}): WftRouterDaemon {
  return new WftRouterDaemon({
    config: opts.config,
    store: opts.store,
    sseSource: emptySSESource(),
    handlers: claimingRegistry(opts.record),
    logger: silentLogger(),
    apiBaseUrl: 'https://api.test',
    apiKey: 'wft_pat_sweep',
    fetchImpl: opts.fetchImpl,
    ...(opts.now !== undefined && { now: opts.now }),
  });
}

/** start → wait for the one-shot sweep → stop. */
async function runOnce(daemon: WftRouterDaemon): Promise<void> {
  daemon.start();
  await daemon.waitForSweep();
  await daemon.stop();
}

const OPEN_BACKLOG = [
  { id: 11, project_id: 5, status: 'open', tags: ['ready'], parent_task_id: null, assignee: null },
  { id: 12, project_id: 5, status: 'open', tags: ['ready'], parent_task_id: null, assignee: null },
  { id: 13, project_id: 9, status: 'open', tags: [], parent_task_id: null, assignee: null },
];

function sweepConfig(): TriggersConfig {
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
        sweep_on_start: true,
      },
    ],
  } as unknown as TriggersConfig;
}

// ---------------------------------------------------------------------------
// AC #1 + AC #2
// ---------------------------------------------------------------------------

describe('WftRouterDaemon — cold-start sweep (task #1005)', () => {
  it('AC #1: a fresh start over an open matching backlog kicks the target exactly once', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];
    const now = (): number => 10_000_000;

    const daemon = sweepDaemon({
      config: sweepConfig(),
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
      now,
    });
    await runOnce(daemon);

    // TWO tasks match the predicate, yet exactly ONE kick is synthesized.
    expect(record.kicks).toHaveLength(1);
    expect(record.suppressed).toHaveLength(0);
    // Deterministic sweep identity: sweep:<rule>:<bucket>, bucket =
    // floor(10_000_000 / 60_000) = 166.
    expect(record.kicks[0]).toBe('sweep:wake-on-backlog:166');
    // The query was narrowed server-side to the open backlog of project 5.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/api/v1/tasks?');
    expect(calls[0]).toContain('status=open');
    expect(calls[0]).toContain('project_id=5');
    store.close();
  });

  it('AC #2: a second restart within the idempotency window sends zero kicks', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];
    const now = (): number => 10_000_000;

    const first = sweepDaemon({
      config: sweepConfig(),
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
      now,
    });
    await runOnce(first);
    expect(record.kicks).toHaveLength(1);

    // "Restart": a brand-new daemon over the SAME durable store, inside the
    // same 60 s idempotency bucket.
    const second = sweepDaemon({
      config: sweepConfig(),
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
      now: () => 10_010_000, // +10 s — same absolute bucket 166 ([9.96M, 10.02M))
    });
    await runOnce(second);

    // The sweep RAN (a second task-list query happened) but the dispatch was
    // suppressed by the idempotency claim — still exactly one kick total.
    expect(calls).toHaveLength(2);
    expect(record.kicks).toHaveLength(1);
    expect(record.suppressed).toEqual(['sweep:wake-on-backlog:166']);
    store.close();
  });

  it('kicks again once the idempotency bucket rolls past the window', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];

    const first = sweepDaemon({
      config: sweepConfig(),
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
      now: () => 10_000_000,
    });
    await runOnce(first);

    const later = sweepDaemon({
      config: sweepConfig(),
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
      now: () => 10_000_000 + 60_000, // bucket 166 → 167
    });
    await runOnce(later);

    expect(record.kicks).toEqual(['sweep:wake-on-backlog:166', 'sweep:wake-on-backlog:167']);
    expect(record.suppressed).toHaveLength(0);
    store.close();
  });

  it('is OFF by default: no task-list query and no dispatch without the opt-in', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];

    const config = sweepConfig();
    delete (config.rules[0] as { sweep_on_start?: boolean }).sweep_on_start;

    const daemon = sweepDaemon({
      config,
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
    });
    await runOnce(daemon);

    expect(calls).toHaveLength(0);
    expect(record.kicks).toHaveLength(0);
    expect(record.suppressed).toHaveLength(0);
    store.close();
  });

  it('honours the defaults-level opt-in and matches to_status:open rules via synthesized metadata', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const calls: string[] = [];

    // The blocked→open wake rule from the domain brief: a live event only
    // arrives on the transition, so the pre-existing open backlog needs the
    // sweep's synthesized `metadata.to = open` to match.
    const config = {
      version: 1,
      defaults: { sweep_on_start: true, idempotency_window_s: 60 },
      rules: [
        {
          name: 'wake-on-unblock',
          on: 'task.status_changed',
          where: { project: 5, to_status: 'open' },
          do: 'agent_session_dispatch',
          with: { adapter: 'session-adapter' },
          debounce_ms: 0,
        },
      ],
    } as unknown as TriggersConfig;

    const daemon = sweepDaemon({
      config,
      store,
      record,
      fetchImpl: taskListFetch(OPEN_BACKLOG, calls),
      now: () => 10_000_000,
    });
    await runOnce(daemon);

    expect(record.kicks).toEqual(['sweep:wake-on-unblock:166']);
    store.close();
  });

  it('isolates a sweep transport failure: the daemon still starts and stops cleanly', async () => {
    const store = new IdempotencyStore({ dbPath: ':memory:' });
    const record: KickRecord = { kicks: [], suppressed: [] };
    const failingFetch = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const daemon = sweepDaemon({
      config: sweepConfig(),
      store,
      record,
      fetchImpl: failingFetch,
    });
    await runOnce(daemon);

    expect(record.kicks).toHaveLength(0);
    expect(daemon.getExitCode()).toBe(ExitCode.CleanShutdown);
    store.close();
  });
});
