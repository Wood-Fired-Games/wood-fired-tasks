/**
 * Minimal fetch wrapper for the wft-router action handlers (task #428).
 *
 * This is the SHARED HTTP transport the core handlers POST through. It is
 * deliberately generic: task #429 (webhook_post) REUSES this wrapper and
 * LAYERS a loopback / TLS-posture guard on top, so this module bakes in NO
 * create-task-specific logic.
 *
 * Responsibilities owned here:
 *   - Issue a single request via an injectable `fetchImpl` (default
 *     `globalThis.fetch`) — the same test-seam style as `src/sse/client.ts`.
 *   - Enforce a per-call timeout via `AbortController`; on elapse the request
 *     is aborted and an {@link HttpTimeoutError} is thrown.
 *   - Read the FULL response body as text and return `{ status, bodyText }`.
 *     Non-2xx is NOT thrown — the caller maps status → outcome.
 *   - Surface network / abort failures as thrown errors
 *     ({@link HttpNetworkError} / {@link HttpTimeoutError}) so the caller can
 *     classify them as retryable.
 *
 * TLS posture: for `https://` targets we rely on Node's DEFAULT
 * `rejectUnauthorized: true`. This wrapper exposes NO option to disable
 * certificate validation — there is intentionally no insecure escape hatch
 * (hard constraint, docs/event-router-design.md §"TLS posture").
 *
 * Standalone-package isolation: no imports from root `src/`.
 *
 * Vendor-neutrality: no AI provider, chat platform, or CI vendor name appears
 * in this file.
 */

/** Default per-call timeout when the caller does not specify one. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/** Result of a completed HTTP round-trip — status code + full body text. */
export interface HttpResponse {
  status: number;
  bodyText: string;
}

/** Options for {@link httpRequest}. */
export interface HttpRequestOptions {
  method: string;
  url: string;
  /** Header bag merged verbatim onto the request. */
  headers?: Record<string, string>;
  /** Request body (already serialized). Omit for bodyless methods. */
  body?: string;
  /** Per-call timeout in ms. Default {@link DEFAULT_HTTP_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Test seam — defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Optional external abort signal. If supplied it is composed with the
   * internal timeout signal so either source aborts the request.
   */
  signal?: AbortSignal;
}

/** Thrown when the per-call timeout elapses before the response arrives. */
export class HttpTimeoutError extends Error {
  public readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`http request timed out after ${String(timeoutMs)}ms`);
    this.name = 'HttpTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when the underlying fetch rejects (DNS, connection refused, TLS, etc.). */
export class HttpNetworkError extends Error {
  public override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'HttpNetworkError';
    this.cause = cause;
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Perform a single HTTP request with a hard per-call timeout, returning the
 * status and full body text. Does NOT throw on non-2xx — only on network
 * failure or timeout.
 *
 * The timeout is implemented with an `AbortController` that is `abort()`ed
 * after `timeoutMs`; the timer is always cleared in a `finally` so a fast
 * response never leaves a dangling timer. When an external `signal` is
 * supplied it is bridged to the internal controller so the caller can cancel
 * too.
 *
 * @throws {HttpTimeoutError} when the timeout fires first.
 * @throws {HttpNetworkError} when fetch rejects for any other reason.
 */
export async function httpRequest(opts: HttpRequestOptions): Promise<HttpResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Bridge an externally-supplied signal into our controller so either source
  // aborts the in-flight request.
  const onExternalAbort = (): void => {
    controller.abort();
  };
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) {
      controller.abort();
    } else {
      opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const response = await fetchImpl(opts.url, {
      method: opts.method,
      ...(opts.headers !== undefined && { headers: opts.headers }),
      ...(opts.body !== undefined && { body: opts.body }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    return { status: response.status, bodyText };
  } catch (err) {
    if (timedOut) {
      throw new HttpTimeoutError(timeoutMs);
    }
    // An external-signal abort surfaces as a generic network error — the
    // caller owns the semantics of its own signal.
    throw new HttpNetworkError(errMessage(err), err);
  } finally {
    clearTimeout(timer);
    if (opts.signal !== undefined) {
      opts.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}
