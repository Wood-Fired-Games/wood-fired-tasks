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

  it('exposes all 14 required keys', () => {
    // Schema-mirror sanity check — the JSON Schema marks all 14 fields
    // required; the Zod shape MUST have the same keys.
    const shapeKeys = Object.keys(LoopRunFrontmatterSchema.shape).sort();
    expect(shapeKeys).toEqual([...REQUIRED_FIELDS].sort());
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
});
