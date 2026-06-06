/**
 * Unit tests for the shared HTTP wrapper (task #428).
 *
 * Covers: status + body passthrough, no-throw on non-2xx, timeout →
 * HttpTimeoutError, network reject → HttpNetworkError, and external-signal
 * abort. The wrapper exposes NO TLS-insecure option — there is nothing to
 * test for an escape hatch because it does not exist.
 */

import { describe, expect, it, vi } from 'vitest';

import { httpRequest, HttpNetworkError, HttpTimeoutError } from '../http-client.js';

describe('httpRequest', () => {
  it('returns status + body text and does not throw on non-2xx', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('boom', { status: 500 }))) as typeof fetch;

    const res = await httpRequest({ method: 'GET', url: 'https://x.example/y', fetchImpl });

    expect(res.status).toBe(500);
    expect(res.bodyText).toBe('boom');
  });

  it('passes method, headers, and body through to fetch', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      seen = init;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;

    await httpRequest({
      method: 'POST',
      url: 'https://x.example/y',
      headers: { 'X-Test': '1' },
      body: '{"a":1}',
      fetchImpl,
    });

    expect(seen?.method).toBe('POST');
    expect((seen?.headers as Record<string, string>)['X-Test']).toBe('1');
    expect(seen?.body).toBe('{"a":1}');
  });

  it('throws HttpTimeoutError when the timeout elapses first', async () => {
    vi.useFakeTimers();
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      })) as typeof fetch;

    const promise = httpRequest({
      method: 'GET',
      url: 'https://x.example',
      fetchImpl,
      timeoutMs: 100,
    });
    // Attach the rejection handler BEFORE advancing the clock so the
    // eventual rejection is never observed as "unhandled".
    const assertion = expect(promise).rejects.toBeInstanceOf(HttpTimeoutError);
    await vi.advanceTimersByTimeAsync(120);
    await assertion;
    vi.useRealTimers();
  });

  it('throws HttpNetworkError when fetch rejects', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;

    await expect(
      httpRequest({ method: 'GET', url: 'https://x.example', fetchImpl }),
    ).rejects.toBeInstanceOf(HttpNetworkError);
  });

  it('aborts when an external signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        resolve(new Response('{}', { status: 200 }));
      })) as typeof fetch;

    await expect(
      httpRequest({
        method: 'GET',
        url: 'https://x.example',
        fetchImpl,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(HttpNetworkError);
  });
});
