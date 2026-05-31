import type { VerificationEvidence } from '../types/task.js';

/**
 * task #608 (PIECE A) — anti-fabrication validation of
 * `verification_evidence`.
 *
 * This module is a PURE function: no DB, no config, no I/O. The service
 * layer (src/services/task.service.ts) only invokes it when the
 * `WFT_STRICT_EVIDENCE` flag is on AND the update supplies a non-null
 * `verification_evidence`. With the flag off (the default) this code never
 * runs, so the existing test suite — none of which sets the flag — is
 * unaffected.
 *
 * The Zod schema (src/schemas/task.schema.ts#VerificationEvidenceSchema)
 * already guarantees STRUCTURE (verdict enum, string bounds, etc.). This
 * function layers SEMANTIC anti-fabrication checks on top: it rejects the
 * tell-tale shapes of a self-graded or fabricated verdict.
 */

/**
 * Context the validator needs to enforce generator/critic separation.
 *
 * `taskAssignee` / `taskAssigneeUserId` come from the existing task row;
 * `callerId` is the authenticated identity threaded from the calling surface
 * (REST: `requireUser(request).id`; MCP: `ctx.actorUserId`). Any of these
 * may be null/undefined when the surface cannot supply them — the
 * caller-equality sub-check is skipped when `callerId` is null/undefined.
 *
 * Ids are typed loosely (string | number) because the task row carries a
 * numeric FK (`assignee_user_id`) and a TEXT name (`assignee`), while the
 * authenticated principal carries a numeric `id`. Comparisons are done on
 * the trimmed string form so a numeric FK and a stringified session id
 * collide correctly.
 */
export interface EvidenceValidationContext {
  taskAssignee?: string | null;
  taskAssigneeUserId?: string | number | null;
  callerId?: string | number | null;
}

/**
 * Session ids that look like the orchestrator grading its own work. A
 * verifier session must be a DISTINCT critic — not the loop driver, not
 * "self", not the main loop. Matched case-insensitively at the START of the
 * string so `orchestrator-7`, `self`, `main-loop-3` all trip it.
 */
const SELF_GRADING_SESSION_PATTERN = /^(orchestrator|self|main-loop)/i;

/**
 * Placeholder strings that are NOT real evidence. A check whose
 * `evidence_url_or_text` is one of these (trimmed, case-insensitive) is a
 * fabricated/empty gate.
 */
const PLACEHOLDER_EVIDENCE_DENYLIST = new Set([
  'ok',
  'pass',
  'done',
  'n/a',
  'na',
  'tbd',
]);

/**
 * Normalize an id-ish value to a trimmed string, or null when absent/blank.
 */
function normalizeId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

/**
 * Validate `evidence` for anti-fabrication. Returns a list of
 * human-readable violation messages — empty means OK.
 *
 * Checks (all independent; every violation is reported):
 *  1. `verifier_session_id` must be present and non-blank; must not match the
 *     self-grading pattern; must differ from the task assignee, the task
 *     assignee_user_id, and (when provided) the caller id.
 *  2. Every `checks[]` entry's `evidence_url_or_text` must be non-blank and
 *     not a placeholder denylist token.
 *  3. A `PASS` verdict requires at least one check.
 */
export function validateVerificationEvidence(
  evidence: VerificationEvidence,
  ctx: EvidenceValidationContext,
): string[] {
  const violations: string[] = [];

  // --- Check 1: verifier_session_id (generator/critic separation) ---
  const sessionId =
    typeof evidence.verifier_session_id === 'string'
      ? evidence.verifier_session_id.trim()
      : '';

  if (sessionId.length === 0) {
    violations.push(
      'verifier_session_id is required and must be a non-empty identifier ' +
        'naming the distinct verifier session that produced this verdict.',
    );
  } else {
    if (SELF_GRADING_SESSION_PATTERN.test(sessionId)) {
      violations.push(
        `verifier_session_id "${sessionId}" looks like self-grading ` +
          '(orchestrator/self/main-loop). Verification must come from a ' +
          'distinct critic session, not the loop driver.',
      );
    }

    const taskAssignee = normalizeId(ctx.taskAssignee);
    const taskAssigneeUserId = normalizeId(ctx.taskAssigneeUserId);
    const callerId = normalizeId(ctx.callerId);
    const sessionKey = sessionId.toLowerCase();

    if (taskAssignee !== null && sessionKey === taskAssignee.toLowerCase()) {
      violations.push(
        `verifier_session_id "${sessionId}" equals the task assignee — the ` +
          'generator cannot verify its own work (generator/critic separation).',
      );
    }
    if (
      taskAssigneeUserId !== null &&
      sessionKey === taskAssigneeUserId.toLowerCase()
    ) {
      violations.push(
        `verifier_session_id "${sessionId}" equals the task assignee user id ` +
          '— the generator cannot verify its own work (generator/critic ' +
          'separation).',
      );
    }
    if (callerId !== null && sessionKey === callerId.toLowerCase()) {
      violations.push(
        `verifier_session_id "${sessionId}" equals the calling identity — the ` +
          'caller submitting the verdict cannot also be the verifier ' +
          '(generator/critic separation).',
      );
    }
  }

  // --- Check 2: each check must carry real evidence ---
  if (Array.isArray(evidence.checks)) {
    evidence.checks.forEach((check, idx) => {
      const text =
        typeof check.evidence_url_or_text === 'string'
          ? check.evidence_url_or_text.trim()
          : '';
      const label = check?.name ? `"${check.name}"` : `#${idx}`;
      if (text.length === 0) {
        violations.push(
          `check ${label}: evidence_url_or_text is empty — every check must ` +
            'carry concrete evidence (a URL or a description of what was seen).',
        );
      } else if (PLACEHOLDER_EVIDENCE_DENYLIST.has(text.toLowerCase())) {
        violations.push(
          `check ${label}: evidence_url_or_text "${text}" is a placeholder, ` +
            'not real evidence. Provide a URL or a concrete description.',
        );
      }
    });
  }

  // --- Check 3: a PASS verdict must have at least one check ---
  if (evidence.verdict === 'PASS') {
    if (!Array.isArray(evidence.checks) || evidence.checks.length === 0) {
      violations.push(
        'verdict PASS requires at least one entry in checks[] — a bare PASS ' +
          'with no checks is unverifiable.',
      );
    }
  }

  return violations;
}
