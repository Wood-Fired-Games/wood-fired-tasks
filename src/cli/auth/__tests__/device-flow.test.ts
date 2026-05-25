/**
 * Phase 30 Plan 06 Task 2 — Unit tests for device-flow.ts.
 *
 * Pure-function tests: every call into `fetch` is mocked, every `setTimeout`
 * is replaced via `sleepImpl`, and the clock is faked via `nowImpl`. No real
 * network, no real time elapses — the loop runs deterministically in <50ms.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  requestDeviceCode,
  pollForToken,
  type PollOptions,
} from '../device-flow.js';

/** Build a fake `Response` Body with json() resolving to the given object. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const successEnvelope = {
  token: 'wft_pat_secret123',
  token_type: 'PAT' as const,
  token_id: 42,
  user: {
    id: 7,
    displayName: 'Test User',
    email: 'test@example.com',
    isLegacy: false,
    isServiceAccount: false,
  },
};

const codeEnvelope = {
  device_code: 'dc-12345',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://example.test/auth/device',
  verification_uri_complete: 'https://example.test/auth/device?user_code=ABCD-EFGH',
  expires_in: 600,
  interval: 5,
};

describe('requestDeviceCode', () => {
  it('POSTs to /auth/device/code and returns the parsed envelope on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, codeEnvelope));
    const res = await requestDeviceCode({
      baseUrl: 'https://example.test',
      clientId: 'wft-cli',
      hostname: 'box',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual(codeEnvelope);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://example.test/auth/device/code');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ client_id: 'wft-cli', hostname: 'box' });
  });

  it('includes token_name when supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, codeEnvelope));
    await requestDeviceCode({
      baseUrl: 'https://example.test',
      clientId: 'wft-cli',
      hostname: 'box',
      tokenName: 'cli-box-2026-05-22',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.token_name).toBe('cli-box-2026-05-22');
  });

  it('throws with status + snippet on non-200', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: 'invalid_client' }));
    await expect(
      requestDeviceCode({
        baseUrl: 'https://example.test',
        clientId: 'wrong-id',
        hostname: 'box',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Failed to start device flow.*400.*invalid_client/);
  });
});

describe('pollForToken', () => {
  function basePollOpts(overrides: Partial<PollOptions> = {}): PollOptions {
    return {
      baseUrl: 'https://example.test',
      deviceCode: 'dc-12345',
      clientId: 'wft-cli',
      initialInterval: 5,
      expiresIn: 600,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
      nowImpl: vi.fn().mockReturnValue(1_000_000),
      ...overrides,
    };
  }

  it('returns kind=ok on first-poll 200 success; sleeps 5000ms once', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, successEnvelope));
    const res = await pollForToken(
      basePollOpts({
        sleepImpl,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(res.kind).toBe('ok');
    if (res.kind === 'ok') {
      expect(res.response.token).toBe('wft_pat_secret123');
    }
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(5000);
  });

  it('handles pending → pending → success; onEvent fires twice with kind:pending', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse(200, successEnvelope));
    const events: Array<{ kind: string; interval: number }> = [];
    const res = await pollForToken(
      basePollOpts({
        sleepImpl,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onEvent: (e) => events.push(e),
      }),
    );
    expect(res.kind).toBe('ok');
    expect(sleepImpl).toHaveBeenCalledTimes(3);
    sleepImpl.mock.calls.forEach((c) => expect(c[0]).toBe(5000));
    const pendings = events.filter((e) => e.kind === 'pending');
    expect(pendings).toHaveLength(2);
    expect(pendings[0]!.interval).toBe(5);
    expect(pendings[1]!.interval).toBe(5);
  });

  it('handles slow_down → pending → success; interval becomes 10', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'slow_down' }))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse(200, successEnvelope));
    const events: Array<{ kind: string; interval: number }> = [];
    const res = await pollForToken(
      basePollOpts({
        sleepImpl,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onEvent: (e) => events.push(e),
      }),
    );
    expect(res.kind).toBe('ok');
    expect(sleepImpl).toHaveBeenCalledTimes(3);
    // first sleep 5s, then 10s (after slow_down bumps interval), then 10s again.
    expect(sleepImpl.mock.calls.map((c) => c[0])).toEqual([5000, 10000, 10000]);
    const slowDowns = events.filter((e) => e.kind === 'slow_down');
    expect(slowDowns).toHaveLength(1);
    expect(slowDowns[0]!.interval).toBe(10);
  });

  it('slow_down is additive +5, not multiplicative (5→10→15)', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'slow_down' }))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'slow_down' }))
      .mockResolvedValueOnce(jsonResponse(200, successEnvelope));
    const res = await pollForToken(
      basePollOpts({
        sleepImpl,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(res.kind).toBe('ok');
    expect(sleepImpl.mock.calls.map((c) => c[0])).toEqual([5000, 10000, 15000]);
  });

  it('returns kind=terminal_error error=expired_token with the documented message', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'expired_token' }));
    const res = await pollForToken(
      basePollOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(res.kind).toBe('terminal_error');
    if (res.kind === 'terminal_error') {
      expect(res.error).toBe('expired_token');
      expect(res.message).toMatch(/Login link expired/);
    }
  });

  it('returns kind=terminal_error error=access_denied with the documented message', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'access_denied' }));
    const res = await pollForToken(
      basePollOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(res.kind).toBe('terminal_error');
    if (res.kind === 'terminal_error') {
      expect(res.error).toBe('access_denied');
      expect(res.message).toMatch(/Sign-in was denied/);
    }
  });

  it('returns kind=terminal_error error=invalid_client with the documented message', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_client' }));
    const res = await pollForToken(
      basePollOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(res.kind).toBe('terminal_error');
    if (res.kind === 'terminal_error') {
      expect(res.error).toBe('invalid_client');
      expect(res.message).toMatch(/client_id/);
    }
  });

  it('returns kind=terminal_error error=timeout when deadline has passed', async () => {
    // First nowImpl() returns the start, second returns start + 901s (past
    // the clamped 900s deadline). The loop's check fires BEFORE the first
    // sleep so we never sleep, never fetch.
    let calls = 0;
    const nowImpl = vi.fn(() => {
      calls += 1;
      // call 1: anchor time
      // call 2: deadline check at top of loop — past deadline
      return calls === 1 ? 1_000_000 : 1_000_000 + 901_000;
    });
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn();
    const res = await pollForToken(
      basePollOpts({
        nowImpl,
        sleepImpl,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(res.kind).toBe('terminal_error');
    if (res.kind === 'terminal_error') {
      expect(res.error).toBe('timeout');
      expect(res.message).toMatch(/Login timed out/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns kind=terminal_error error=network when fetch throws', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed: ECONNREFUSED'));
    const res = await pollForToken(
      basePollOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(res.kind).toBe('terminal_error');
    if (res.kind === 'terminal_error') {
      expect(res.error).toBe('network');
      expect(res.message).toMatch(/Could not reach/);
      expect(res.message).toContain('ECONNREFUSED');
    }
  });

  it('clamps initialInterval to >= 1s', async () => {
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, successEnvelope));
    await pollForToken(
      basePollOpts({
        initialInterval: 0,
        sleepImpl,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(sleepImpl).toHaveBeenCalledWith(1000);
  });

  it('clamps expiresIn to <= 900s', async () => {
    // Anchor: 1_000_000. With expiresIn=99999, deadline should be 1_000_000 +
    // 900_000, NOT 1_000_000 + 99_999_000. Verify by jumping to 1_000_000 +
    // 900_001 — the second nowImpl call MUST report past-deadline, triggering
    // timeout BEFORE any fetch.
    let calls = 0;
    const nowImpl = vi.fn(() => {
      calls += 1;
      return calls === 1 ? 1_000_000 : 1_000_000 + 900_001;
    });
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn();
    const res = await pollForToken(
      basePollOpts({
        expiresIn: 99_999,
        nowImpl,
        sleepImpl,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );
    expect(res.kind).toBe('terminal_error');
    if (res.kind === 'terminal_error') {
      expect(res.error).toBe('timeout');
    }
  });

  it('sends form-encoded body with the RFC 8628 grant_type to /auth/device/token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, successEnvelope));
    await pollForToken(
      basePollOpts({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://example.test/auth/device/token');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // Body is a URLSearchParams (or a string). Either way, decode → assert.
    const bodyStr =
      init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    const parsed = new URLSearchParams(bodyStr);
    expect(parsed.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(parsed.get('device_code')).toBe('dc-12345');
    expect(parsed.get('client_id')).toBe('wft-cli');
  });
});
