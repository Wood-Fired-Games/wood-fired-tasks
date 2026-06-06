/**
 * Task #357 — unit tests for the bounded-retry OIDC discovery wrapper.
 *
 * These exercise the retry/backoff state machine in isolation by mocking
 * `initOidc`, with an injected `sleep` so no real wall-time is spent. The
 * boot-integration behavior (degraded boot, /health signal) is covered in
 * src/api/__tests__/oidc-enabled-boot.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../config/env.js';

// Mock the openid-client wrapper so we control success/failure per attempt.
vi.mock('../oidc-client.js', () => ({
  initOidc: vi.fn(),
}));

import { initOidc } from '../oidc-client.js';
import { discoverOidcWithRetry, backoffDelayMs } from '../oidc-boot.js';

const initOidcMock = vi.mocked(initOidc);

// A minimal Config stand-in; the retry wrapper only forwards it to initOidc,
// which is mocked, so the actual field values are irrelevant here.
const fakeEnv = { OIDC_ISSUER_URL: 'https://idp.example.com' } as unknown as Config;

// Collect sleep durations instead of waiting.
function makeNoopSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

beforeEach(() => {
  initOidcMock.mockReset();
});

describe('backoffDelayMs', () => {
  it('grows exponentially from the base delay', () => {
    expect(backoffDelayMs(1, 500, 10_000)).toBe(500);
    expect(backoffDelayMs(2, 500, 10_000)).toBe(1000);
    expect(backoffDelayMs(3, 500, 10_000)).toBe(2000);
    expect(backoffDelayMs(4, 500, 10_000)).toBe(4000);
  });

  it('is capped at maxDelayMs', () => {
    expect(backoffDelayMs(10, 500, 3000)).toBe(3000);
  });
});

describe('discoverOidcWithRetry', () => {
  it('returns ok on the first attempt with no sleeps', async () => {
    const cfg = { discovered: true } as unknown as Awaited<ReturnType<typeof initOidc>>;
    initOidcMock.mockResolvedValueOnce(cfg);
    const { sleep, calls } = makeNoopSleep();

    const result = await discoverOidcWithRetry(fakeEnv, {
      maxAttempts: 5,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      sleep,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempts).toBe(1);
      expect(result.config).toBe(cfg);
    }
    expect(initOidcMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]); // no backoff when first attempt wins
  });

  it('recovers after transient failures and reports the winning attempt number', async () => {
    const cfg = { discovered: true } as unknown as Awaited<ReturnType<typeof initOidc>>;
    initOidcMock
      .mockRejectedValueOnce(new Error('OIDC discovery failed for x: ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('OIDC discovery failed for x: ETIMEDOUT'))
      .mockResolvedValueOnce(cfg);
    const { sleep, calls } = makeNoopSleep();
    const onRetry = vi.fn();

    const result = await discoverOidcWithRetry(fakeEnv, {
      maxAttempts: 5,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      sleep,
      onRetry,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(3);
    expect(initOidcMock).toHaveBeenCalledTimes(3);
    // Two backoff waits before the 3rd (winning) attempt: 500, then 1000.
    expect(calls).toEqual([500, 1000]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ attempt: 1, delayMs: 500 }),
    );
    expect(onRetry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ attempt: 2, delayMs: 1000 }),
    );
  });

  it('gives up after maxAttempts and returns the last error', async () => {
    initOidcMock.mockRejectedValue(new Error('OIDC discovery failed for x: 500'));
    const { sleep, calls } = makeNoopSleep();

    const result = await discoverOidcWithRetry(fakeEnv, {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      sleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(3);
      expect(result.error.message).toMatch(/OIDC discovery failed/);
    }
    expect(initOidcMock).toHaveBeenCalledTimes(3);
    // Backoff happens between attempts but NOT after the final failure.
    expect(calls).toEqual([500, 1000]);
  });

  it('makes exactly one attempt and never sleeps when maxAttempts=1', async () => {
    initOidcMock.mockRejectedValue(new Error('boom'));
    const { sleep, calls } = makeNoopSleep();

    const result = await discoverOidcWithRetry(fakeEnv, {
      maxAttempts: 1,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      sleep,
    });

    expect(result.ok).toBe(false);
    expect(initOidcMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it('treats a null initOidc return as a failure (defensive guard)', async () => {
    initOidcMock.mockResolvedValue(null);
    const { sleep } = makeNoopSleep();

    const result = await discoverOidcWithRetry(fakeEnv, {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
      sleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/returned null/);
  });
});
