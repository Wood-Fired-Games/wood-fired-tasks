/**
 * Sensitive-key NAME redaction for log paths (task #426).
 *
 * The router is intentionally split into two value-handling paths:
 *
 *   1. HANDLER DELIVERY — the rendered `with:` payload reaches the handler
 *      VERBATIM. A webhook receiver needs the real `authorization: Bearer
 *      xyz` value to make the call, so the template renderer (template.ts)
 *      never touches values, only positions.
 *
 *   2. LOG EMISSION — when a rendered payload is written to any log surface
 *      (pino stdout, dispatch.log, error breadcrumbs) the same payload is
 *      first passed through `redactForLogging` so secrets do not land in
 *      operator-visible logs.
 *
 * Redaction is by KEY NAME, not by value heuristics. The regex is
 * intentionally minimal and stable; the constant lives here so the logging
 * task (#427) imports the SAME regex via pino's `redact` path — guaranteeing
 * the two redaction surfaces stay in lockstep with zero drift risk.
 *
 * Vendor-neutrality: this file is part of the wft-router standalone package;
 * it must not reference any provider, AI vendor, chat platform, or CI name
 * (see docs/event-router-design.md §Vendor-neutral guardrails).
 *
 * Hard constraints honoured here:
 *   - No dynamic code evaluation of any kind.
 *   - Pure function; never mutates inputs.
 *   - Circular reference safe (WeakSet guard).
 */

/**
 * Anchored, case-insensitive match against well-known credential-bearing
 * key names. Anchors are deliberate — `mytoken` and `tokenized` MUST NOT
 * be redacted (false positives leak otherwise-useful debug context).
 *
 * Covered names: token, secret, password, api_key / api-key / apikey,
 * authorization, cookie.
 */
export const SENSITIVE_KEY_RE = /^(token|secret|password|api[_-]?key|authorization|cookie)$/i;

/** Test a single key name against the sensitive-key allowlist. */
export function isSensitiveKey(name: string): boolean {
  return SENSITIVE_KEY_RE.test(name);
}

/** Replacement marker for redacted values; matches operator-log convention. */
const REDACTED_MARKER = '***';

/** Marker emitted when the walker re-encounters an already-seen object. */
const CIRCULAR_MARKER = '[CIRCULAR]';

/**
 * Deep-walk `value`, returning a structurally-identical copy in which every
 * object key matched by `SENSITIVE_KEY_RE` has its value replaced with the
 * literal string `'***'`. Arrays, primitives, and `null` are preserved.
 *
 * Behaviour notes:
 *   - Input is NEVER mutated; a fresh container is allocated at every nested
 *     level.
 *   - Redacted values are replaced regardless of their original type —
 *     numbers, objects, arrays under a sensitive key all collapse to `'***'`.
 *   - Circular references resolve to the literal string `'[CIRCULAR]'`
 *     instead of throwing, so a stray cycle in log context cannot crash the
 *     router.
 *   - Non-object, non-array inputs (primitives, `null`, `undefined`) return
 *     unchanged.
 */
export function redactForLogging<T>(value: T): T {
  const seen = new WeakSet<object>();

  function walk(v: unknown): unknown {
    if (v === null || typeof v !== 'object') {
      return v;
    }
    if (seen.has(v as object)) {
      return CIRCULAR_MARKER;
    }
    seen.add(v as object);

    if (Array.isArray(v)) {
      return v.map((item) => walk(item));
    }

    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED_MARKER : walk(val);
    }
    return out;
  }

  return walk(value) as T;
}
