/**
 * Unit + integration tests for the wft-router metrics layer (task #434).
 *
 *   AC #1 — MetricsRegistry renders valid Prometheus text exposition
 *           (`# HELP` / `# TYPE … counter` headers + `name{labels} value`
 *           sample lines) AND counter increments are reflected; label values
 *           are escaped per the Prometheus spec.
 *   AC #2 — startMetricsServer binds 127.0.0.1 BY DEFAULT (no bind override):
 *           the resolved listen address is loopback and `GET /metrics` is
 *           reachable there.
 *   AC #3 — an explicit `bind` overrides the default (the `--metrics-bind`
 *           flag path); `server.address()` reflects it.
 *
 * Servers use `port: 0` (OS-assigned ephemeral) to avoid collisions, and are
 * always closed in a `finally` / `afterEach`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_METRICS_BIND,
  METRIC_NAMES,
  MetricsRegistry,
  startMetricsServer,
  type MetricsServerHandle,
} from '../metrics.js';

// ---------------------------------------------------------------------------
// AC #1 — text-format output + counter increments
// ---------------------------------------------------------------------------

describe('MetricsRegistry.render — Prometheus text exposition', () => {
  it('emits # HELP and # TYPE … counter headers for every family', () => {
    const reg = new MetricsRegistry();
    const out = reg.render();
    for (const name of Object.values(METRIC_NAMES)) {
      expect(out).toContain(`# HELP ${name} `);
      expect(out).toContain(`# TYPE ${name} counter`);
    }
    // Ends with a trailing newline (scrapers expect it).
    expect(out.endsWith('\n')).toBe(true);
  });

  it('renders unlabelled counters with a zero baseline then increments them', () => {
    const reg = new MetricsRegistry();
    expect(reg.render()).toContain(`${METRIC_NAMES.eventsReceived} 0`);

    reg.incEventsReceived();
    reg.incEventsReceived();
    reg.incMatchedRules(3);

    const out = reg.render();
    expect(out).toContain(`${METRIC_NAMES.eventsReceived} 2`);
    expect(out).toContain(`${METRIC_NAMES.matchedRules} 3`);
  });

  it('labels dispatched_total with handler + status and accumulates per-pair', () => {
    const reg = new MetricsRegistry();
    reg.incDispatched('webhook_post', 'succeeded');
    reg.incDispatched('webhook_post', 'succeeded');
    reg.incDispatched('webhook_post', 'failed');
    reg.incDispatched('shell_exec', 'suppressed');

    const out = reg.render();
    expect(out).toContain(
      `${METRIC_NAMES.dispatched}{handler="webhook_post",status="succeeded"} 2`,
    );
    expect(out).toContain(
      `${METRIC_NAMES.dispatched}{handler="webhook_post",status="failed"} 1`,
    );
    expect(out).toContain(
      `${METRIC_NAMES.dispatched}{handler="shell_exec",status="suppressed"} 1`,
    );
  });

  it('labels handler_errors/permanently_failed/rate_limit_dropped', () => {
    const reg = new MetricsRegistry();
    reg.incHandlerError('shell_exec');
    reg.incPermanentlyFailed('on_done');
    reg.incRateLimitDropped('on_done');

    const out = reg.render();
    expect(out).toContain(`${METRIC_NAMES.handlerErrors}{handler="shell_exec"} 1`);
    expect(out).toContain(`${METRIC_NAMES.permanentlyFailed}{rule="on_done"} 1`);
    expect(out).toContain(`${METRIC_NAMES.rateLimitDropped}{rule="on_done"} 1`);
  });

  it('escapes backslash, double-quote, and newline in label values', () => {
    const reg = new MetricsRegistry();
    reg.incPermanentlyFailed('a\\b"c\nd');
    const out = reg.render();
    expect(out).toContain(
      `${METRIC_NAMES.permanentlyFailed}{rule="a\\\\b\\"c\\nd"} 1`,
    );
  });

  it('matches a full Prometheus sample-line grammar for a labelled series', () => {
    const reg = new MetricsRegistry();
    reg.incDispatched('webhook_post', 'succeeded');
    const out = reg.render();
    const line = out
      .split('\n')
      .find((l) => l.startsWith(`${METRIC_NAMES.dispatched}{`));
    expect(line).toBeDefined();
    // name{label="v",label2="v2"} <number>
    expect(line).toMatch(
      /^wft_router_dispatched_total\{handler="[^"]*",status="[^"]*"\} \d+$/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC #2 / AC #3 — HTTP server bind defaulting + override
// ---------------------------------------------------------------------------

describe('startMetricsServer — bind defaulting + serving', () => {
  let handle: MetricsServerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it('AC#2: defaults to 127.0.0.1 and serves /metrics on loopback', async () => {
    const reg = new MetricsRegistry();
    reg.incEventsReceived();
    handle = await startMetricsServer({ port: 0, registry: reg });

    expect(DEFAULT_METRICS_BIND).toBe('127.0.0.1');
    expect(handle.address.address).toBe('127.0.0.1');
    expect(handle.address.port).toBeGreaterThan(0);

    const res = await fetch(
      `http://127.0.0.1:${handle.address.port}/metrics`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-type')).toContain('version=0.0.4');
    const body = await res.text();
    expect(body).toContain(`# TYPE ${METRIC_NAMES.eventsReceived} counter`);
    expect(body).toContain(`${METRIC_NAMES.eventsReceived} 1`);
  });

  it('AC#3: an explicit bind overrides the default', async () => {
    const reg = new MetricsRegistry();
    // 0.0.0.0 is the canonical "widen it" override the design names.
    handle = await startMetricsServer({
      port: 0,
      bind: '0.0.0.0',
      registry: reg,
    });
    expect(handle.address.address).toBe('0.0.0.0');
    const addr = handle.server.address();
    expect(addr !== null && typeof addr === 'object' ? addr.address : '').toBe(
      '0.0.0.0',
    );
    // Still reachable on loopback even when bound to 0.0.0.0.
    const res = await fetch(`http://127.0.0.1:${handle.address.port}/metrics`);
    expect(res.status).toBe(200);
  });

  it('404s a non-/metrics path', async () => {
    const reg = new MetricsRegistry();
    handle = await startMetricsServer({ port: 0, registry: reg });
    const res = await fetch(`http://127.0.0.1:${handle.address.port}/healthz`);
    expect(res.status).toBe(404);
  });

  it('reflects live registry mutations between scrapes', async () => {
    const reg = new MetricsRegistry();
    handle = await startMetricsServer({ port: 0, registry: reg });
    const url = `http://127.0.0.1:${handle.address.port}/metrics`;

    reg.incDispatched('webhook_post', 'succeeded');
    let body = await (await fetch(url)).text();
    expect(body).toContain(
      `${METRIC_NAMES.dispatched}{handler="webhook_post",status="succeeded"} 1`,
    );

    reg.incDispatched('webhook_post', 'succeeded');
    body = await (await fetch(url)).text();
    expect(body).toContain(
      `${METRIC_NAMES.dispatched}{handler="webhook_post",status="succeeded"} 2`,
    );
  });
});
