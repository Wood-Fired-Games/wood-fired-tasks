/**
 * Core action handler: `create_task_in_project` (task #428).
 *
 * Given a triggered rule, this handler POSTs a templated task-creation
 * payload to the wood-fired-tasks REST API, consuming the PENDING→terminal
 * idempotency protocol and reporting a structured {@link HandlerOutcome}.
 *
 * It is the FIRST of the three v1 core handlers and establishes the shared
 * handler contract (`types.ts`) plus the shared HTTP transport
 * (`http-client.ts`) that the sibling handlers (#429 webhook_post, #430
 * shell_exec) reuse.
 *
 * Lifecycle for ONE attempt (docs/event-router-design.md §"At-least-once
 * dispatch protocol"):
 *
 *   1. `store.claim(...)` — atomically write a PENDING row keyed on
 *      `(rule_name, event_id)`. If the result is NOT `CLAIMED` the side-effect
 *      is SUPPRESSED (no POST) and we return a `suppressed` outcome — this is
 *      the "idempotent replay" guarantee.
 *   2. Render the rule's `with:` block against the event (`renderWith`),
 *      type-preserving. (Crash-replay supplies a pre-rendered block via
 *      `ctx.renderedWith` and we skip this step.)
 *   3. POST `${apiBaseUrl}/api/v1/projects/:id/tasks` via the shared
 *      `httpRequest` wrapper with a per-call timeout.
 *   4. Map the response to a terminal status + outcome:
 *        2xx → SUCCEEDED       / { kind: 'succeeded' }
 *        4xx → PERMANENTLY_FAILED / { kind: 'failed', retryable: false }
 *        5xx → FAILED          / { kind: 'failed', retryable: true }
 *      network / timeout → FAILED / { kind: 'failed', retryable: true }
 *
 *   The handler does NOT retry — the daemon dispatcher (#433) owns the
 *   retry/backoff loop and keys off `retryable`.
 *
 * Field mapping (rendered `with:` → request):
 *   - `project`             → the `:id` path segment (string or number; the
 *                             API resolves slug-or-id). REQUIRED — a missing
 *                             project is a non-retryable config error.
 *   - everything else       → POSTed verbatim as the JSON request body
 *                             (`title`, `body`, `labels`, `depends_on_external`,
 *                             …). The handler does NOT validate the full task
 *                             schema; the API's status code is the outcome
 *                             signal. The `project` key is stripped from the
 *                             body since it is carried in the path.
 *
 * Auth wire format (repo convention; mirrors `src/sse/auth.ts` and
 * `src/mcp/remote/rest-client.ts`): a token beginning `wft_pat_` is sent as
 * `Authorization: Bearer <token>`, anything else as `X-API-Key: <token>`.
 * The rule is inlined here (a one-line string-prefix test) rather than
 * imported, to keep the handler's import surface to exactly the idempotency
 * store, the template renderer, the HTTP wrapper, and types/logging.
 *
 * Logging: the rendered payload is passed through `redactForLogging` BEFORE it
 * reaches any log surface — handler DELIVERY is verbatim, only LOG surfaces
 * are redacted (util/redaction.ts).
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

/** Token prefix that selects the Bearer auth path (repo PAT convention). */
const PAT_PREFIX = 'wft_pat_';

/** Default per-attempt HTTP timeout if the context does not pin one. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Build the auth header pair for a token, per the repo precedence rule. */
function authHeaderFor(token: string): { name: string; value: string } {
  if (token.startsWith(PAT_PREFIX)) {
    return { name: 'Authorization', value: `Bearer ${token}` };
  }
  return { name: 'X-API-Key', value: token };
}

/**
 * Resolve the `project` path segment from a rendered `with:` block. Accepts a
 * number (project id) or a non-empty string (slug or id). Returns the
 * URL-encoded segment, or `null` when the value is missing / unusable.
 */
function resolveProjectSegment(rendered: Record<string, unknown>): string | null {
  const value = rendered['project'];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return encodeURIComponent(String(value));
  }
  if (typeof value === 'string' && value.length > 0) {
    return encodeURIComponent(value);
  }
  return null;
}

/** Strip the trailing slash from the base URL so path joins are predictable. */
function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * Build the JSON request body from the rendered block: every key EXCEPT
 * `project` (which lives in the path). Returns a fresh object — never mutates
 * the input.
 */
function buildRequestBody(rendered: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rendered)) {
    if (k === 'project') {
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * The `create_task_in_project` handler. See module header for the full
 * lifecycle contract. One attempt, one {@link HandlerOutcome}.
 */
export const createTaskInProject: Handler = async (
  ctx: HandlerContext,
): Promise<HandlerOutcome> => {
  const { store, logger, identity } = ctx;

  // --- 1. Resolve the rendered payload. ----------------------------------
  // Crash-replay supplies `renderedWith`; the live path renders the raw
  // `with:` block against the event. Exactly one source must be present.
  let rendered: Record<string, unknown>;
  if (ctx.renderedWith !== undefined) {
    rendered = ctx.renderedWith;
  } else if (ctx.withBlock !== undefined) {
    rendered = renderWith(ctx.withBlock, ctx.event);
  } else {
    // Misconfiguration: nothing to send. Non-retryable — re-trying cannot
    // conjure a payload. We do NOT claim, since there is no side-effect to
    // dedup.
    logger.error(
      { rule_name: identity.rule_name, event_id: identity.event_id },
      'create_task_no_payload',
    );
    return {
      kind: 'failed',
      retryable: false,
      detail: 'no with: block or rendered payload supplied',
    };
  }

  // Serialize once — the same JSON is persisted in the idempotency row and
  // sent on the wire. Redact only the COPY that hits the log surface.
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
      {
        rule_name: identity.rule_name,
        event_id: identity.event_id,
        claim: claim.kind,
      },
      'create_task_suppressed',
    );
    return { kind: 'suppressed', reason };
  }

  // --- 3. Resolve the project path segment. ------------------------------
  const projectSegment = resolveProjectSegment(rendered);
  if (projectSegment === null) {
    // Terminal config error — a re-try cannot fix a missing project. Mark
    // PERMANENTLY_FAILED so the claimed PENDING row reaches a terminal state.
    store.complete(identity.rule_name, identity.event_id, 'PERMANENTLY_FAILED');
    logger.error(
      {
        rule_name: identity.rule_name,
        event_id: identity.event_id,
        payload: redacted,
      },
      'create_task_missing_project',
    );
    return { kind: 'failed', retryable: false, detail: 'with.project is missing or empty' };
  }

  const url = `${trimBase(ctx.apiBaseUrl)}/api/v1/projects/${projectSegment}/tasks`;
  const body = JSON.stringify(buildRequestBody(rendered));
  const auth = authHeaderFor(ctx.authToken);

  // --- 4. Perform the single POST attempt. -------------------------------
  let status: number;
  let bodyText: string;
  try {
    const res = await httpRequest({
      method: 'POST',
      url,
      headers: {
        [auth.name]: auth.value,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(ctx.fetchImpl !== undefined && { fetchImpl: ctx.fetchImpl }),
    });
    status = res.status;
    bodyText = res.bodyText;
  } catch (err) {
    // Network failure or timeout → retryable. The dispatcher re-enqueues.
    const isTimeout = err instanceof HttpTimeoutError;
    store.complete(identity.rule_name, identity.event_id, 'FAILED');
    const detail = isTimeout ? 'request timed out' : 'network error';
    logger.warn(
      {
        rule_name: identity.rule_name,
        event_id: identity.event_id,
        error: err instanceof Error ? err.message : String(err),
      },
      'create_task_transport_error',
    );
    return { kind: 'failed', retryable: true, detail };
  }

  // --- 5. Map the response status to a terminal status + outcome. --------
  if (status >= 200 && status < 300) {
    store.complete(identity.rule_name, identity.event_id, 'SUCCEEDED');
    logger.info(
      { rule_name: identity.rule_name, event_id: identity.event_id, status },
      'create_task_succeeded',
    );
    return { kind: 'succeeded' };
  }

  if (status >= 400 && status < 500) {
    // 4xx is a terminal client error — bad payload, auth, not-found. Re-trying
    // the same request will not help.
    store.complete(identity.rule_name, identity.event_id, 'PERMANENTLY_FAILED');
    logger.error(
      {
        rule_name: identity.rule_name,
        event_id: identity.event_id,
        status,
        body_excerpt: bodyText.slice(0, 256),
      },
      'create_task_client_error',
    );
    return {
      kind: 'failed',
      retryable: false,
      detail: `HTTP ${String(status)} (client error)`,
    };
  }

  // 5xx (and any other non-2xx, e.g. 3xx we didn't follow) → retryable.
  store.complete(identity.rule_name, identity.event_id, 'FAILED');
  logger.warn(
    {
      rule_name: identity.rule_name,
      event_id: identity.event_id,
      status,
      body_excerpt: bodyText.slice(0, 256),
    },
    'create_task_server_error',
  );
  return {
    kind: 'failed',
    retryable: true,
    detail: `HTTP ${String(status)} (server error)`,
  };
};
