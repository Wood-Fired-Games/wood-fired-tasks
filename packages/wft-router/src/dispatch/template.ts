/**
 * Templating renderer for the wft-router `with:` block (task #426).
 *
 * Substitutes `{{task.<dotted.path>}}` tokens against a live event payload
 * AT DISPATCH TIME. The schema task (#422) already rejected substitutions
 * that appear anywhere other than as the ENTIRE string value of a `with:`
 * leaf, but this renderer re-checks defensively so a config that bypassed
 * the validator (programmatic, future loader, etc.) still cannot smuggle a
 * string-spliced injection through.
 *
 * The implementation enforces ALL SIX templating rules from
 * docs/event-router-design.md §"Templating" (lines 213-244):
 *
 *   Rule 1 — Substitution position. ENTIRE-string-only; mixed strings throw
 *            TemplatingError (defensive re-check; schema is first line).
 *   Rule 2 — Encoding by type preservation. We never string-concatenate;
 *            we REPLACE the leaf string with the resolved value at the
 *            same JSON position, so `"id": "{{task.id}}"` becomes a number
 *            `"id": 42`. No escape risk — a `"` inside a resolved string
 *            lands inside a real string field, never spliced into a parent.
 *   Rule 3 — Length cap at 4 KiB UTF-8 bytes; truncate to
 *            `<2 KiB-head>…<2 KiB-tail>` and WARN-log.
 *   Rule 4 — Chat-handler control-character strip (`<!`, `<@`, `<#`).
 *            Opt-in via `stripChatControls`; default off because no v1
 *            core handler is a chat surface.
 *   Rule 5 — Path-miss returns the JSON literal `null` (not the string
 *            "null"); WARN-log with the missed path.
 *   Rule 6 — Sensitive-key NAME redaction lives in util/redaction.ts and
 *            is applied by callers BEFORE logging the rendered output.
 *            This renderer NEVER redacts; handlers receive verbatim values.
 *
 * Hard constraints honoured here:
 *   - No dynamic code evaluation (the path resolver is a literal split-and-
 *     property-walk).
 *   - Pure function; returns a fresh tree, never mutates the input.
 *   - Vendor-neutral: no provider, AI vendor, chat platform, or CI name
 *     appears in code, comments, or default values.
 *
 * Standalone-package isolation: only imports the `EventPayloadShape` type
 * from the sibling predicate module; no root-`src/` reach-in.
 */

import type { EventPayloadShape } from './predicate.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimum logger surface this module needs. Matches the SSE-client
 * `SSELogger` shape so callers can pass either one; tests typically pass
 * an in-memory recorder so WARN payloads can be asserted directly.
 */
export interface TemplateLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** Options for `renderWith`. Every field optional; defaults below match the spec. */
export interface RenderOptions {
  /**
   * Rule 4 opt-in. When `true`, strip `<!`, `<@`, `<#` from substituted
   * STRING values before the length-cap pass. v1 core handlers do not set
   * this; only a future chat-specialised handler should.
   */
  stripChatControls?: boolean;
  /** Optional WARN-log sink for path-miss (rule 5) and truncation (rule 3). */
  logger?: TemplateLogger;
  /** UTF-8 byte ceiling for a substituted string before truncation (default 4096). */
  maxValueBytes?: number;
  /** UTF-8 byte budget for the truncation head (default 2048). */
  truncatedHeadBytes?: number;
  /** UTF-8 byte budget for the truncation tail (default 2048). */
  truncatedTailBytes?: number;
}

/** Thrown when a `with:` value violates rule 1 at render time. */
export class TemplatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplatingError';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Detects any presence of a `{{...}}` token within a string. */
const TOKEN_PRESENT_RE = /\{\{[^}]*\}\}/;

/**
 * The strictly-allowed substitution form: ENTIRE string IS a single
 * `{{task.<dotted.path>}}` expression with no surrounding characters.
 * Captures the dotted-path tail (without the `task.` prefix).
 */
const PURE_SUBSTITUTION_RE = /^\{\{task\.([a-zA-Z0-9_.]+)\}\}$/;

/** Ellipsis character used to join the head and tail of a truncated value. */
const TRUNCATION_ELLIPSIS = '…';

/** Default UTF-8 byte ceilings, per spec §"Templating" rule 3. */
const DEFAULT_MAX_VALUE_BYTES = 4096;
const DEFAULT_TRUNCATED_HEAD_BYTES = 2048;
const DEFAULT_TRUNCATED_TAIL_BYTES = 2048;

/** Chat-handler control prefixes stripped under rule 4. */
const CHAT_CONTROL_SEQUENCES = ['<!', '<@', '<#'] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a `with:` block against an event payload. Returns a NEW tree with
 * every `{{task.<path>}}` token resolved; the input is never mutated.
 *
 * - Type preservation (rule 2): a leaf string that IS a pure substitution
 *   token is replaced by the resolved value at the same JSON position. If
 *   the resolved value is a number, the output field is a number. The
 *   renderer never string-concatenates.
 * - Path miss (rule 5): a missing path resolves to the JSON literal `null`
 *   and emits a WARN log via the injected logger (if any).
 * - Length cap (rule 3): a RESOLVED STRING longer than `maxValueBytes`
 *   UTF-8 bytes is truncated to `<head>…<tail>` and a WARN log fires.
 * - Chat-control strip (rule 4): only applied when `stripChatControls` is
 *   true; runs BEFORE the length cap.
 *
 * @throws TemplatingError when a leaf string contains `{{...}}` but is not
 *   a pure substitution (defensive re-check of rule 1).
 */
export function renderWith(
  withBlock: Record<string, unknown>,
  event: EventPayloadShape,
  opts: RenderOptions = {},
): Record<string, unknown> {
  const ctx: RenderContext = {
    event,
    stripChatControls: opts.stripChatControls ?? false,
    logger: opts.logger,
    maxValueBytes: opts.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES,
    headBytes: opts.truncatedHeadBytes ?? DEFAULT_TRUNCATED_HEAD_BYTES,
    tailBytes: opts.truncatedTailBytes ?? DEFAULT_TRUNCATED_TAIL_BYTES,
  };
  return walk(withBlock, ctx, 'with') as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface RenderContext {
  event: EventPayloadShape;
  stripChatControls: boolean;
  logger: TemplateLogger | undefined;
  maxValueBytes: number;
  headBytes: number;
  tailBytes: number;
}

/**
 * Recursive walker. Returns the rendered counterpart of `value`:
 *   - Objects → fresh object with each value rendered.
 *   - Arrays  → fresh array with each item rendered.
 *   - Strings → either pass-through (no token), pure-substitution resolved
 *               value (rule 1+2), or `TemplatingError` (rule 1 violation).
 *   - Other primitives → returned as-is.
 */
function walk(value: unknown, ctx: RenderContext, path: string): unknown {
  if (typeof value === 'string') {
    return renderString(value, ctx, path);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => walk(item, ctx, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, ctx, `${path}.${k}`);
    }
    return out;
  }
  return value;
}

/**
 * Resolve a leaf string. Three branches:
 *   (a) Pure substitution `{{task.<path>}}` → resolve path, apply rules
 *       3/4/5 to STRING results, return the resolved value (any type).
 *   (b) Contains `{{...}}` but not pure → throw TemplatingError (rule 1).
 *   (c) No token → return unchanged.
 */
function renderString(raw: string, ctx: RenderContext, path: string): unknown {
  const pure = PURE_SUBSTITUTION_RE.exec(raw);
  if (pure !== null) {
    const dottedPath = pure[1] ?? '';
    const resolved = resolvePath(ctx.event, dottedPath);
    if (resolved === undefined) {
      ctx.logger?.warn('templating_miss', {
        with_path: path,
        token_path: `task.${dottedPath}`,
      });
      return null;
    }
    if (typeof resolved === 'string') {
      return applyStringRules(resolved, ctx, path);
    }
    return resolved;
  }
  if (TOKEN_PRESENT_RE.test(raw)) {
    throw new TemplatingError(
      `templating: {{...}} substitution must occupy the entire string ` +
        `(at ${path}). Mixed substitutions are rejected at config-parse ` +
        `time; this is the runtime defense.`,
    );
  }
  return raw;
}

/**
 * Apply the STRING-only rules (rule 4 strip, rule 3 length-cap) to a value
 * that came out of substitution. Order matters: strip first, then cap, so
 * the cap reflects the final byte count delivered to the handler.
 */
function applyStringRules(value: string, ctx: RenderContext, path: string): string {
  let s = value;
  if (ctx.stripChatControls) {
    for (const seq of CHAT_CONTROL_SEQUENCES) {
      s = s.split(seq).join('');
    }
  }
  const originalBytes = Buffer.byteLength(s, 'utf8');
  if (originalBytes <= ctx.maxValueBytes) {
    return s;
  }
  const truncated = truncateUtf8(s, ctx.headBytes, ctx.tailBytes);
  ctx.logger?.warn('templating_truncated', {
    with_path: path,
    original_bytes: originalBytes,
    truncated_bytes: Buffer.byteLength(truncated, 'utf8'),
    head_bytes: ctx.headBytes,
    tail_bytes: ctx.tailBytes,
  });
  return truncated;
}

/**
 * Resolve `event.task.<dotted.path>` (the leading `task.` of the token is
 * dropped by the caller and re-prepended here). Walks the event tree
 * rooted at `event.task` and returns the value at the supplied dotted
 * path.
 *
 * Returns `undefined` if any segment misses or if a non-object is
 * encountered mid-walk. The result preserves the original type — numbers
 * stay numbers, arrays stay arrays, etc.
 */
function resolvePath(event: EventPayloadShape, dottedPath: string): unknown {
  const segments = dottedPath.split('.');
  // Tokens are spelled `task.<path>`; root the walk at event.task.
  let current: unknown = (event as unknown as Record<string, unknown>).task;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Truncate a UTF-8 string to a head + ellipsis + tail composition, measured
 * in BYTES (not JS code units). Boundary handling: if a head/tail byte
 * budget falls mid-code-point, the slice is rolled back to the nearest
 * preceding code-point boundary so the result decodes cleanly.
 */
function truncateUtf8(s: string, headBytes: number, tailBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  const head = sliceAtCodepointBoundary(buf, 0, headBytes);
  const tail = sliceAtCodepointBoundary(buf, buf.length - tailBytes, buf.length);
  return `${head}${TRUNCATION_ELLIPSIS}${tail}`;
}

/**
 * Slice `buf[start..end]` adjusted so neither bound splits a UTF-8 code
 * point. `start` rolls FORWARD to the next code-point boundary; `end`
 * rolls BACKWARD. Bounds are clamped into the buffer.
 */
function sliceAtCodepointBoundary(buf: Buffer, start: number, end: number): string {
  const lo = Math.max(0, Math.min(buf.length, start));
  const hi = Math.max(lo, Math.min(buf.length, end));
  let adjustedLo = lo;
  while (adjustedLo < buf.length && isUtf8ContinuationByte(buf[adjustedLo]!)) {
    adjustedLo += 1;
  }
  let adjustedHi = hi;
  while (adjustedHi > adjustedLo && isUtf8ContinuationByte(buf[adjustedHi]!)) {
    adjustedHi -= 1;
  }
  return buf.subarray(adjustedLo, adjustedHi).toString('utf8');
}

/** True for any byte of the form 10xxxxxx (continuation byte in UTF-8). */
function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}
