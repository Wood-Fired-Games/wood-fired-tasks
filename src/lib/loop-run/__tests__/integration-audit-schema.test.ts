import { describe, it, expect } from 'vitest';
import {
  IntegrationAuditFrontmatterSchema,
  IntegrationOverlapSchema,
  IntegrationVerdictSchema,
  type IntegrationAuditFrontmatter,
  type IntegrationOverlap,
} from '../integration-audit-schema.js';

/**
 * Wave 3.2 (task #317) — falsifiable tests for the INTEGRATION-AUDIT.md
 * zod schemas. Locks in the load-bearing constraints documented in
 * `skills/tasks/loop.md` Step 10:
 *
 *   - An overlap is only meaningful with ≥ 2 contributing tasks.
 *   - The three-verdict enum is exhaustive (SAFE / RISKY / BROKEN); no
 *     fourth verdict can sneak in.
 *   - INTEGRATION-AUDIT.md is only emitted when overlap_count ≥ 1 (the
 *     empty-overlap suppression rule).
 *   - Evidence must be cited (≥ 1 string); a verdict without cited
 *     evidence is unfalsifiable and rejected.
 */

const SAFE_OVERLAP: IntegrationOverlap = {
  file_path: 'src/foo.ts',
  task_ids: [101, 102],
  verdict: 'SAFE',
  rationale: 'Hunk A and Hunk B touch disjoint functions; no shared symbols.',
  evidence: ['src/foo.ts:42 — function alpha untouched by hunk B'],
};

const RISKY_OVERLAP: IntegrationOverlap = {
  file_path: 'src/bar.ts',
  task_ids: [201, 202],
  verdict: 'RISKY',
  rationale: 'Both edits land in the same function body; combined semantics unclear.',
  evidence: ['diff_a hunk: + return value * 2;', 'diff_b hunk: + return value + offset;'],
};

const BROKEN_OVERLAP: IntegrationOverlap = {
  file_path: 'src/baz.ts',
  task_ids: [301, 302],
  verdict: 'BROKEN',
  rationale: 'Worker A renamed `compute` to `calculate`; worker B still calls `compute(x)`.',
  evidence: [
    'src/baz.ts:88 — compute(x) — but compute no longer exists',
    'diff_a hunk: -export function compute\n+export function calculate',
  ],
};

const VALID_FRONTMATTER: IntegrationAuditFrontmatter = {
  run_id: '4ae2b18c-9c2f-4f7d-9b2c-1d5d8e3a55a0',
  project_id: 15,
  generated_at: '2026-05-23T22:18:43Z',
  overlap_count: 3,
  broken_count: 1,
  risky_count: 1,
  safe_count: 1,
};

describe('IntegrationVerdictSchema', () => {
  it('accepts SAFE, RISKY, and BROKEN', () => {
    expect(IntegrationVerdictSchema.safeParse('SAFE').success).toBe(true);
    expect(IntegrationVerdictSchema.safeParse('RISKY').success).toBe(true);
    expect(IntegrationVerdictSchema.safeParse('BROKEN').success).toBe(true);
  });

  it('rejects an unknown verdict like "MAYBE"', () => {
    expect(IntegrationVerdictSchema.safeParse('MAYBE').success).toBe(false);
  });

  it('rejects lowercase variants (enum is case-sensitive)', () => {
    expect(IntegrationVerdictSchema.safeParse('safe').success).toBe(false);
    expect(IntegrationVerdictSchema.safeParse('broken').success).toBe(false);
  });
});

describe('IntegrationOverlapSchema', () => {
  it('accepts a SAFE overlap fixture', () => {
    expect(IntegrationOverlapSchema.safeParse(SAFE_OVERLAP).success).toBe(true);
  });

  it('accepts a RISKY overlap fixture', () => {
    expect(IntegrationOverlapSchema.safeParse(RISKY_OVERLAP).success).toBe(true);
  });

  it('accepts a BROKEN overlap fixture', () => {
    expect(IntegrationOverlapSchema.safeParse(BROKEN_OVERLAP).success).toBe(true);
  });

  it('rejects task_ids with only one entry (overlap requires ≥ 2 tasks)', () => {
    const bad = { ...SAFE_OVERLAP, task_ids: [101] };
    expect(IntegrationOverlapSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty task_ids array', () => {
    const bad = { ...SAFE_OVERLAP, task_ids: [] };
    expect(IntegrationOverlapSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a zero or negative task_id (must be positive int)', () => {
    expect(
      IntegrationOverlapSchema.safeParse({ ...SAFE_OVERLAP, task_ids: [0, 101] }).success,
    ).toBe(false);
    expect(
      IntegrationOverlapSchema.safeParse({ ...SAFE_OVERLAP, task_ids: [-1, 101] }).success,
    ).toBe(false);
  });

  it('rejects an unknown verdict in the overlap object', () => {
    const bad = { ...SAFE_OVERLAP, verdict: 'MAYBE' as unknown as 'SAFE' };
    expect(IntegrationOverlapSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a rationale longer than 500 characters', () => {
    const bad = { ...SAFE_OVERLAP, rationale: 'x'.repeat(501) };
    expect(IntegrationOverlapSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a rationale exactly 500 characters long (inclusive bound)', () => {
    const ok = { ...SAFE_OVERLAP, rationale: 'x'.repeat(500) };
    expect(IntegrationOverlapSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects empty evidence array (every verdict must cite something)', () => {
    const bad = { ...SAFE_OVERLAP, evidence: [] };
    expect(IntegrationOverlapSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty file_path', () => {
    const bad = { ...SAFE_OVERLAP, file_path: '' };
    expect(IntegrationOverlapSchema.safeParse(bad).success).toBe(false);
  });
});

describe('IntegrationAuditFrontmatterSchema', () => {
  it('accepts the reference frontmatter values', () => {
    expect(IntegrationAuditFrontmatterSchema.safeParse(VALID_FRONTMATTER).success).toBe(true);
  });

  it('rejects overlap_count of 0 (file only emitted when ≥ 1 overlap exists)', () => {
    const bad = { ...VALID_FRONTMATTER, overlap_count: 0 };
    expect(IntegrationAuditFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative overlap_count', () => {
    const bad = { ...VALID_FRONTMATTER, overlap_count: -1 };
    expect(IntegrationAuditFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-UUID run_id', () => {
    const bad = { ...VALID_FRONTMATTER, run_id: 'not-a-uuid' };
    expect(IntegrationAuditFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative broken_count', () => {
    const bad = { ...VALID_FRONTMATTER, broken_count: -1 };
    expect(IntegrationAuditFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative risky_count', () => {
    const bad = { ...VALID_FRONTMATTER, risky_count: -1 };
    expect(IntegrationAuditFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative safe_count', () => {
    const bad = { ...VALID_FRONTMATTER, safe_count: -1 };
    expect(IntegrationAuditFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects non-integer counts (e.g. fractional broken_count)', () => {
    const bad = { ...VALID_FRONTMATTER, broken_count: 1.5 };
    expect(IntegrationAuditFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-RFC3339 generated_at', () => {
    const bad = { ...VALID_FRONTMATTER, generated_at: 'yesterday' };
    expect(IntegrationAuditFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects project_id of 0', () => {
    const bad = { ...VALID_FRONTMATTER, project_id: 0 };
    expect(IntegrationAuditFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('still parses when counts do NOT sum to overlap_count (schema does not enforce sum invariant)', () => {
    // Mirrors the LoopRunFrontmatterSchema convention: sum-invariant checks
    // are the replay tooling's responsibility, not the schema's. A future
    // edit that adds a `.refine()` to enforce summation would break partial
    // mid-run frontmatter and should be caught by this regression.
    const mismatched = {
      ...VALID_FRONTMATTER,
      overlap_count: 5,
      broken_count: 0,
      risky_count: 0,
      safe_count: 0,
    };
    expect(IntegrationAuditFrontmatterSchema.safeParse(mismatched).success).toBe(true);
  });
});
