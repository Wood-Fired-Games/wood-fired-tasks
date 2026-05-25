/**
 * Task #357 — bounded-retry wrapper around boot-time OIDC discovery.
 *
 * Why this exists: `createApp` used to call `initOidc` exactly once and map
 * ANY discovery failure to `process.exit(78)`. Under systemd that turns a
 * transient network blip — or a network stack that simply isn't up yet at
 * boot — into a crash-loop that takes the whole task tracker down. The
 * sibling systemd `network-online.target` fix prevents the common case; this
 * is the belt-and-suspenders application-level fix.
 *
 * Contract:
 *   - Retries `initOidc` up to `maxAttempts` times with exponential backoff
 *     (capped at `maxDelayMs`).
 *   - Returns a discriminated result instead of throwing, so the caller
 *     decides boot policy. The caller (`createApp`) boots in a DEGRADED mode
 *     on persistent failure rather than exiting — OIDC login is unavailable
 *     but PAT/legacy auth keeps working and `/health/detailed` surfaces the
 *     degraded state.
 *
 * No module-level state — every call is independent (tests rely on this).
 */
import { initOidc, type OidcConfig } from './oidc-client.js';
import type { Config } from '../config/env.js';

export interface DiscoveryRetryOptions {
  /** Total attempts INCLUDING the first. Clamped to >= 1. */
  maxAttempts: number;
  /** Backoff before the 2nd attempt; doubles each subsequent retry. */
  baseDelayMs: number;
  /** Upper bound on any single backoff wait. */
  maxDelayMs: number;
  /**
   * Injectable sleep so tests don't wait real wall-time. Defaults to a
   * setTimeout-backed promise.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Invoked once per failed-but-will-retry attempt, BEFORE the backoff wait.
   * `createApp` uses this to emit an `oidc.discovery_retry` boot log.
   */
  onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
}

export interface DiscoverySuccess {
  ok: true;
  config: OidcConfig;
  /** 1-based attempt number that finally succeeded. */
  attempts: number;
}

export interface DiscoveryFailure {
  ok: false;
  /** The error from the LAST attempt. */
  error: Error;
  /** How many attempts were made before giving up (== maxAttempts). */
  attempts: number;
}

export type DiscoveryResult = DiscoverySuccess | DiscoveryFailure;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compute the backoff for the wait that FOLLOWS attempt `attempt` (1-based):
 * baseDelayMs * 2^(attempt-1), capped at maxDelayMs. Exported for tests.
 */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const raw = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(raw, maxDelayMs);
}

/**
 * Run boot-time OIDC discovery with bounded exponential backoff.
 *
 * Resolves with `{ ok: true, config }` on the first success, or
 * `{ ok: false, error }` after `maxAttempts` failures. Never throws for a
 * discovery failure (it converts the thrown error into a result); only
 * truly-unexpected programmer errors would propagate.
 */
export async function discoverOidcWithRetry(
  env: Config,
  opts: DiscoveryRetryOptions,
): Promise<DiscoveryResult> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts));
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: Error = new Error('OIDC discovery never attempted');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const cfg = await initOidc(env);
      // initOidc only returns null when OIDC_ISSUER_URL is unset; callers
      // gate on that before getting here, but guard defensively so a null
      // never masquerades as a "successful" discovery.
      if (cfg === null) {
        throw new Error(
          'initOidc returned null despite OIDC_ISSUER_URL being set',
        );
      }
      return { ok: true, config: cfg, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        const delayMs = backoffDelayMs(
          attempt,
          opts.baseDelayMs,
          opts.maxDelayMs,
        );
        opts.onRetry?.({ attempt, delayMs, error: lastError });
        await sleep(delayMs);
      }
    }
  }

  return { ok: false, error: lastError, attempts: maxAttempts };
}
