import { describe, expect, it } from 'vitest';

import { VERIFICATION_VERDICTS } from '../../../schemas/task.schema.js';
import {
  type AuditRun,
  AuditRunFrontmatterSchema,
  type AuditRunFrontmatter,
  AuditRunSchema,
  AuditScoreSchema,
  type AuditTaskEntry,
  AuditTaskEntrySchema,
  IntegrationVerdictSchema,
  VerifierVerdictSchema,
} from '../schema.js';

/**
 * Wave 7.1 (task #323) — falsifiable tests for the AUDIT.md
 * frontmatter schema, the per-task entry schema, and the roll-up
 * envelope. Mirrors the constraints documented in
 * `docs/tasks-audit-design.md` §4 so a future schema drift breaks
 * compilation here AND fails the design doc's static gate in
 * `src/api/routes/tasks/__tests__/skill-audit-design.test.ts`.
 *
 * Runtime guardrails NOT enforceable by zod (and therefore not tested
 * here — they are tested by the design-doc gate test): read-only
 * source-tree constraint, read-only bugs-DB constraint, $5 hard cost
 * cap, AC reconstruction for NULL columns. The schema simply accepts
 * counts and totals at the type level; the invariants are pipeline
 * logic.
 */

const VALID_FRONTMATTER: AuditRunFrontmatter = {
  run_id: '84ae52df-1234-4abc-9d2e-3c8a0f1d4a55',
  audit_id: '7c1a0b9e-f8c2-4d7b-9d2e-3c8a0f1d4a99',
  project_id: 12,
  audit_started_at: '2026-05-23T20:20:13Z',
  audit_ended_at: '2026-05-23T20:24:47Z',
  total_tasks: 15,
  covered_count: 13,
  partial_count: 1,
  missing_count: 1,
  integration_verdict: 'MISSING',
  total_usd: 4.5,
  cost_cap_hit: false,
};

const VALID_TASK_ENTRY: AuditTaskEntry = {
  task_id: 256,
  title: 'Add OIDC discovery doc to openid-client',
  score: 'COVERED',
  verifier_verdict: 'PASS',
  check_count: 3,
};

describe('AuditRunFrontmatterSchema', () => {
  it('accepts a well-formed frontmatter block', () => {
    expect(AuditRunFrontmatterSchema.safeParse(VALID_FRONTMATTER).success).toBe(true);
  });

  it('exposes every required frontmatter field in the schema shape', () => {
    const required = [
      'run_id',
      'audit_id',
      'project_id',
      'audit_started_at',
      'audit_ended_at',
      'total_tasks',
      'covered_count',
      'partial_count',
      'missing_count',
      'integration_verdict',
      'total_usd',
      'cost_cap_hit',
    ] as const;
    const shapeKeys = new Set(Object.keys(AuditRunFrontmatterSchema.shape));
    for (const field of required) {
      expect(shapeKeys.has(field)).toBe(true);
    }
  });

  it('rejects a non-UUID run_id', () => {
    expect(
      AuditRunFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        run_id: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });

  it('rejects a non-UUID audit_id', () => {
    expect(
      AuditRunFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        audit_id: 'nope',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown integration_verdict value', () => {
    expect(
      AuditRunFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        integration_verdict: 'PASS',
      }).success,
    ).toBe(false);
  });

  it('rejects negative covered_count', () => {
    expect(
      AuditRunFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        covered_count: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects non-integer total_tasks', () => {
    expect(
      AuditRunFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        total_tasks: 15.5,
      }).success,
    ).toBe(false);
  });

  it('rejects negative total_usd', () => {
    expect(
      AuditRunFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        total_usd: -0.01,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-boolean cost_cap_hit', () => {
    expect(
      AuditRunFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        cost_cap_hit: 'true' as unknown as boolean,
      }).success,
    ).toBe(false);
  });

  it('rejects project_id of 0 (must be positive)', () => {
    expect(
      AuditRunFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        project_id: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-RFC3339 audit_started_at', () => {
    expect(
      AuditRunFrontmatterSchema.safeParse({
        ...VALID_FRONTMATTER,
        audit_started_at: 'yesterday',
      }).success,
    ).toBe(false);
  });

  it('still parses when covered + partial + missing != total_tasks (schema does not enforce count invariant)', () => {
    // docs/tasks-audit-design.md §4 notes the invariant
    //   covered_count + partial_count + missing_count == total_tasks
    // but explicitly delegates enforcement to the audit pipeline, not
    // the schema (same posture as LoopRunFrontmatterSchema's
    // tasks_attempted sum invariant in docs/loop-run-schema.md §3).
    // This test LOCKS IN that behaviour so a well-meaning future edit
    // doesn't quietly add a `.refine()` and break callers that emit
    // partial frontmatter mid-run (e.g. the $5 cost-cap halt branch
    // writes a partial AUDIT.md with covered=partial=missing=0 and
    // total_tasks > 0).
    const mismatched = {
      ...VALID_FRONTMATTER,
      total_tasks: 15,
      covered_count: 0,
      partial_count: 0,
      missing_count: 0,
    };
    expect(AuditRunFrontmatterSchema.safeParse(mismatched).success).toBe(true);
  });

  it('audit pipeline MUST construct counts so covered+partial+missing == total_tasks (invariant locked by construction, not schema)', () => {
    // Companion to the previous test. The schema deliberately does NOT
    // refine — but every happy-path AUDIT.md the runtime emits MUST
    // satisfy the invariant. We assert it holds for the canonical
    // VALID_FRONTMATTER so any future "polish" of the fixture that
    // breaks the invariant flags here loudly. This is the
    // construction-side gate the design doc §4 promises.
    const sum =
      VALID_FRONTMATTER.covered_count +
      VALID_FRONTMATTER.partial_count +
      VALID_FRONTMATTER.missing_count;
    expect(sum).toBe(VALID_FRONTMATTER.total_tasks);
  });
});

describe('AuditTaskEntrySchema', () => {
  it('accepts a well-formed task entry', () => {
    expect(AuditTaskEntrySchema.safeParse(VALID_TASK_ENTRY).success).toBe(true);
  });

  it('accepts loop_verdict and cost_cap_deferred (without verifier_verdict)', () => {
    // cost_cap_deferred:true means the verifier was never dispatched —
    // verifier_verdict must be absent. loop_verdict (from LOOP-RUN.md) is
    // independent and may still be present.
    const { verifier_verdict: _dropped, ...entryWithoutVerdict } = VALID_TASK_ENTRY;
    const entry = {
      ...entryWithoutVerdict,
      score: 'PARTIAL' as const,
      loop_verdict: 'PASS',
      cost_cap_deferred: true,
    };
    expect(AuditTaskEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('rejects an invalid score value', () => {
    expect(
      AuditTaskEntrySchema.safeParse({
        ...VALID_TASK_ENTRY,
        score: 'PASS', // not one of COVERED / PARTIAL / MISSING
      }).success,
    ).toBe(false);
  });

  it('accepts each of COVERED / PARTIAL / MISSING', () => {
    for (const score of ['COVERED', 'PARTIAL', 'MISSING'] as const) {
      expect(AuditTaskEntrySchema.safeParse({ ...VALID_TASK_ENTRY, score }).success).toBe(true);
    }
  });

  it('accepts the optional no_acceptance_criteria branch', () => {
    expect(
      AuditTaskEntrySchema.safeParse({
        task_id: 999,
        title: 'Legacy task — no AC column, no description bullets',
        score: 'PARTIAL',
        check_count: 0,
        no_acceptance_criteria: true,
      }).success,
    ).toBe(true);
  });

  it('rejects first_failing_evidence longer than 200 chars', () => {
    expect(
      AuditTaskEntrySchema.safeParse({
        ...VALID_TASK_ENTRY,
        first_failing_evidence: 'x'.repeat(201),
      }).success,
    ).toBe(false);
  });

  it('rejects non-positive task_id', () => {
    expect(
      AuditTaskEntrySchema.safeParse({
        ...VALID_TASK_ENTRY,
        task_id: 0,
      }).success,
    ).toBe(false);
  });

  it('exposes COVERED / PARTIAL / MISSING as the AuditScoreSchema enum', () => {
    const values = AuditScoreSchema.options;
    expect(values).toContain('COVERED');
    expect(values).toContain('PARTIAL');
    expect(values).toContain('MISSING');
    expect(values).toHaveLength(3);
  });

  it('shares its enum with IntegrationVerdictSchema (symmetric roll-up)', () => {
    expect(IntegrationVerdictSchema.options).toEqual(AuditScoreSchema.options);
  });

  it('exposes the four verifier-verdict values verbatim from docs/verifier-contract.md', () => {
    const values = VerifierVerdictSchema.options;
    expect(values).toEqual(['PASS', 'FAIL', 'PARTIAL', 'NOT_VERIFIED']);
  });

  // AC1 — derivation drift-guard: VerifierVerdictSchema is derived from
  // VERIFICATION_VERDICTS in src/schemas/task.schema.ts (single source of truth).
  // This test pins the value sets equal so any future divergence fails loudly.
  it('VerifierVerdictSchema values equal VERIFICATION_VERDICTS from task.schema (single source of truth)', () => {
    expect([...VerifierVerdictSchema.options].sort()).toEqual([...VERIFICATION_VERDICTS].sort());
  });

  // AC2 — superRefine exclusion: cost_cap_deferred:true ⇒ verifier_verdict absent
  it('rejects cost_cap_deferred:true when verifier_verdict is present', () => {
    const result = AuditTaskEntrySchema.safeParse({
      ...VALID_TASK_ENTRY,
      cost_cap_deferred: true,
      // verifier_verdict: 'PASS' is inherited from VALID_TASK_ENTRY — contradiction
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('verifier_verdict');
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('cost_cap_deferred'))).toBe(true);
    }
  });

  // AC2 — superRefine exclusion: no_acceptance_criteria:true ⇒ verifier_verdict absent
  it('rejects no_acceptance_criteria:true when verifier_verdict is present', () => {
    const result = AuditTaskEntrySchema.safeParse({
      ...VALID_TASK_ENTRY,
      no_acceptance_criteria: true,
      // verifier_verdict: 'PASS' is inherited from VALID_TASK_ENTRY — contradiction
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('verifier_verdict');
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('no_acceptance_criteria'))).toBe(true);
    }
  });

  // AC2 — backward compat: entries with neither flag still parse (with or without verdict)
  it('accepts entry with neither cost_cap_deferred nor no_acceptance_criteria and a verdict', () => {
    expect(AuditTaskEntrySchema.safeParse(VALID_TASK_ENTRY).success).toBe(true);
  });

  it('accepts entry with cost_cap_deferred:true and NO verifier_verdict', () => {
    const { verifier_verdict: _dropped, ...base } = VALID_TASK_ENTRY;
    expect(
      AuditTaskEntrySchema.safeParse({
        ...base,
        score: 'PARTIAL' as const,
        cost_cap_deferred: true,
      }).success,
    ).toBe(true);
  });

  it('accepts entry with no_acceptance_criteria:true and NO verifier_verdict', () => {
    expect(
      AuditTaskEntrySchema.safeParse({
        task_id: 999,
        title: 'Legacy task — no AC column, no description bullets',
        score: 'PARTIAL',
        check_count: 0,
        no_acceptance_criteria: true,
        // verifier_verdict intentionally absent
      }).success,
    ).toBe(true);
  });
});

describe('AuditRunSchema (envelope)', () => {
  it('accepts a well-formed frontmatter + tasks envelope', () => {
    const envelope: AuditRun = {
      frontmatter: VALID_FRONTMATTER,
      tasks: [VALID_TASK_ENTRY],
    };
    expect(AuditRunSchema.safeParse(envelope).success).toBe(true);
  });

  it('accepts an empty tasks array (cost-cap-hit halt branch)', () => {
    const halted: AuditRun = {
      frontmatter: {
        ...VALID_FRONTMATTER,
        total_tasks: 20,
        covered_count: 0,
        partial_count: 0,
        missing_count: 0,
        integration_verdict: 'PARTIAL',
        total_usd: 0,
        cost_cap_hit: true,
      },
      tasks: [],
    };
    expect(AuditRunSchema.safeParse(halted).success).toBe(true);
  });

  it('rejects a tasks entry that fails the per-task schema', () => {
    const bad = {
      frontmatter: VALID_FRONTMATTER,
      tasks: [{ ...VALID_TASK_ENTRY, score: 'NOPE' }],
    };
    expect(AuditRunSchema.safeParse(bad).success).toBe(false);
  });
});
