/**
 * triggers.yaml schema and loader for wft-router.
 *
 * The schema is the structural contract between the YAML author and the
 * router runtime. It is intentionally a CLOSED-WORLD shape — every object
 * uses `.strict()` so that unknown keys and unknown operators surface as
 * validation errors at startup (which the binary maps to exit code 78, per
 * `src/config/env.ts:199-216` convention).
 *
 * What this module owns (#422 scope):
 *   - Top-level `version` / `defaults` / `rules` shape.
 *   - The closed set of predicate operators that may appear inside a rule's
 *     `where:` block (see docs/event-router-design.md §"Predicate language").
 *   - The closed set of handler names that may appear as a rule's `do:`
 *     (see docs/event-router-design.md §"Action handlers — the pluggable
 *     layer"). The `with:` payload is intentionally an OPEN record at this
 *     layer; handler-specific schemas land in tasks #428-#431.
 *   - The schema-level enforcement of §"Templating" rule 1 ("Substitution
 *     position") — `{{...}}` may only appear as the ENTIRE string value of
 *     a `with:` field. Substitution-inside-a-larger-string is a security
 *     boundary violation and is rejected here.
 *
 * What this module does NOT own:
 *   - Sensitive-key NAME redaction in logs (§"Templating" rule 6) — that is
 *     runtime-time log redaction and lands in the logging task.
 *   - Handler-specific `with:` shape validation — opens up per handler in
 *     the four handler tasks.
 *   - Per-handler auth-env resolution — `token_env` only gets a NAME-shape
 *     check here; runtime resolution lands with the handlers.
 *
 * Vendor-neutrality: no provider, AI, chat, or CI name appears here.
 * `webhook_post` is the generic HTTP primitive; the schema is unaware of
 * any specific receiver. (See docs/event-router-design.md §"Vendor-neutral
 * guardrails".)
 */

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { ALLOWED_EVENT_TYPES } from './event-types.js';

/**
 * Local copy of the exit-code constant used on validation failure. The
 * standalone-package guideline forbids importing from the root `src/` tree,
 * so we redeclare the sysexits `EX_CONFIG` value here.
 */
export const EX_CONFIG = 78;

/** Status enum used by `status`, `status_in`, `from_status`, `to_status`. */
const StatusEnum = z.enum(['open', 'in_progress', 'done', 'closed', 'blocked', 'backlogged']);

/** Event-type enum derived from the shared allowlist. */
const EventTypeEnum = z.enum(ALLOWED_EVENT_TYPES);

/**
 * Predicate-operator object. Closed shape — `.strict()` ensures that an
 * unknown operator (e.g. `where: { not_an_operator: ... }`) becomes a
 * validation error and the binary exits 78 (§"Config validation" line 493).
 */
export const WhereSchema = z
  .object({
    project: z.union([z.string(), z.number().int()]).optional(),
    status: StatusEnum.optional(),
    status_in: z.array(StatusEnum).min(1).optional(),
    from_status: StatusEnum.optional(),
    to_status: StatusEnum.optional(),
    tags_contains_all: z.array(z.string()).min(1).optional(),
    tags_contains_any: z.array(z.string()).min(1).optional(),
    task_id: z.number().int().positive().optional(),
    parent_id: z.number().int().positive().optional(),
    assignee: z.string().min(1).optional(),
    source: z.enum(['user', 'workflow']).optional(),
    eventType: EventTypeEnum.optional(),
  })
  .strict();

/** Handler names — the four core handlers from §"Action handlers (v1)". */
const HandlerEnum = z.enum([
  'create_task_in_project',
  'webhook_post',
  'shell_exec',
  'agent_session_dispatch',
]);

/**
 * `with:` is intentionally an OPEN record at this layer. The shape varies
 * per handler and is locked down in tasks #428-#431. Templating-safety
 * (rule 1) is enforced by `validateTemplating` after zod parsing.
 */
const WithSchema = z.record(z.string(), z.unknown());

/** Per-rule schema. Overrides for the four `defaults` knobs are optional. */
export const RuleSchema = z
  .object({
    name: z.string().min(1),
    on: EventTypeEnum,
    where: WhereSchema,
    do: HandlerEnum,
    with: WithSchema,
    debounce_ms: z.number().int().nonnegative().optional(),
    idempotency_window_s: z.number().int().nonnegative().optional(),
    max_dispatches_per_minute: z.number().int().positive().optional(),
    max_retries: z.number().int().nonnegative().optional(),
    /**
     * Cold-start sweep opt-in (task #1005). When true (here or in
     * `defaults:`), the daemon queries the task-list REST API once on
     * startup for OPEN tasks matching this rule's `where:` block and — when
     * any match — synthesizes AT MOST ONE dispatch through the normal
     * handler path. Default OFF: absent = no startup behavior change.
     */
    sweep_on_start: z.boolean().optional(),
    /**
     * Periodic re-sweep interval in seconds (task #1035). When set (here or
     * in `defaults:`), the daemon re-runs the SAME sweep this rule's
     * `sweep_on_start` path uses, every `sweep_interval_s` seconds, with NO
     * router restart and NO new SSE event — closing the steady-state gap
     * where a session goes idle while the router is healthy. Bucket
     * idempotency (`sweep:<rule>:<floor(now / idempotency_window)>`) caps it
     * at one kick per window. Default OFF: absent (or 0) = no timer.
     */
    sweep_interval_s: z.number().int().positive().optional(),
  })
  .strict();

/** `defaults:` block — optional, all sub-keys optional with documented values. */
export const DefaultsSchema = z
  .object({
    /** Quiet window before dispatch; default 1500 ms per design spec. */
    debounce_ms: z.number().int().nonnegative().optional(),
    /** Idempotency cache TTL; default 3600 s per design spec. */
    idempotency_window_s: z.number().int().nonnegative().optional(),
    /** Per-rule rate cap; default 60 dispatches/min per design spec. */
    max_dispatches_per_minute: z.number().int().positive().optional(),
    /** Retry attempts before dead-letter; default 3 per design spec. */
    max_retries: z.number().int().nonnegative().optional(),
    /** Global cold-start sweep opt-in; per-rule `sweep_on_start` overrides. Default false. */
    sweep_on_start: z.boolean().optional(),
    /** Global periodic re-sweep interval (s); per-rule `sweep_interval_s` overrides. Default off. */
    sweep_interval_s: z.number().int().positive().optional(),
  })
  .strict();

/** Top-level triggers.yaml schema. */
export const TriggersConfigSchema = z
  .object({
    version: z.literal(1),
    defaults: DefaultsSchema.optional(),
    rules: z.array(RuleSchema).min(1),
  })
  .strict();

export type TriggersConfig = z.infer<typeof TriggersConfigSchema>;
export type TriggersRule = z.infer<typeof RuleSchema>;

/** Single templating issue surfaced by `validateTemplating`. */
export interface TemplatingIssue {
  /** Dotted JSON-like path into the rejected scalar (e.g. `rules[0].with.title`). */
  path: string;
  /** Human-readable rejection reason. */
  message: string;
}

/**
 * Matches a `{{...}}` substitution token. Used to detect both presence
 * (rule violation candidate) and "is this the WHOLE string" check.
 */
const TEMPLATE_TOKEN_RE = /\{\{[^}]*\}\}/;

/**
 * A pure-substitution string is one whose ENTIRE content is a single
 * `{{...}}` token with no surrounding text (whitespace also rejected, to
 * keep the rule unambiguous — concatenation has to happen upstream of the
 * template, not inside it).
 */
const PURE_SUBSTITUTION_RE = /^\{\{[^}]*\}\}$/;

/**
 * `token_env` env-var-name shape check. We only validate the NAME here;
 * runtime resolution lands with the handler tasks.
 */
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Walk every string in every rule's `with:` block and enforce
 * §"Templating" rule 1 ("Substitution position") and the `token_env`
 * env-var-name shape.
 *
 * Returns an EMPTY array when clean; one issue per violation otherwise.
 * Separate from the zod schema deliberately: zod's path-aware refines
 * across recursive `record` shapes are fiddly to author and even fiddlier
 * to read, and the schema's job here is shape — keep templating as a
 * focused second pass.
 */
export function validateTemplating(config: TriggersConfig): TemplatingIssue[] {
  const issues: TemplatingIssue[] = [];

  config.rules.forEach((rule, ruleIndex) => {
    const ruleBase = `rules[${ruleIndex}]`;
    walkWithValue(rule.with, `${ruleBase}.with`, issues);
  });

  return issues;
}

/** Recursive walker for any value living inside a `with:` block. */
function walkWithValue(value: unknown, path: string, issues: TemplatingIssue[]): void {
  if (typeof value === 'string') {
    checkStringForTemplatingViolations(value, path, issues);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      walkWithValue(item, `${path}[${i}]`, issues);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // The key `token_env` carries a name-shape constraint; enforce it here.
      if (k === 'token_env' && typeof v === 'string') {
        if (!ENV_VAR_NAME_RE.test(v)) {
          issues.push({
            path: `${path}.${k}`,
            message: `token_env must be an env-var name (UPPER_SNAKE, leading letter); got "${v}"`,
          });
        }
        continue;
      }
      walkWithValue(v, `${path}.${k}`, issues);
    }
  }
  // booleans, numbers, null, undefined: nothing to template-check.
}

/**
 * Apply the §"Templating" rule 1 check to a leaf string. ALLOWED forms:
 *   - No `{{...}}` token at all (literal value).
 *   - The entire string IS a single `{{...}}` token.
 * REJECTED:
 *   - A `{{...}}` token that appears alongside any other character
 *     (prefix, suffix, surrounding text, even leading/trailing whitespace).
 */
function checkStringForTemplatingViolations(
  s: string,
  path: string,
  issues: TemplatingIssue[],
): void {
  if (!TEMPLATE_TOKEN_RE.test(s)) {
    return;
  }
  if (PURE_SUBSTITUTION_RE.test(s)) {
    return;
  }
  issues.push({
    path,
    message:
      'templating: {{...}} substitution must occupy the entire string ' +
      '(see event-router-design.md §"Templating" rule 1 — substitutions ' +
      'at bare JSON value positions only)',
  });
}

/** Result of `loadAndValidateTriggers` — discriminated union. */
export type LoadAndValidateResult =
  | { ok: true; config: TriggersConfig }
  | { ok: false; errors: string[] };

/**
 * Enforce the documented `triggers.yaml` trust posture at startup: the file
 * that drives shell_exec / webhook_post / create_task / agent dispatch MUST be
 * owner-only (mode `0600`) and owned by the router user, because edit access is
 * equivalent to arbitrary code execution as the router. See
 * docs/event-router-design.md §"`triggers.yaml` trust posture".
 *
 * Mirrors the stat/owner/symlink hardening already used by
 * `handlers/agent-session-dispatch.ts:resolveAdapter`, applied to a SINGLE file:
 *   - The path is resolved through {@link realpathSync} and the REAL file is
 *     stat'd, so a symlink cannot point at a 0600 file while the link target is
 *     attacker-writable.
 *   - Mode is rejected if ANY group/other bit is set — `(mode & 0o077) !== 0`.
 *     This is the strict `0600` reading promised by the design doc, so
 *     0640/0644/0660/0666 all fail while 0600 passes.
 *   - Owner is rejected (POSIX only) when `process.getuid()` is defined and the
 *     real file's `uid` differs. `getuid` is undefined on Windows, where mode
 *     and uid bits are not meaningful — there, enforcement is skipped and file
 *     permissions are a deployment requirement.
 *
 * Returns `null` when the file passes (or the platform is non-POSIX); otherwise
 * a single `  - <file>: <message>` error string in the established result shape.
 */
function checkTriggersFilePermissions(filePath: string): string | null {
  const routerUid = process.getuid?.();
  // Non-POSIX (Windows): mode/uid bits are unreliable. Skip enforcement — file
  // permissions are a documented deployment requirement on that platform.
  if (routerUid === undefined) {
    return null;
  }

  let st: ReturnType<typeof statSync>;
  try {
    // Resolve symlinks so the bytes actually read are the ones we vet. lstat
    // first to surface a dangling-symlink/missing-target clearly.
    lstatSync(filePath);
    const realPath = realpathSync(filePath);
    st = statSync(realPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `  - ${filePath}: cannot stat for permission check: ${message}`;
  }

  if ((st.mode & 0o077) !== 0) {
    return `  - ${filePath}: insecure permissions (mode ${(st.mode & 0o777)
      .toString(8)
      .padStart(4, '0')}); must be mode 0600 / not accessible to group or other`;
  }

  if (st.uid !== routerUid) {
    return `  - ${filePath}: not owned by the router user (file uid ${st.uid}, router uid ${routerUid})`;
  }

  return null;
}

/**
 * Read a `triggers.yaml` file from disk, parse it, run the zod schema, and
 * then run the templating-safety pass. On success returns the typed config;
 * on failure returns a flat list of `  - <path>: <message>` strings formatted
 * identically to `src/config/env.ts:199-216` — the caller is expected to
 * print them under a "validation failed:" header and exit 78.
 */
export async function loadAndValidateTriggers(filePath: string): Promise<LoadAndValidateResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`  - <file>: cannot read ${filePath}: ${message}`] };
  }

  // Trust gate: the file just read must be owner-only and owned by the router
  // user (POSIX). Reject before parsing so an attacker-writable config never
  // reaches the handler dispatch surface. See checkTriggersFilePermissions.
  const permError = checkTriggersFilePermissions(filePath);
  if (permError !== null) {
    return { ok: false, errors: [permError] };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`  - <yaml>: parse error: ${message}`] };
  }

  if (parsed === null || parsed === undefined) {
    return { ok: false, errors: ['  - <yaml>: file is empty or contains no document'] };
  }

  const result = TriggersConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
      return `  - ${path}: ${issue.message}`;
    });
    return { ok: false, errors };
  }

  const templatingIssues = validateTemplating(result.data);
  if (templatingIssues.length > 0) {
    return {
      ok: false,
      errors: templatingIssues.map((i) => `  - ${i.path}: ${i.message}`),
    };
  }

  return { ok: true, config: result.data };
}
