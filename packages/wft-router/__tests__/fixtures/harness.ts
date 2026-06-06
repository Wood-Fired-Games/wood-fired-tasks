// Reusable verification-fixture harness for the wft-router event pipeline.
//
// This module is intentionally NOT a *.test.ts file: it holds shared helpers
// (in-process fake SSE source, tmp sqlite store, config/event/handler/logger
// builders) that the fix-N behavioural fixtures import. Fixture tasks 436
// (fix-1..5), 437 (fix-6..9) and 438 (fix-10..13) all build on these helpers,
// so keep additions backward-compatible.
//
// Determinism contract: no real network ports are bound (the SSE source is an
// async generator, not an HTTP server) and no real wall-clock sleeps are used.
// Timing-sensitive fixtures drive vi.useFakeTimers() instead. The pipeline is
// driven exclusively through the package's real exported surface (the daemon,
// the IdempotencyStore, the shell_exec handler) so fixtures exercise the
// production code paths rather than reimplementations.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IdempotencyStore } from '../../src/dispatch/index.js';
import { ExitCode, type SSEEvent } from '../../src/sse/index.js';
import type { DaemonDeps, HandlerRegistry } from '../../src/daemon.js';
import type { Handler, HandlerContext, HandlerOutcome } from '../../src/handlers/index.js';
import type { TriggersConfig } from '../../src/config/triggers-schema.js';

// ---------------------------------------------------------------------------
// SSE source
// ---------------------------------------------------------------------------

/**
 * Build an in-process SSE source factory from a fixed list of events. Yields
 * each event then returns a clean exit code. Honours the AbortSignal — if
 * aborted before exhaustion it stops early. No real socket is opened, so the
 * fixtures never bind a port and never race a real network read.
 */
export function sseSourceFromEvents(events: readonly SSEEvent[]): DaemonDeps['sseSource'] {
  return async function* gen(signal: AbortSignal) {
    for (const ev of events) {
      if (signal.aborted) {
        break;
      }
      yield ev;
      // Yield to the microtask queue so dispatch can interleave.
      await Promise.resolve();
    }
    return ExitCode.CleanShutdown;
  };
}

/**
 * Wrap an SSE event JSON body for a task event — mirrors the daemon's expected
 * envelope: `{ id, event, data: JSON.stringify({ eventType, timestamp, data,
 * metadata }) }`. `emittedAtMs` pins `timestamp` so idempotency minute-buckets
 * are deterministic across fixtures.
 */
export function taskEvent(
  id: string,
  eventType: string,
  taskFields: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  emittedAtMs = 1_700_000_000_000,
): SSEEvent {
  const body = {
    eventType,
    timestamp: new Date(emittedAtMs).toISOString(),
    data: taskFields,
    metadata: metadata ?? { source: 'user' },
  };
  return { id, event: eventType, data: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// Idempotency store (tmp sqlite under os.tmpdir, created + cleaned per test)
// ---------------------------------------------------------------------------

export interface FixtureStore {
  /** The tmp dir the sqlite file lives under. */
  dir: string;
  /** Absolute path to the sqlite file (stable across reopen). */
  dbPath: string;
  /** The currently-open store handle. */
  store: IdempotencyStore;
  /**
   * Close the current handle and open a fresh one on the SAME file — simulates
   * a daemon restart so crash/replay fixtures can prove persistence.
   */
  reopen: () => IdempotencyStore;
  /** Close every handle and remove the tmp dir. Call in afterEach. */
  dispose: () => void;
}

/**
 * Create an isolated tmp dir with a real file-backed IdempotencyStore (not
 * `:memory:`, so reopen() proves on-disk persistence for the crash fixtures).
 */
export function createFixtureStore(now?: () => number): FixtureStore {
  const dir = mkdtempSync(join(tmpdir(), 'wft-fixture-'));
  const dbPath = join(dir, 'idempotency.sqlite');
  const opened: IdempotencyStore[] = [];
  const open = (): IdempotencyStore => {
    const s = new IdempotencyStore(now ? { dbPath, now } : { dbPath });
    opened.push(s);
    return s;
  };
  const first = open();
  const handle: FixtureStore = {
    dir,
    dbPath,
    store: first,
    reopen() {
      handle.store = open();
      return handle.store;
    },
    dispose() {
      for (const s of opened) {
        s.close();
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface LogCall {
  obj: Record<string, unknown>;
  msg?: string;
}

/**
 * A pino-shaped logger (matching the daemon's `(obj, msg)` call convention)
 * that records every call so fixtures can assert on structured fields like
 * `coalesced_count` without coupling to a real logging backend.
 */
export type RecordingLogger = DaemonDeps['logger'] & {
  calls: { info: LogCall[]; warn: LogCall[]; error: LogCall[] };
};

export function createRecordingLogger(): RecordingLogger {
  const calls = { info: [] as LogCall[], warn: [] as LogCall[], error: [] as LogCall[] };
  return {
    calls,
    info(obj: Record<string, unknown>, msg?: string) {
      calls.info.push({ obj, msg });
    },
    warn(obj: Record<string, unknown>, msg?: string) {
      calls.warn.push({ obj, msg });
    },
    error(obj: Record<string, unknown>, msg?: string) {
      calls.error.push({ obj, msg });
    },
  };
}

/** A no-op pino-shaped logger that swallows everything. */
export function silentLogger(): DaemonDeps['logger'] {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

// ---------------------------------------------------------------------------
// Deterministic timer host (for the debounce fixture — mirrors the in-tree
// dispatch/__tests__/debounce.test.ts FakeTimerHost so timing never flakes).
// ---------------------------------------------------------------------------

interface ScheduledTimer {
  id: number;
  fn: () => void;
  ms: number;
  fired: boolean;
}

export interface FakeTimerHost {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Fire every still-pending timer, regardless of ms. */
  fireAll: () => void;
  /** Inspect outstanding timers. */
  pending: () => ScheduledTimer[];
}

export function makeFakeTimerHost(): FakeTimerHost {
  const timers = new Map<number, ScheduledTimer>();
  let nextId = 1;
  return {
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { id, fn, ms, fired: false });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    fireAll: () => {
      const snapshot = Array.from(timers.values());
      for (const t of snapshot) {
        if (timers.has(t.id) && !t.fired) {
          t.fired = true;
          timers.delete(t.id);
          t.fn();
        }
      }
    },
    pending: () => Array.from(timers.values()),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * A recording fake handler: records the `(rule_name, event_id)` it was invoked
 * with and returns `succeeded` (or a custom outcome). Used to observe whether —
 * and with which event — the pipeline dispatched.
 */
export interface RecordingHandler {
  handler: Handler;
  calls: Array<{ rule_name: string; event_id: string; ctx: HandlerContext }>;
}

export function recordingHandler(
  outcome: HandlerOutcome = { kind: 'succeeded' },
): RecordingHandler {
  const calls: RecordingHandler['calls'] = [];
  const handler: Handler = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
    calls.push({ rule_name: ctx.identity.rule_name, event_id: ctx.identity.event_id, ctx });
    return outcome;
  };
  return { handler, calls };
}

/**
 * Build a full HandlerRegistry where every action maps to the same recording
 * fake (so a fixture can assert "dispatched once" regardless of action type),
 * unless an override is supplied for a specific action.
 */
export function registryWith(overrides: Partial<HandlerRegistry> = {}): {
  handlers: HandlerRegistry;
  rec: RecordingHandler;
} {
  const rec = recordingHandler();
  const handlers: HandlerRegistry = {
    create_task_in_project: rec.handler,
    webhook_post: rec.handler,
    shell_exec: rec.handler,
    agent_session_dispatch: rec.handler,
    ...overrides,
  };
  return { handlers, rec };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Minimal valid config with the given rules (version pinned to 1). */
export function configWith(rules: unknown[]): TriggersConfig {
  return { version: 1, rules } as unknown as TriggersConfig;
}

export { IdempotencyStore };
export type { SSEEvent };
