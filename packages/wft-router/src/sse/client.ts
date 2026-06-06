/**
 * Fetch-based SSE client for the wft-router.
 *
 * This module is the FIRST box of the wft-router pipeline (see
 * docs/event-router-design.md §"Architecture", lines 350-369):
 *
 *   SSE (Bearer/X-API-Key, Last-Event-Id resume) → wft-router → handlers
 *
 * Responsibilities owned here:
 *   - Open a long-lived `GET /api/v1/events` connection (with optional
 *     `?event_types=` filter) using global `fetch` + global
 *     `ReadableStream` (Node ≥22). No `eventsource` or `node-fetch` dep.
 *   - Apply the auth-header rule from `auth.ts` (mirrors
 *     `src/mcp/remote/rest-client.ts:80-84`).
 *   - Parse the SSE byte stream incrementally via `createSSEParser()`
 *     and yield events to the caller as an async generator.
 *   - On stream end or any non-fatal failure, reconnect with exponential
 *     backoff + jitter (max 60 s per spec §"Backoff + reachability").
 *   - Track `Last-Event-Id` across reconnects (best-effort resume; bounded
 *     by the SSE server's retention window — spec §"Resume + cursor"). WFT-NEUTRALITY-EXEMPT-LINE
 *   - HTTP 410 on reconnect → clear cursor, log `cursor_gap=...`, resume WFT-NEUTRALITY-EXEMPT-LINE
 *     from head (immediate, no sleep).
 *   - 401/403 on initial handshake → exit code 3 (auth_failed startup).
 *     A later 401/403 (revoked key) is also fatal-3 with a clearly
 *     labelled log line — the spec only enumerates the startup case, but
 *     no other exit code fits a credentials problem.
 *   - Watchdog: if the endpoint has been unreachable for ≥ 15 min, return
 *     exit code 4 so an orchestrator (systemd / Docker / launchd /
 *     Windows Service Manager) can restart the daemon.
 *
 * Dependency-injection design — every external surface (`fetch`, `clock`,
 * `randomFn`, `logger`) is injectable so unit tests can pin them. The
 * "default-from-process" wrappers live alongside as thin convenience
 * factories (`defaultClock`, `defaultLogger`).
 *
 * NOTE — this module deliberately does NOT consume the events: the daemon
 * assembly (events → predicate → debounce → idempotency → handlers) is a
 * downstream task. Here we only export `runSSEClient` as an async
 * generator that yields `SSEEvent`s and returns the daemon's exit code.
 */

import { authHeader } from './auth.js';
import { createSSEParser, type SSEEvent } from './parser.js';

/**
 * Exit codes per docs/event-router-design.md §"Contract", lines 113-119.
 *
 * Only the codes this module emits are listed here:
 *   - 0  clean shutdown (SIGTERM / SIGINT via the AbortSignal)
 *   - 3  auth failed (401/403 from the events endpoint)
 *   - 4  endpoint unreachable after ≥ 15 min of backoff
 *
 * Plain (non-const) `enum` so the values are importable at runtime for
 * test assertions — `const enum` only inlines literals and breaks under
 * `isolatedModules`.
 */
export enum ExitCode {
  CleanShutdown = 0,
  AuthFailedStartup = 3,
  EndpointUnreachable = 4,
}

/**
 * Injectable clock seam. The watchdog math depends on `now()` deltas and
 * the backoff loop sleeps on `sleep()`; tests pin both to make the
 * 15-minute watchdog finish in <1 s wall-clock.
 */
export interface SSEClock {
  /** Monotonic-enough wall clock; tests can advance it deterministically. */
  now(): number;
  /**
   * Resolve after `ms` milliseconds, or earlier if `signal` aborts.
   * Resolves to `true` when aborted, `false` on natural elapse.
   */
  sleep(ms: number, signal: AbortSignal): Promise<boolean>;
}

/**
 * Structured-log seam. Defaults to `console.warn` / `console.info` so the
 * binary works out of the box; production wiring will replace this with a
 * pino instance.
 */
export interface SSELogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
}

export interface SSEClientOptions {
  /** Base endpoint, e.g. `http://localhost:3000`. The `/api/v1/events` path is appended. */
  endpoint: string;
  /** API key — `wft_pat_...` for PAT, anything else treated as legacy. */
  apiKey: string;
  /** Optional `?event_types=` filter (comma-joined on the wire). */
  eventTypes?: readonly string[];
  /** Backoff ceiling; per spec, 60 s. */
  maxBackoffMs?: number;
  /** Watchdog deadline; per spec, 15 min. */
  unreachableLimitMs?: number;
  /** Test seam — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to real wall clock. */
  clock?: SSEClock;
  /** Test seam — defaults to `Math.random`. */
  randomFn?: () => number;
  /** Test seam — defaults to a `console`-backed logger. */
  logger?: SSELogger;
  /**
   * Idle/read timeout: if NO frame (event, comment, OR server keep-alive
   * ping) arrives within this many ms, treat the connection as dead and
   * reconnect. This is the half-open-socket guard — without it a silently
   * dropped TCP connection blocks `reader.read()` forever and the
   * unreachability watchdog never arms (it only counts connection
   * FAILURES, not a wedged read). Set to 0 to disable. Default 90 s
   * (the server pings well inside that, so 90 s = a few missed pings).
   */
  idleTimeoutMs?: number;
}

/** Default per-spec ceilings, exported for the daemon assembly to reuse. */
export const DEFAULT_MAX_BACKOFF_MS = 60_000;
export const DEFAULT_UNREACHABLE_LIMIT_MS = 15 * 60_000;
/**
 * Default idle/read timeout. The SSE server emits keep-alive pings on a far
 * shorter cadence, so 90 s without a single frame means the stream is dead
 * (half-open socket) — reconnect rather than wedge forever.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

const EVENTS_PATH = '/api/v1/events';

/** Sentinel rejection used by {@link readWithIdleTimeout} on idle expiry. */
class IdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`idle timeout: no SSE frame within ${String(ms)}ms`);
    this.name = 'IdleTimeoutError';
  }
}

/**
 * Race a single `reader.read()` against a wall-clock idle timer. Resolves
 * with the read result if a chunk (or stream-end) arrives first; rejects
 * with {@link IdleTimeoutError} if `idleMs` elapses with no frame. A
 * non-positive `idleMs` disables the guard (plain `reader.read()`).
 *
 * Uses a real `setTimeout` deliberately — NOT the injected test clock — so
 * the guard reflects true wall-clock silence on the live socket and does
 * not interfere with fake-clock unit tests (whose streams resolve reads
 * promptly, well inside the default 90 s).
 */
function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (idleMs <= 0) return reader.read();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new IdleTimeoutError(idleMs)), idleMs);
    reader.read().then(
      (chunk) => {
        clearTimeout(timer);
        resolve(chunk);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Build the wall-clock + setTimeout-backed clock the daemon uses in
 * production. Isolated so tests never instantiate it.
 */
export function defaultClock(): SSEClock {
  return {
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise<boolean>((resolve) => {
        if (signal.aborted) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve(false);
        }, ms);
        const onAbort = (): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(true);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
  };
}

/** Default console-backed logger. Used when callers don't supply one. */
export function defaultLogger(): SSELogger {
  return {
    warn: (msg, fields) =>
      // eslint-disable-next-line no-console -- structured log fallback before pino wiring lands
      console.warn(JSON.stringify({ level: 'warn', msg, ...(fields ?? {}) })),
    info: (msg, fields) =>
      // eslint-disable-next-line no-console -- structured log fallback before pino wiring lands
      console.warn(JSON.stringify({ level: 'info', msg, ...(fields ?? {}) })),
  };
}

/**
 * Build the full URL to hit, applying the `?event_types=` filter when
 * `eventTypes` is non-empty. Uses the `URL` class so escaping is
 * predictable.
 */
function buildUrl(endpoint: string, eventTypes: readonly string[] | undefined): string {
  const trimmed = endpoint.replace(/\/$/, '');
  const url = new URL(`${trimmed}${EVENTS_PATH}`);
  if (eventTypes && eventTypes.length > 0) {
    url.searchParams.set('event_types', eventTypes.join(','));
  }
  return url.toString();
}

/**
 * Compute the next backoff delay in ms.
 *
 * Formula: `min(maxBackoffMs, 1000 * 2^(attempts-1)) * (0.5 + r * 0.5)`
 * where `r ∈ [0, 1)` from `randomFn`. Jitter range is `[0.5, 1.0)` of the
 * uncapped exponential, which keeps the floor of any single sleep above
 * 500 ms and avoids the thundering-herd anti-pattern.
 *
 * `attempts` is 1-indexed (first failed attempt → `2^0 = 1` s base).
 */
export function computeBackoffMs(
  attempts: number,
  maxBackoffMs: number,
  randomFn: () => number,
): number {
  const expBase = 1000 * 2 ** (attempts - 1);
  const capped = Math.min(maxBackoffMs, expBase);
  const jitter = 0.5 + randomFn() * 0.5;
  return Math.floor(capped * jitter);
}

/**
 * Outcome of a single connection attempt — used to decide whether the
 * run loop should reconnect, gap-resume, or exit.
 */
type ConnectionResult =
  | { kind: 'closed_clean' }
  | { kind: 'auth_failed'; status: number }
  | { kind: 'gap'; status: number }
  | { kind: 'network_error'; message: string };

/**
 * Drive a single HTTP connection: open, stream, parse, yield. An async
 * generator that `yield`s each parsed {@link SSEEvent} the instant it is
 * decoded off the wire, and `return`s a {@link ConnectionResult} when the
 * stream ends (cleanly or not).
 *
 * This MUST yield incrementally: an SSE connection is long-lived and never
 * closes on its own, so buffering events until the connection ends would
 * mean a healthy stream delivers nothing in real time (the consumer would
 * only ever see events when the socket drops). Delegating with `yield*` in
 * {@link runSSEClient} flows each event straight through to the daemon.
 */
async function* runOneConnection(
  url: string,
  apiKey: string,
  lastEventId: string | undefined,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  idleTimeoutMs: number,
): AsyncGenerator<SSEEvent, ConnectionResult> {
  const header = authHeader(apiKey);
  const headers: Record<string, string> = {
    [header.name]: header.value,
    Accept: 'text/event-stream',
  };
  if (lastEventId !== undefined) {
    headers['Last-Event-Id'] = lastEventId;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers, signal });
  } catch (err) {
    if (signal.aborted) return { kind: 'closed_clean' };
    return { kind: 'network_error', message: errMessage(err) };
  }

  if (response.status === 401 || response.status === 403) {
    // Drain body to free socket; ignore errors.
    await safeCancel(response);
    return { kind: 'auth_failed', status: response.status };
  }
  if (response.status === 410) {
    await safeCancel(response);
    return { kind: 'gap', status: response.status };
  }
  if (!response.ok || response.body === null) {
    await safeCancel(response);
    return {
      kind: 'network_error',
      message: `HTTP ${String(response.status)}${response.body === null ? ' (no body)' : ''}`,
    };
  }

  const parser = createSSEParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await readWithIdleTimeout(reader, idleTimeoutMs);
      } catch (err) {
        if (signal.aborted) return { kind: 'closed_clean' };
        // Idle timeout OR a read error: the stream is dead (possibly a
        // half-open socket). Cancel the reader to free the socket and
        // report a failure so the run loop reconnects + arms the watchdog.
        try {
          await reader.cancel();
        } catch {
          /* already torn down */
        }
        return { kind: 'network_error', message: errMessage(err) };
      }
      if (chunk.done) {
        // Flush any final pending event then return.
        for (const event of parser.flush()) yield event;
        return { kind: 'closed_clean' };
      }
      const text = decoder.decode(chunk.value, { stream: true });
      for (const event of parser.feed(text)) yield event;
    }
  } finally {
    // Best-effort: release the reader so the socket can recycle.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function safeCancel(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* swallow */
  }
}

/**
 * Run loop. Yields events forever until aborted or a fatal-error condition
 * is hit. The return value is the daemon-level exit code.
 *
 * The generator pattern lets the consumer (the daemon assembly, task
 * #433) pull events at its own pace without this module knowing anything
 * about the predicate / debounce / idempotency / handler stages.
 */
export async function* runSSEClient(
  opts: SSEClientOptions,
  signal: AbortSignal,
): AsyncGenerator<SSEEvent, ExitCode> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const clock = opts.clock ?? defaultClock();
  const randomFn = opts.randomFn ?? Math.random;
  const logger = opts.logger ?? defaultLogger();
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const unreachableLimitMs = opts.unreachableLimitMs ?? DEFAULT_UNREACHABLE_LIMIT_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const url = buildUrl(opts.endpoint, opts.eventTypes);

  let lastEventId: string | undefined;
  let firstFailureAt: number | null = null;
  let attempts = 0;
  /** True once at least one event has been yielded — distinguishes "never connected" from "running and lost the connection". */
  let everYielded = false;

  while (!signal.aborted) {
    /**
     * Count of events this connection delivered. We pull each event from the
     * inner generator and yield it onward IN REAL TIME — no buffering until
     * the connection closes. A long-lived SSE stream never closes on its
     * own, so buffering would mean a healthy stream delivers nothing until
     * the socket drops.
     */
    let eventsThisConnection = 0;
    const conn = runOneConnection(url, opts.apiKey, lastEventId, fetchImpl, signal, idleTimeoutMs);
    let result: ConnectionResult;
    for (;;) {
      const next = await conn.next();
      if (next.done === true) {
        result = next.value;
        break;
      }
      const event = next.value;
      // Update Last-Event-Id as we go (per spec §"Resume + cursor" WFT-NEUTRALITY-EXEMPT-LINE
      // — only non-empty ids update the cursor). WFT-NEUTRALITY-EXEMPT-LINE
      if (event.id !== undefined && event.id.length > 0) {
        lastEventId = event.id;
      }
      everYielded = true;
      eventsThisConnection += 1;
      yield event;
    }

    // A successful connection that produced at least one event resets
    // the watchdog and attempts counter — same semantic as TCP keep-alive.
    if (eventsThisConnection > 0) {
      firstFailureAt = null;
      attempts = 0;
    }

    if (signal.aborted) break;

    switch (result.kind) {
      case 'auth_failed': {
        logger.warn('sse_auth_failed', {
          status: result.status,
          ever_yielded: everYielded,
        });
        return ExitCode.AuthFailedStartup;
      }
      case 'gap': {
        // 410 = the server is telling us our cursor is past the retention WFT-NEUTRALITY-EXEMPT-LINE
        // window. Per spec, log cursor_gap and resume from the head with WFT-NEUTRALITY-EXEMPT-LINE
        // NO Last-Event-Id (immediate, no sleep).
        logger.warn('cursor_gap', {
          // WFT-NEUTRALITY-EXEMPT-LINE
          status: result.status,
          last_event_id: lastEventId,
        });
        lastEventId = undefined;
        // Reset failure tracking too — the server is healthy, just
        // beyond our retention window.
        firstFailureAt = null;
        attempts = 0;
        continue;
      }
      case 'closed_clean': {
        // Server closed the stream cleanly. Treat as a soft reconnect
        // (no failure accounting) so an idle disconnect doesn't trip the
        // watchdog. Sleep a short jittered amount to avoid hot-loop on
        // an unhealthy server that disconnects every read.
        if (eventsThisConnection === 0) {
          // Zero-event clean close in a row counts as a failure — the
          // server is up but giving us nothing, which is the same
          // observable as a half-open socket.
          attempts += 1;
          if (firstFailureAt === null) firstFailureAt = clock.now();
        } else {
          attempts = 0;
        }
        break;
      }
      case 'network_error': {
        attempts += 1;
        if (firstFailureAt === null) firstFailureAt = clock.now();
        logger.warn('sse_network_error', {
          message: result.message,
          attempt: attempts,
        });
        break;
      }
      default: {
        // Exhaustive — TS will error here if a new ConnectionResult
        // variant is added without updating this switch.
        const _exhaustive: never = result;
        throw new Error(`unreachable: ${String(_exhaustive)}`);
      }
    }

    // Watchdog: bail if we've been unreachable for ≥ unreachableLimitMs.
    if (firstFailureAt !== null && clock.now() - firstFailureAt >= unreachableLimitMs) {
      logger.warn('sse_endpoint_unreachable', {
        elapsed_ms: clock.now() - firstFailureAt,
        limit_ms: unreachableLimitMs,
      });
      return ExitCode.EndpointUnreachable;
    }

    if (attempts > 0) {
      const delay = computeBackoffMs(attempts, maxBackoffMs, randomFn);
      const aborted = await clock.sleep(delay, signal);
      if (aborted) break;
      // Re-check the watchdog *after* the sleep too — the clock can
      // advance during sleep so this catches the case where a long
      // sleep itself pushed us past the limit.
      if (firstFailureAt !== null && clock.now() - firstFailureAt >= unreachableLimitMs) {
        logger.warn('sse_endpoint_unreachable', {
          elapsed_ms: clock.now() - firstFailureAt,
          limit_ms: unreachableLimitMs,
        });
        return ExitCode.EndpointUnreachable;
      }
    }
  }

  return ExitCode.CleanShutdown;
}
