/**
 * One-shot session flash helper.
 *
 * 29-RESEARCH.md Pitfall 1: @fastify/secure-session v8 has NO `flash()`
 * method (verified at types/index.d.ts). The minted-token "show once"
 * flow (and any other one-shot flash) reads + clears in one call via
 * this helper.
 *
 * Generic over the SessionData key so call sites get inferred shapes
 * without casts (e.g. `getFlashAndClear(req, 'mintedToken')` returns
 * `{ id: number; token: string } | undefined`).
 */
import type { FastifyRequest } from 'fastify';
import type { SessionData } from '@fastify/secure-session';

export function getFlashAndClear<K extends keyof SessionData>(
  request: FastifyRequest,
  key: K,
): SessionData[K] | undefined {
  const value = request.session.get(key);
  if (value !== undefined && value !== null) {
    // Cast through unknown — SessionData[K] | undefined is what `set`
    // accepts after the v8 type fix. The cast tells TS that passing
    // `undefined` to clear is intentional.
    request.session.set(key, undefined as unknown as SessionData[K]);
  }
  return value;
}
