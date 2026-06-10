/**
 * wft-router metrics — a tiny, dependency-free Prometheus exposition layer
 * (task #434).
 *
 * The wft-router package is deliberately dependency-minimal (better-sqlite3,
 * pino, yaml, zod only). Rather than pull in `prom-client`, this module
 * hand-rolls exactly the slice of the Prometheus text exposition format the
 * router needs: a handful of monotonic counters, some with labels, rendered
 * as `# HELP` / `# TYPE … counter` blocks followed by
 * `name{label="v"} value` sample lines.
 *
 * Two surfaces live here:
 *
 *   1. {@link MetricsRegistry} — a pure, deterministic, I/O-free counter
 *      store. Typed increment methods feed it; `render()` serializes it to
 *      valid Prometheus exposition text. Label values are escaped per the
 *      Prometheus spec (`\\`, `\"`, `\n`). Because it is pure, it is trivially
 *      unit-testable (AC #1: text-format output + counter increments).
 *
 *   2. {@link startMetricsServer} — the ONLY network listener wft-router adds.
 *      A `node:http` server that answers `GET /metrics` with the registry's
 *      rendered text (`Content-Type: text/plain; version=0.0.4`) and 404s
 *      everything else. Binds `127.0.0.1` by DEFAULT (loopback-only); the
 *      operator widens it explicitly via `--metrics-bind`. There is NO
 *      built-in auth — the operator's reverse proxy owns that (documented in
 *      docs/event-router-design.md §Observability / §Threat surface).
 *
 * Counter names (all carry the `wft_router_` prefix the design uses, see
 * docs/event-router-design.md §Observability):
 *   - wft_router_events_received_total          (no labels — overall total)
 *   - wft_router_events_received_by_kind_total{kind} (mappable/control/unmappable)
 *   - wft_router_matched_rules_total            (no labels)
 *   - wft_router_dispatched_total{handler,status}
 *   - wft_router_handler_errors_total{handler}
 *   - wft_router_permanently_failed_total{rule}
 *   - wft_router_rate_limit_dropped_total{rule}
 *
 * Gauges (task #1002 — deaf-stream observability):
 *   - wft_router_last_real_event_age_seconds — seconds since the last
 *     MAPPABLE domain event arrived (control frames such as server pings do
 *     NOT reset it). Computed at scrape time; alert on it to catch a stream
 *     that keeps pinging but delivers no real events. Baseline = registry
 *     construction (process boot), so a process that never received a real
 *     event reports its age-since-boot.
 *   - process_start_time_seconds — Unix seconds at process start (standard
 *     Prometheus convention, hence no `wft_router_` prefix). Lets operators
 *     tell a fresh process's small counters apart from stale history.
 *
 * Histograms (handler latency, debounce coalescing) named in the design are
 * DEFERRED — counters are the acceptance criterion for this task.
 *
 * Standalone-package isolation: imports ONLY `node:` builtins.
 *
 * Vendor-neutrality: no AI provider, chat platform, or CI vendor name appears
 * in this file. ("Prometheus" is an open exposition format, not on the
 * denylist.)
 */

import { createServer, type Server } from 'node:http';

// ---------------------------------------------------------------------------
// Counter-name constants (exported so tests + the daemon share one source).
// ---------------------------------------------------------------------------

/** Fully-qualified metric names. Single source of truth. */
export const METRIC_NAMES = {
  eventsReceived: 'wft_router_events_received_total',
  eventsByKind: 'wft_router_events_received_by_kind_total',
  matchedRules: 'wft_router_matched_rules_total',
  dispatched: 'wft_router_dispatched_total',
  handlerErrors: 'wft_router_handler_errors_total',
  permanentlyFailed: 'wft_router_permanently_failed_total',
  rateLimitDropped: 'wft_router_rate_limit_dropped_total',
} as const;

/**
 * Gauge names (kept separate from {@link METRIC_NAMES} so the counter-only
 * `# TYPE … counter` invariants stay simple). `process_start_time_seconds`
 * deliberately carries NO `wft_router_` prefix — it is the standard
 * Prometheus process-start convention scrapers already understand.
 */
export const GAUGE_NAMES = {
  lastRealEventAge: 'wft_router_last_real_event_age_seconds',
  processStartTime: 'process_start_time_seconds',
} as const;

/** The dispatch outcome status used as the `status` label on `dispatched_total`. */
export type DispatchStatus = 'succeeded' | 'suppressed' | 'failed';

/**
 * Classification of one received SSE frame, the `kind` label on
 * `wft_router_events_received_by_kind_total`:
 *   - `mappable`   — parsed into a domain event (task.* / project.*) payload.
 *   - `control`    — a known protocol keep-alive frame (e.g. the server's
 *                    30 s `ping`); proves the socket is alive, NOT delivery.
 *   - `unmappable` — neither: bad JSON / missing id / missing type.
 */
export type EventKind = 'mappable' | 'control' | 'unmappable';

// ---------------------------------------------------------------------------
// Label escaping (Prometheus text exposition spec)
// ---------------------------------------------------------------------------

/**
 * Escape a label VALUE per the Prometheus text exposition format: backslash,
 * double-quote, and newline are the only characters that must be escaped.
 * Order matters — backslash first so we don't double-escape the escapes we
 * introduce.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Render a label set into the `{k="v",k2="v2"}` suffix, or '' for no labels.
 * Keys are emitted in insertion order (deterministic for a fixed call site).
 */
function renderLabels(labels: ReadonlyArray<readonly [string, string]>): string {
  if (labels.length === 0) return '';
  const inner = labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',');
  return `{${inner}}`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Metadata for one counter family (for the `# HELP` / `# TYPE` header). */
interface CounterMeta {
  readonly name: string;
  readonly help: string;
}

/** One concrete labelled sample within a counter family. */
interface Sample {
  /** Ordered (key,value) label pairs — empty for an unlabelled counter. */
  readonly labels: ReadonlyArray<readonly [string, string]>;
  /** Stable key derived from the labels, used to dedupe + accumulate. */
  readonly key: string;
  value: number;
}

/** Constructor options for {@link MetricsRegistry}. */
export interface MetricsRegistryOptions {
  /**
   * Injectable clock (epoch ms) for the scrape-time gauge math. Default:
   * `Date.now`. Tests pin it to drive the last-real-event age
   * deterministically.
   */
  now?: () => number;
}

/**
 * A pure, deterministic, I/O-free Prometheus counter registry. Typed
 * increment methods mutate in-memory counts; {@link render} serializes them
 * to valid Prometheus exposition text. No timers, no network — the HTTP
 * layer ({@link startMetricsServer}) is a thin wrapper around `render()`.
 * The only clock use is the injectable `now` seam backing the two gauges
 * (last-real-event age, process start time).
 */
export class MetricsRegistry {
  /** Per-family metadata, keyed by metric name, in declaration order. */
  private readonly meta: CounterMeta[] = [];
  /** Per-family samples, keyed by metric name → (labelKey → Sample). */
  private readonly families = new Map<string, Map<string, Sample>>();
  /** Clock seam backing the gauges. */
  private readonly nowFn: () => number;
  /** `process_start_time_seconds` value, fixed at construction. */
  private readonly processStartSeconds: number;
  /** Epoch ms of the last MAPPABLE domain event (construction time = boot). */
  private lastRealEventAtMs: number;

  constructor(opts: MetricsRegistryOptions = {}) {
    this.nowFn = opts.now ?? Date.now;
    // With the default clock, derive the TRUE process start from uptime
    // (standard Prometheus convention). With an injected test clock, registry
    // construction stands in for process start so tests stay deterministic.
    this.processStartSeconds =
      opts.now !== undefined ? opts.now() / 1000 : Date.now() / 1000 - process.uptime();
    this.lastRealEventAtMs = this.nowFn();
    // Declare every family up-front so `render()` emits a stable header set
    // (including `# TYPE … counter`) even before any increment lands. A
    // counter with no samples still renders a zero-valued unlabelled line for
    // the no-label families so scrapers see the series exist.
    this.declare(METRIC_NAMES.eventsReceived, 'Total SSE events received by the router.');
    this.declare(
      METRIC_NAMES.eventsByKind,
      'Total SSE events received, split by kind (mappable domain event / control frame / unmappable).',
    );
    this.declare(METRIC_NAMES.matchedRules, 'Total (rule, event) matches across all events.');
    this.declare(
      METRIC_NAMES.dispatched,
      'Total handler dispatches, labelled by handler and outcome status.',
    );
    this.declare(
      METRIC_NAMES.handlerErrors,
      'Total handler invocations that threw or rejected, by handler.',
    );
    this.declare(
      METRIC_NAMES.permanentlyFailed,
      'Total dispatches that failed non-retryably, by rule.',
    );
    this.declare(
      METRIC_NAMES.rateLimitDropped,
      'Total dispatches dropped by the rate-limit gate, by rule.',
    );

    // Seed the two unlabelled families with a zero sample so they always
    // render a series (Prometheus best practice for known-zero counters).
    this.bump(METRIC_NAMES.eventsReceived, [], 0);
    this.bump(METRIC_NAMES.matchedRules, [], 0);
    // Seed every kind of the by-kind split too — the label set is a small,
    // closed enum, so pre-creating the series keeps scrape-side rate() and
    // absence checks well-defined from the first scrape.
    this.bump(METRIC_NAMES.eventsByKind, [['kind', 'mappable']], 0);
    this.bump(METRIC_NAMES.eventsByKind, [['kind', 'control']], 0);
    this.bump(METRIC_NAMES.eventsByKind, [['kind', 'unmappable']], 0);
  }

  private declare(name: string, help: string): void {
    this.meta.push({ name, help });
    if (!this.families.has(name)) {
      this.families.set(name, new Map<string, Sample>());
    }
  }

  /**
   * Add `delta` to the sample identified by `(name, labels)`, creating the
   * sample on first sight. Label order is preserved as given.
   */
  private bump(
    name: string,
    labels: ReadonlyArray<readonly [string, string]>,
    delta: number,
  ): void {
    const family = this.families.get(name);
    if (family === undefined) {
      throw new Error(`metrics: increment of undeclared family ${name}`);
    }
    const key = labels.map(([k, v]) => `${k}=${v}`).join('\u0000');
    const existing = family.get(key);
    if (existing === undefined) {
      family.set(key, { labels, key, value: delta });
    } else {
      existing.value += delta;
    }
  }

  /** Increment the events-received counter by one. */
  incEventsReceived(n = 1): void {
    this.bump(METRIC_NAMES.eventsReceived, [], n);
  }

  /** Increment the by-kind events counter for one received frame. */
  incEventsByKind(kind: EventKind): void {
    this.bump(METRIC_NAMES.eventsByKind, [['kind', kind]], 1);
  }

  /**
   * Record that a REAL (mappable domain) event was just received — resets
   * the `wft_router_last_real_event_age_seconds` baseline. Control frames
   * (pings) must NOT call this: their whole point is that they keep flowing
   * while real delivery is dead.
   */
  markRealEvent(): void {
    this.lastRealEventAtMs = this.nowFn();
  }

  /** Seconds since the last mappable event (registry construction if none yet). */
  lastRealEventAgeSeconds(): number {
    return Math.max(0, (this.nowFn() - this.lastRealEventAtMs) / 1000);
  }

  /** Increment the matched-rules counter by `n` (the per-event match count). */
  incMatchedRules(n: number): void {
    if (n <= 0) return;
    this.bump(METRIC_NAMES.matchedRules, [], n);
  }

  /** Increment the dispatched counter for a `(handler, status)` pair. */
  incDispatched(handler: string, status: DispatchStatus): void {
    this.bump(
      METRIC_NAMES.dispatched,
      [
        ['handler', handler],
        ['status', status],
      ],
      1,
    );
  }

  /** Increment the handler-errors counter for a handler. */
  incHandlerError(handler: string): void {
    this.bump(METRIC_NAMES.handlerErrors, [['handler', handler]], 1);
  }

  /** Increment the permanently-failed counter for a rule. */
  incPermanentlyFailed(rule: string): void {
    this.bump(METRIC_NAMES.permanentlyFailed, [['rule', rule]], 1);
  }

  /** Increment the rate-limit-dropped counter for a rule. */
  incRateLimitDropped(rule: string): void {
    this.bump(METRIC_NAMES.rateLimitDropped, [['rule', rule]], 1);
  }

  /**
   * Serialize the registry to Prometheus text exposition format. Each family
   * emits a `# HELP`/`# TYPE … counter` header followed by its sample lines
   * (`name{labels} value`). Families with no samples emit just the header.
   * Output ends with a trailing newline (scrapers expect it).
   */
  render(): string {
    const lines: string[] = [];
    for (const { name, help } of this.meta) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      const family = this.families.get(name);
      if (family === undefined) continue;
      for (const sample of family.values()) {
        lines.push(`${name}${renderLabels(sample.labels)} ${sample.value}`);
      }
    }
    // Gauges (computed at scrape time, after the counter families).
    lines.push(
      `# HELP ${GAUGE_NAMES.lastRealEventAge} Seconds since the last mappable domain event was received (baseline: process start). Control frames such as pings do not reset it.`,
    );
    lines.push(`# TYPE ${GAUGE_NAMES.lastRealEventAge} gauge`);
    lines.push(`${GAUGE_NAMES.lastRealEventAge} ${String(this.lastRealEventAgeSeconds())}`);
    lines.push(
      `# HELP ${GAUGE_NAMES.processStartTime} Start time of the process since unix epoch in seconds.`,
    );
    lines.push(`# TYPE ${GAUGE_NAMES.processStartTime} gauge`);
    lines.push(`${GAUGE_NAMES.processStartTime} ${String(this.processStartSeconds)}`);
    return `${lines.join('\n')}\n`;
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

/** Prometheus text exposition content type (format version 0.0.4). */
const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Default bind address — loopback only. Widened only via `--metrics-bind`. */
export const DEFAULT_METRICS_BIND = '127.0.0.1';

/** Options for {@link startMetricsServer}. */
export interface StartMetricsServerOptions {
  /** TCP port to listen on. `0` lets the OS assign an ephemeral port. */
  port: number;
  /** Registry whose `render()` output is served. */
  registry: MetricsRegistry;
  /** Bind address. Defaults to `127.0.0.1` (loopback-only). */
  bind?: string;
}

/** A running metrics server handle. */
export interface MetricsServerHandle {
  /** The underlying node:http server (for `.address()` assertions in tests). */
  readonly server: Server;
  /** The bound address the OS reports (host + resolved port + family). */
  readonly address: { address: string; port: number; family: string };
  /** Gracefully close the listener. Idempotent. */
  close(): Promise<void>;
}

/**
 * Start the metrics HTTP server. Answers `GET /metrics` with the rendered
 * registry text; every other path/method gets a 404. Binds `127.0.0.1` unless
 * an explicit `bind` widens it. Resolves once the socket is listening, with a
 * handle exposing the resolved address and a `close()`.
 *
 * This is the only network listener wft-router adds. Keep it loopback-default;
 * there is intentionally NO auth here (the reverse proxy owns it).
 */
export function startMetricsServer(opts: StartMetricsServerOptions): Promise<MetricsServerHandle> {
  const bind = opts.bind ?? DEFAULT_METRICS_BIND;
  const { registry } = opts;

  const server = createServer((req, res) => {
    // Strip any query string before matching the path.
    const url = req.url ?? '';
    const path = url.split('?', 1)[0];
    if (req.method === 'GET' && path === '/metrics') {
      const body = registry.render();
      res.writeHead(200, { 'Content-Type': METRICS_CONTENT_TYPE });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  });

  return new Promise<MetricsServerHandle>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    server.once('error', onError);
    server.listen(opts.port, bind, () => {
      server.removeListener('error', onError);
      const addr = server.address();
      // `address()` is an object once listening on a TCP socket.
      const resolved =
        addr !== null && typeof addr === 'object'
          ? { address: addr.address, port: addr.port, family: addr.family }
          : { address: bind, port: opts.port, family: 'IPv4' };
      resolve({
        server,
        address: resolved,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((closeErr) => (closeErr ? rej(closeErr) : res()));
          }),
      });
    });
  });
}
