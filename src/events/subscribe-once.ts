import { EventBus } from './event-bus.js';

/**
 * Rejection error when {@link subscribeOnce} hits its deadline before a
 * matching event arrives. Identified by `name === 'TimeoutError'`.
 */
export class TimeoutError extends Error {
  constructor(message = 'subscribeOnce timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Rejection error when {@link subscribeOnce}'s AbortSignal fires (or was
 * already aborted at call time). Identified by `name === 'AbortError'`,
 * mirroring the DOM/`AbortController` convention.
 */
export class AbortError extends Error {
  constructor(message = 'subscribeOnce aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Options for {@link subscribeOnce}.
 */
export interface SubscribeOnceOptions {
  /** Reject with {@link TimeoutError} after this many milliseconds. */
  timeoutMs: number;
  /** Optional abort signal; if it fires, reject with {@link AbortError}. */
  signal?: AbortSignal;
}

/**
 * Subscribe to a single EventBus event type and resolve with the first event
 * for which `predicate(event)` returns true.
 *
 * Terminal cases (resolve, timeout, abort) all run through one shared cleanup
 * path that (a) calls the EventBus unsubscribe function, (b) clears the timeout
 * timer, and (c) removes the abort listener. The cleanup is guarded so it runs
 * exactly once, preventing both double-settle and listener leaks.
 *
 * Mirrors the generic shape of {@link EventBus.subscribe}: `K extends keyof
 * Events` keys the payload type via `Events[K]`.
 *
 * @param bus - The EventBus to subscribe on
 * @param eventType - The event name to listen for
 * @param predicate - Returns true for the event that should resolve the promise
 * @param options - Timeout (required) and optional abort signal
 * @returns Promise resolving with the first matching event payload
 */
export function subscribeOnce<
  Events extends Record<string, unknown>,
  K extends keyof Events,
>(
  bus: EventBus<Events>,
  eventType: K,
  predicate: (event: Events[K]) => boolean,
  options: SubscribeOnceOptions
): Promise<Events[K]> {
  return new Promise<Events[K]>((resolve, reject) => {
    const { signal } = options;

    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Single shared teardown — removes the EventBus listener, clears the
    // timeout timer, and detaches the abort listener. Guarded so it runs at
    // most once across every terminal path.
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      // Unsubscribe may be undefined only if abort fired synchronously before
      // we subscribed; the early-abort guard below handles that case.
      unsubscribe?.();
    };

    const onAbort = (): void => {
      if (settled) return;
      cleanup();
      reject(new AbortError());
    };

    // Already-aborted signal: reject immediately, never subscribe.
    if (signal?.aborted) {
      settled = true;
      reject(new AbortError());
      return;
    }

    timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new TimeoutError(`subscribeOnce timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    unsubscribe = bus.subscribe(eventType, (event: Events[K]) => {
      if (settled) return;
      let matched = false;
      try {
        matched = predicate(event);
      } catch (err) {
        // A throwing predicate is a caller bug — tear down and surface it
        // rather than leaking the listener.
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!matched) return;
      cleanup();
      resolve(event);
    });
  });
}
