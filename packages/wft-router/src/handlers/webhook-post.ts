/**
 * Core action handler: `webhook_post` (task #429).
 *
 * Given a triggered rule, this handler POSTs a templated body to an
 * ARBITRARY per-rule URL, consuming the PENDING→terminal idempotency protocol
 * and reporting a structured {@link HandlerOutcome}. It is the SECOND of the
 * three v1 core handlers and REUSES the shared handler contract (`types.ts`)
 * and the shared HTTP transport (`http-client.ts`) established by #428.
 *
 * Unlike `create_task_in_project` (which targets the first-party REST API via
 * `apiBaseUrl`/`authToken`), webhook_post sends to an operator-supplied
 * endpoint. The target `url`, optional `headers`, and `body` all come from the
 * rendered `with:` block — NOT from the context's `apiBaseUrl`/`authToken`
 * (those are the create-task handler's API creds). This makes the TLS posture
 * of the target the distinguishing concern of this handler.
 *
 * Lifecycle for ONE attempt (docs/event-router-design.md §"At-least-once
 * dispatch protocol"):
 *
 *   1. `store.claim(...)` — atomically write a PENDING row keyed on
 *      `(rule_name, event_id)`. If the result is NOT `CLAIMED` the side-effect
 *      is SUPPRESSED (no POST) and we return a `suppressed` outcome — the
 *      "idempotent replay" guarantee.
 *   2. Render the rule's `with:` block against the event (`renderWith`),
 *      type-preserving. Crash-replay supplies a pre-rendered block via
 *      `ctx.renderedWith` and we skip this step.
 *   3. TLS-POSTURE CHECK on the target `url` (see {@link assertEndpointAllowed}).
 *      A refused endpoint is a terminal CONFIG error — mark PERMANENTLY_FAILED
 *      and return non-retryable WITHOUT POSTing.
 *   4. POST the rendered `body` to `url` via the shared `httpRequest` wrapper
 *      with a per-call timeout, forwarding the rendered `headers` verbatim.
 *   5. Map the response to a terminal status + outcome:
 *        2xx → SUCCEEDED          / { kind: 'succeeded' }
 *        4xx → PERMANENTLY_FAILED  / { kind: 'failed', retryable: false }
 *        5xx → FAILED             / { kind: 'failed', retryable: true }
 *      network / timeout → FAILED / { kind: 'failed', retryable: true }
 *
 *   The handler does NOT retry — the daemon dispatcher (#433) owns the
 *   retry/backoff loop and keys off `retryable`.
 *
 * TLS posture (docs/event-router-design.md §"Threat surface" / §"Security
 * model") — the distinguishing logic of this handler:
 *   - `https://` → always allowed; certificate validation is MANDATORY. We
 *     rely on Node's DEFAULT `rejectUnauthorized: true` (the shared
 *     `httpRequest` exposes NO insecure escape hatch). There is intentionally
 *     no `--insecure` equivalent in v1.
 *   - `http://` → allowed ONLY when the literal host is loopback
 *     (`127.0.0.1`, `::1`, `localhost`) or a private / non-routable address
 *     (RFC1918 `10/8`, `172.16/12`, `192.168/16`; link-local `169.254/16`;
 *     IPv6 ULA `fc00::/7`). Otherwise the dispatch is REFUSED: a plaintext
 *     POST (often carrying an `authorization` header) to a routable host is
 *     credential exposure, so we mark the row PERMANENTLY_FAILED and return a
 *     non-retryable failure WITHOUT sending anything.
 *
 * Field mapping (rendered `with:` → request):
 *   - `url`     → the absolute target URL. REQUIRED and must parse. A missing
 *                 / unparseable URL is a non-retryable config error.
 *   - `headers` → an object of string headers, forwarded VERBATIM to the wire
 *                 (this is where `authorization` typically rides). Optional.
 *   - `body`    → the request body. A string is sent as-is; any other value is
 *                 JSON-serialized and a `Content-Type: application/json` header
 *                 is defaulted (unless the rule set its own). Optional.
 *
 * Logging: rendered headers/body are passed through `redactForLogging` BEFORE
 * any log surface — delivery is verbatim, only LOG surfaces are redacted
 * (util/redaction.ts).
 *
 * Standalone-package isolation: imports ONLY from within
 * `packages/wft-router/src/`. No root-`src/` reach-in.
 *
 * Vendor-neutrality: no AI provider, chat platform, or CI vendor name appears
 * in this file.
 */

import { renderWith } from '../dispatch/index.js';
import { redactForLogging } from '../util/redaction.js';
import { httpRequest, HttpTimeoutError } from './http-client.js';
import type { Handler, HandlerContext, HandlerOutcome } from './types.js';

/** Default per-attempt HTTP timeout if the context does not pin one. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Result of the TLS / loopback posture check on a target URL. */
export interface EndpointDecision {
  allowed: boolean;
  /** Present only when `allowed` is false — a short, already-safe log detail. */
  reason?: string;
}

/**
 * Strip an IPv6 zone id and surrounding brackets from a hostname so the
 * classifier sees the bare address (`[::1]` and `::1%eth0` → `::1`).
 */
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1);
  }
  const zone = h.indexOf('%');
  if (zone !== -1) {
    h = h.slice(0, zone);
  }
  return h;
}

/** True when the literal host is an IPv4/IPv6 loopback or the `localhost` name. */
function isLoopbackHost(host: string): boolean {
  if (host === 'localhost') {
    return true;
  }
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  // Entire 127.0.0.0/8 block is loopback.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    return Number(m[1]) === 127;
  }
  return false;
}

/**
 * True when the literal host is an RFC1918 / link-local private IPv4 address
 * or an IPv6 unique-local address (ULA, `fc00::/7`). DNS is NOT resolved —
 * matching is purely on the literal in the URL, per the task contract.
 */
function isPrivateHost(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if ([a, b, Number(m[3]), Number(m[4])].some((o) => o > 255)) {
      return false;
    }
    if (a === 10) {
      return true; // 10.0.0.0/8
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true; // 172.16.0.0/12
    }
    if (a === 192 && b === 168) {
      return true; // 192.168.0.0/16
    }
    if (a === 169 && b === 254) {
      return true; // 169.254.0.0/16 link-local
    }
    return false;
  }
  // IPv6 ULA: fc00::/7 → first byte 0xFC or 0xFD (prefixes "fc"/"fd").
  if (host.includes(':')) {
    return host.startsWith('fc') || host.startsWith('fd');
  }
  return false;
}

/**
 * Decide whether a target URL may be dispatched to under the v1 TLS posture.
 *
 *   - `https://` → ALWAYS allowed (cert validation is enforced downstream by
 *     Node's default `rejectUnauthorized: true`; never disabled here).
 *   - `http://`  → allowed ONLY for loopback / private (non-routable) hosts;
 *     refused for any routable host (plaintext credential-exposure guard).
 *   - anything else (unparseable, non-http(s) scheme) → refused.
 *
 * Pure function; performs no I/O and no DNS resolution. Intended to be shared
 * later with the daemon startup check (#433).
 */
export function assertEndpointAllowed(rawUrl: string): EndpointDecision {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'target url is missing or unparseable' };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme === 'https:') {
    return { allowed: true };
  }
  if (scheme === 'http:') {
    const host = normalizeHost(parsed.hostname);
    if (isLoopbackHost(host) || isPrivateHost(host)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: 'http:// to non-loopback target refused (credential-exposure guard)',
    };
  }
  return { allowed: false, reason: `unsupported url scheme ${scheme}` };
}

/**
 * Read the rendered `headers` field as a string→string bag. Non-string values
 * are coerced with `String()` so a templated number still serializes onto the
 * wire. A non-object value yields an empty bag.
 */
function coerceHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === 'string' ? v : String(v);
    }
  }
  return out;
}

/** True when a header bag already carries a `content-type` (case-insensitive). */
function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
}

/**
 * Serialize the rendered `body` for the wire. A string is sent verbatim; any
 * other value (object/array/number) is JSON-encoded. `undefined` → no body.
 * Returns the serialized body plus whether a JSON content-type should be
 * defaulted (only when we JSON-encoded a non-string body).
 */
function buildBody(value: unknown): { body: string | undefined; jsonDefaulted: boolean } {
  if (value === undefined) {
    return { body: undefined, jsonDefaulted: false };
  }
  if (typeof value === 'string') {
    return { body: value, jsonDefaulted: false };
  }
  return { body: JSON.stringify(value), jsonDefaulted: true };
}

/**
 * The `webhook_post` handler. See module header for the full lifecycle
 * contract. One attempt, one {@link HandlerOutcome}.
 */
export const webhookPost: Handler = async (
  ctx: HandlerContext,
): Promise<HandlerOutcome> => {
  const { store, logger, identity } = ctx;

  // --- 1. Resolve the rendered payload. ----------------------------------
  let rendered: Record<string, unknown>;
  if (ctx.renderedWith !== undefined) {
    rendered = ctx.renderedWith;
  } else if (ctx.withBlock !== undefined) {
    rendered = renderWith(ctx.withBlock, ctx.event);
  } else {
    logger.error(
      { rule_name: identity.rule_name, event_id: identity.event_id },
      'webhook_post_no_payload',
    );
    return {
      kind: 'failed',
      retryable: false,
      detail: 'no with: block or rendered payload supplied',
    };
  }

  // Serialize once for the idempotency row; redact only the log COPY.
  const renderedJson = JSON.stringify(rendered);
  const redacted = redactForLogging(rendered);

  // --- 2. Claim the dispatch (idempotency gate). -------------------------
  const claim = store.claim({
    rule_name: identity.rule_name,
    event_id: identity.event_id,
    rendered_with_json: renderedJson,
    task_id: identity.task_id,
    to_status: identity.to_status,
    emitted_at_ms: identity.emitted_at_ms,
  });

  if (claim.kind !== 'CLAIMED') {
    const reason = claim.kind === 'ALREADY_PENDING' ? 'already_pending' : 'already_done';
    logger.info(
      { rule_name: identity.rule_name, event_id: identity.event_id, claim: claim.kind },
      'webhook_post_suppressed',
    );
    return { kind: 'suppressed', reason };
  }

  // --- 3. Resolve + validate the target URL. -----------------------------
  const rawUrl = rendered['url'];
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    store.complete(identity.rule_name, identity.event_id, 'PERMANENTLY_FAILED');
    logger.error(
      { rule_name: identity.rule_name, event_id: identity.event_id, payload: redacted },
      'webhook_post_missing_url',
    );
    return { kind: 'failed', retryable: false, detail: 'with.url is missing or empty' };
  }

  // --- 3a. TLS-posture / loopback guard (the distinguishing check). ------
  const decision = assertEndpointAllowed(rawUrl);
  if (!decision.allowed) {
    // Terminal CONFIG error — re-trying a refused endpoint cannot help. Mark
    // PERMANENTLY_FAILED and return WITHOUT sending anything.
    store.complete(identity.rule_name, identity.event_id, 'PERMANENTLY_FAILED');
    logger.error(
      {
        rule_name: identity.rule_name,
        event_id: identity.event_id,
        reason: decision.reason,
      },
      'webhook_post_endpoint_refused',
    );
    return {
      kind: 'failed',
      retryable: false,
      detail: decision.reason ?? 'endpoint refused',
    };
  }

  // --- 4. Build the request + perform the single POST attempt. -----------
  const headers = coerceHeaders(rendered['headers']);
  const { body, jsonDefaulted } = buildBody(rendered['body']);
  if (jsonDefaulted && !hasContentType(headers)) {
    headers['Content-Type'] = 'application/json';
  }

  let status: number;
  let bodyText: string;
  try {
    const res = await httpRequest({
      method: 'POST',
      url: rawUrl,
      headers,
      body,
      timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: ctx.fetchImpl,
    });
    status = res.status;
    bodyText = res.bodyText;
  } catch (err) {
    const isTimeout = err instanceof HttpTimeoutError;
    store.complete(identity.rule_name, identity.event_id, 'FAILED');
    const detail = isTimeout ? 'request timed out' : 'network error';
    logger.warn(
      {
        rule_name: identity.rule_name,
        event_id: identity.event_id,
        error: err instanceof Error ? err.message : String(err),
      },
      'webhook_post_transport_error',
    );
    return { kind: 'failed', retryable: true, detail };
  }

  // --- 5. Map the response status to a terminal status + outcome. --------
  if (status >= 200 && status < 300) {
    store.complete(identity.rule_name, identity.event_id, 'SUCCEEDED');
    logger.info(
      { rule_name: identity.rule_name, event_id: identity.event_id, status },
      'webhook_post_succeeded',
    );
    return { kind: 'succeeded' };
  }

  if (status >= 400 && status < 500) {
    store.complete(identity.rule_name, identity.event_id, 'PERMANENTLY_FAILED');
    logger.error(
      {
        rule_name: identity.rule_name,
        event_id: identity.event_id,
        status,
        body_excerpt: bodyText.slice(0, 256),
      },
      'webhook_post_client_error',
    );
    return {
      kind: 'failed',
      retryable: false,
      detail: `HTTP ${String(status)} (client error)`,
    };
  }

  // 5xx (and any other non-2xx) → retryable.
  store.complete(identity.rule_name, identity.event_id, 'FAILED');
  logger.warn(
    {
      rule_name: identity.rule_name,
      event_id: identity.event_id,
      status,
      body_excerpt: bodyText.slice(0, 256),
    },
    'webhook_post_server_error',
  );
  return {
    kind: 'failed',
    retryable: true,
    detail: `HTTP ${String(status)} (server error)`,
  };
};
