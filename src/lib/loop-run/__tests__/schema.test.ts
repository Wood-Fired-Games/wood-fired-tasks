import { describe, it, expect } from 'vitest';
import { LoopRunFrontmatterSchema, type LoopRunFrontmatter } from '../schema.js';

/**
 * Wave 3.1 (task #316) — falsifiable tests for the LOOP-RUN.md frontmatter
 * Zod schema. Mirrors the constraints in `docs/loop-run-schema.json` so a
 * future schema drift breaks compilation here AND in the JSON-Schema mirror
 * regression test (`reference-example.test.ts`).
 */

// Values lifted from docs/loop-run-reference-example.md — keep in sync so
// the schema accepts the canonical example.
const VALID: LoopRunFrontmatter = {
  run_id: '4ae2b18c-9c2f-4f7d-9b2c-1d5d8e3a55a0',
  project_id: 12,
  started_at: '2026-05-22T17:50:00Z',
  ended_at: '2026-05-22T22:18:43Z',
  wall_seconds: 16123,
  orchestrator_session_id: '84ae52df-3d10-4a8e-9b88-7c33e4d0a112',
  total_tokens: 4812334,
  total_usd: 7.42,
  subagents_dispatched: 15,
  tasks_attempted: 15,
  tasks_passed: 12,
  tasks_failed: 1,
  tasks_partial: 1,
  tasks_not_verified: 1,
};

const REQUIRED_FIELDS = [
  'run_id',
  'project_id',
  'started_at',
  'ended_at',
  'wall_seconds',
  'orchestrator_session_id',
  'total_tokens',
  'total_usd',
  'subagents_dispatched',
  'tasks_attempted',
  'tasks_passed',
  'tasks_failed',
  'tasks_partial',
  'tasks_not_verified',
] as const;

describe('LoopRunFrontmatterSchema', () => {
  it('accepts the reference-example frontmatter values', () => {
    const result = LoopRunFrontmatterSchema.safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it('exposes all 14 required keys (plus optional Wave 4.2 additions)', () => {
    // Schema-mirror sanity check — the JSON Schema marks all 14 fields
    // required; the Zod shape MUST contain those keys. Optional additions
    // (e.g. Wave 4.2's `gate_decision` from #319) may appear as extra
    // shape keys but MUST NOT appear in REQUIRED_FIELDS.
    const shapeKeys = new Set(Object.keys(LoopRunFrontmatterSchema.shape));
    for (const required of REQUIRED_FIELDS) {
      expect(shapeKeys.has(required)).toBe(true);
    }
    // Every required field must be present in the schema shape.
    expect(shapeKeys.size).toBeGreaterThanOrEqual(REQUIRED_FIELDS.length);
  });

  // Parametrize the "missing each required field" check — 14 generated cases,
  // each independently failing if any field becomes optional in the schema.
  for (const field of REQUIRED_FIELDS) {
    it(`rejects when required field "${field}" is missing`, () => {
      const incomplete: Record<string, unknown> = { ...VALID };
      delete incomplete[field];
      const result = LoopRunFrontmatterSchema.safeParse(incomplete);
      expect(result.success).toBe(false);
    });
  }

  it('rejects an invalid UUID in run_id', () => {
    const bad = { ...VALID, run_id: 'not-a-uuid' };
    expect(LoopRunFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative wall_seconds', () => {
    const bad = { ...VALID, wall_seconds: -1 };
    expect(LoopRunFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects non-integer project_id', () => {
    const bad = { ...VALID, project_id: 1.5 };
    expect(LoopRunFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects project_id of 0 (must be positive)', () => {
    const bad = { ...VALID, project_id: 0 };
    expect(LoopRunFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative total_usd', () => {
    const bad = { ...VALID, total_usd: -0.01 };
    expect(LoopRunFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  // task #759 — total_tokens/total_usd are best-effort and nullable when
  // unmeasured (orchestrator-session cost not captured at emit time). They are
  // `.nullable()` (present-but-may-be-null), NOT `.optional()`: `null` is
  // accepted, but the key must still be present and a string/negative is still
  // rejected.
  it('accepts null total_tokens (unmeasured, best-effort)', () => {
    const ok = { ...VALID, total_tokens: null };
    expect(LoopRunFrontmatterSchema.safeParse(ok).success).toBe(true);
  });

  it('accepts null total_usd (unmeasured, best-effort)', () => {
    const ok = { ...VALID, total_usd: null };
    expect(LoopRunFrontmatterSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects a string total_tokens (nullable does not mean any type)', () => {
    const bad = { ...VALID, total_tokens: '4812334' };
    expect(LoopRunFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative total_tokens', () => {
    const bad = { ...VALID, total_tokens: -1 };
    expect(LoopRunFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty orchestrator_session_id', () => {
    const bad = { ...VALID, orchestrator_session_id: '' };
    expect(LoopRunFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-RFC3339 started_at', () => {
    const bad = { ...VALID, started_at: 'yesterday' };
    expect(LoopRunFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('still parses when task counts do NOT sum to tasks_attempted (schema does not enforce sum invariant)', () => {
    // docs/loop-run-schema.md §3 notes the invariant
    //   tasks_attempted == tasks_passed + tasks_failed + tasks_partial + tasks_not_verified
    // but explicitly delegates enforcement to the replay/validator tooling,
    // not the schema. This test LOCKS IN that behaviour so a well-meaning
    // future edit doesn't quietly add a `.refine()` and break callers that
    // emit partial frontmatter mid-run (kill-safe incremental rewrite — see
    // Step 9 in skills/tasks/loop.md).
    const mismatched = {
      ...VALID,
      tasks_attempted: 15,
      tasks_passed: 0,
      tasks_failed: 0,
      tasks_partial: 0,
      tasks_not_verified: 0,
    };
    expect(LoopRunFrontmatterSchema.safeParse(mismatched).success).toBe(true);
  });

  // Wave 4.2 (task #319) — optional `gate_decision` from the §2f topology
  // pre-flight gate. Must remain optional so pre-#319 LOOP-RUN.md files
  // (which never emitted the field) still parse cleanly.
  describe('gate_decision (#319 topology pre-flight gate)', () => {
    it('accepts gate_decision: "allowed"', () => {
      const result = LoopRunFrontmatterSchema.safeParse({
        ...VALID,
        gate_decision: 'allowed',
      });
      expect(result.success).toBe(true);
    });

    it('accepts gate_decision: "auto_ordered" (Wave 11 DAG auto-resolution)', () => {
      const result = LoopRunFrontmatterSchema.safeParse({
        ...VALID,
        gate_decision: 'auto_ordered',
      });
      expect(result.success).toBe(true);
    });

    it('accepts gate_decision: "overridden"', () => {
      const result = LoopRunFrontmatterSchema.safeParse({
        ...VALID,
        gate_decision: 'overridden',
      });
      expect(result.success).toBe(true);
    });

    it('accepts gate_decision: "blocked"', () => {
      const result = LoopRunFrontmatterSchema.safeParse({
        ...VALID,
        gate_decision: 'blocked',
      });
      expect(result.success).toBe(true);
    });

    it('accepts frontmatter WITHOUT gate_decision (backward compatibility for pre-#319 emissions)', () => {
      // The 14-required-fields baseline (locked by REQUIRED_FIELDS above)
      // is unchanged. gate_decision is purely additive — schema MUST stay
      // permissive for files written before #319 landed.
      const result = LoopRunFrontmatterSchema.safeParse(VALID);
      expect(result.success).toBe(true);
      const parsed = result.success ? result.data : undefined;
      expect(parsed?.gate_decision).toBeUndefined();
    });

    it('rejects unknown gate_decision values', () => {
      const result = LoopRunFrontmatterSchema.safeParse({
        ...VALID,
        gate_decision: 'invalid',
      });
      expect(result.success).toBe(false);
    });
  });

  // Configurable Task Models (task #924) — optional per-role model-override
  // provenance. Each field is omitted-when-unset (`.optional()`, NOT
  // `.nullable()`): a run with no override emits nothing for that key, so
  // pre-#924 LOOP-RUN.md files (which never carried these keys) still parse.
  describe('model overrides (#924 configurable task models)', () => {
    for (const field of ['execution_model', 'validation_model', 'planning_model'] as const) {
      it(`accepts a concrete ${field} ref`, () => {
        const result = LoopRunFrontmatterSchema.safeParse({
          ...VALID,
          [field]: 'claude-opus-4-20250514',
        });
        expect(result.success).toBe(true);
      });

      it(`accepts ${field}: "auto"`, () => {
        const result = LoopRunFrontmatterSchema.safeParse({ ...VALID, [field]: 'auto' });
        expect(result.success).toBe(true);
      });

      it(`rejects an empty ${field} (min length 1)`, () => {
        const result = LoopRunFrontmatterSchema.safeParse({ ...VALID, [field]: '' });
        expect(result.success).toBe(false);
      });

      it(`does not add ${field} to the required-field set (omitted when unset)`, () => {
        // VALID never sets the model fields — it must still parse, and the
        // parsed value must leave the key absent (not coerced to null).
        const result = LoopRunFrontmatterSchema.safeParse(VALID);
        expect(result.success).toBe(true);
        const parsed = result.success ? result.data : undefined;
        expect(parsed?.[field]).toBeUndefined();
      });
    }

    it('accepts all three overrides together', () => {
      const result = LoopRunFrontmatterSchema.safeParse({
        ...VALID,
        execution_model: 'claude-sonnet-4-20250514',
        validation_model: 'auto',
        planning_model: 'claude-opus-4-20250514',
      });
      expect(result.success).toBe(true);
    });
  });
});
