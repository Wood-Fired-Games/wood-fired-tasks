import { afterEach, describe, expect, it } from 'vitest';

import { assertEndpointAllowed, webhookPost } from '../../src/handlers/webhook-post.js';
import type { HandlerContext } from '../../src/handlers/index.js';
import { createFixtureStore, silentLogger, taskEvent, type FixtureStore } from './harness.js';

// fix-7 / TLS-posture: a non-loopback http:// endpoint is refused (a plaintext
// POST to a routable host is credential exposure) — the dispatch is marked
// non-retryable and NOTHING is sent on the wire; https:// is always allowed
// with mandatory cert validation, and there is no insecure / --insecure
// fallback in v1 (any non-http(s) scheme is refused outright).

describe('fix-7 / TLS-posture', () => {
  let fx: FixtureStore;

  afterEach(() => {
    fx?.dispose();
  });

  it('refuses to dispatch a non-loopback http:// endpoint and never hits the wire', async () => {
    fx = createFixtureStore();
    let wireCalls = 0;
    const ctx: HandlerContext = {
      store: fx.store,
      logger: silentLogger(),
      identity: {
        rule_name: 'rule-tls',
        event_id: 'evt-tls-1',
        task_id: 1,
        to_status: 'done',
        emitted_at_ms: 1_700_000_000_000,
      },
      event: taskEvent('evt-tls-1', 'task.status_changed', { id: 1, status: 'done' }),
      withBlock: {
        url: 'http://example.test/hook',
        headers: { authorization: 'Bearer would-leak' },
      },
      // A fetch impl that, if ever called, would prove the guard failed open.
      fetchImpl: (async () => {
        wireCalls++;
        return new Response('', { status: 200 });
      }) as unknown as HandlerContext['fetchImpl'],
    };

    const outcome = await webhookPost(ctx);
    // Refused as a terminal, non-retryable config error — no POST happened.
    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.retryable).toBe(false);
    expect(wireCalls).toBe(0);
  });

  it('refuses a non-loopback http:// endpoint (pure guard)', () => {
    const decision = assertEndpointAllowed('http://example.test/hook');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/non-loopback|credential/i);
  });

  it('allows loopback http:// and always allows https:// (cert validation never bypassed)', () => {
    expect(assertEndpointAllowed('http://127.0.0.1:8080/h').allowed).toBe(true);
    expect(assertEndpointAllowed('http://localhost:3000/h').allowed).toBe(true);
    expect(assertEndpointAllowed('http://[::1]/h').allowed).toBe(true);
    expect(assertEndpointAllowed('https://example.test/hook').allowed).toBe(true);
  });

  it('has no insecure fallback — unsupported scheme and unparseable url are refused', () => {
    expect(assertEndpointAllowed('ftp://example.test/x').allowed).toBe(false);
    expect(assertEndpointAllowed('not a url').allowed).toBe(false);
  });
});
