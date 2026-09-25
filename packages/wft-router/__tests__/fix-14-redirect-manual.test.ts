/**
 * fix-14 / redirect-manual (audit finding H4, part 1/2 — task #1618).
 *
 * The shared HTTP wrapper (`src/handlers/http-client.ts`) must never follow
 * redirects transparently: a 302 (or any 3xx) has to come back to the
 * caller as-is — status + the `Location` header value — instead of being
 * silently chased to wherever it points. Re-validating that Location target
 * through the endpoint guard is task #1619's job; this wrapper only exposes
 * the metadata.
 *
 * These two tests are the AC-mandated pair:
 *   1. the fetch init object the wrapper hands to `fetchImpl` carries
 *      `redirect: 'manual'`.
 *   2. a 302 response round-trips as status 302 with `location` populated,
 *      never followed.
 */

import { describe, expect, it } from 'vitest';

import { httpRequest } from '../src/handlers/http-client.js';

describe('fix-14 / redirect-manual', () => {
  it('calls fetchImpl with redirect: "manual" in the init object', async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      seenInit = init;
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as typeof fetch;

    await httpRequest({ method: 'GET', url: 'https://x.example/y', fetchImpl });

    expect(seenInit?.redirect).toBe('manual');
  });

  it('returns a 302 to the caller as status 302 with Location populated, not followed', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('', {
          status: 302,
          headers: { Location: 'https://internal.example/next' },
        }),
      )) as typeof fetch;

    const res = await httpRequest({ method: 'GET', url: 'https://x.example/y', fetchImpl });

    expect(res.status).toBe(302);
    expect(res.location).toBe('https://internal.example/next');
  });
});
