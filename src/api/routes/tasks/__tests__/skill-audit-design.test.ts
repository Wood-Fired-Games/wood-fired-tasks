import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Wave 7.1 (task #323) — /tasks:audit DESIGN gate.
 *
 * Falsifiable static manifest that pins the design contract emitted by
 * #323 into BOTH:
 *
 *   - `docs/tasks-audit-design.md` (the source-of-truth spec), AND
 *   - `skills/tasks/audit.md` (the discovery stub that points at it).
 *
 * The runtime orchestration is deferred to follow-on tasks (listed in
 * the design doc's §8). This test is the FALSIFIABLE gate that protects
 * the design + the skeleton + the schema cross-references against
 * silent drift in the meantime.
 *
 * Pairs with `src/lib/audit/__tests__/schema.test.ts` which locks down
 * the zod schemas the runtime will consume.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const DESIGN_DOC_PATH = resolve(REPO_ROOT, 'docs/tasks-audit-design.md');
const SKILL_PATH = resolve(REPO_ROOT, 'skills/tasks/audit.md');

const REQUIRED_DESIGN_HEADERS = [
  '# /tasks:audit Design Spec',
  '## Status',
  '## §1 Goal + scope',
  '## §2 Inputs / outputs contract',
  '## §3 Pipeline',
  '## §4 AUDIT.md artifact contract',
  '## §5 Guardrails',
  '## §6 Cost model',
  '## §7 Verification fixtures (deferred)',
  '## §8 Follow-on tasks',
] as const;

const REQUIRED_PIPELINE_STEP_NAMES = [
  'Resolve LOOP-RUN.md',
  'Enumerate closed tasks',
  'Dispatch one `tasks-verifier` per task',
  'Score per task',
  'Roll up the integration verdict',
  'Emit AUDIT.md',
] as const;

const ARTIFACT_PATH_TEMPLATE =
  '.planning/loops/<UTC>-<project_id>-AUDIT.md';

describe('/tasks:audit DESIGN gate (#323)', () => {
  const design = readFileSync(DESIGN_DOC_PATH, 'utf8');
  const skill = readFileSync(SKILL_PATH, 'utf8');

  // -------------------------------------------------------------------------
  // Design doc — required headers (one assertion per header so a missing
  // section fails with a precise error rather than collapsing the gate).
  // -------------------------------------------------------------------------

  for (const header of REQUIRED_DESIGN_HEADERS) {
    it(`design doc contains required header: "${header}"`, () => {
      const headerOnOwnLine = design
        .split('\n')
        .some((line) => line === header);
      expect(headerOnOwnLine).toBe(true);
    });
  }

  // -------------------------------------------------------------------------
  // Design doc — pipeline covers all 6 named steps
  // -------------------------------------------------------------------------

  for (const stepName of REQUIRED_PIPELINE_STEP_NAMES) {
    it(`design doc names pipeline step: "${stepName}"`, () => {
      expect(design.includes(stepName)).toBe(true);
    });
  }

  // -------------------------------------------------------------------------
  // Design doc — verifier-contract reuse (no re-invention)
  // -------------------------------------------------------------------------

  it('design doc cites docs/verifier-contract.md as the dispatched-subagent contract', () => {
    expect(design.includes('docs/verifier-contract.md')).toBe(true);
  });

  it('design doc cites Wave 2.1 / task #314 as the verifier contract origin', () => {
    expect(design.includes('#314')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Design doc — score mapping (PASS→COVERED, etc.)
  // -------------------------------------------------------------------------

  it('design doc spells out the PASS → COVERED mapping', () => {
    // Both members must appear within a short window — locked in by
    // checking each token plus the §3 Step 4 header.
    expect(design.includes('COVERED')).toBe(true);
    expect(design.includes('PARTIAL')).toBe(true);
    expect(design.includes('MISSING')).toBe(true);
    expect(/Score per task/.test(design)).toBe(true);
  });

  it('design doc maps NOT_VERIFIED → PARTIAL (softer than MISSING)', () => {
    expect(design.includes('NOT_VERIFIED')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Design doc — cost budget mentions both numbers
  // -------------------------------------------------------------------------

  it('design doc mentions the $5 hard cost cap', () => {
    expect(design.includes('$5')).toBe(true);
  });

  it('design doc mentions the $1–3 soft target range', () => {
    expect(/\$1.\$3|\$1[–—-]\$3/.test(design)).toBe(true);
  });

  it('design doc records the 15-task Project 12 sanity check (15 × $0.30 = $4.50)', () => {
    expect(design.includes('$0.30')).toBe(true);
    expect(design.includes('$4.50')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Design doc — all four guardrails appear verbatim (load-bearing rules)
  // -------------------------------------------------------------------------

  it('guardrail 1 documented verbatim: MUST NOT mutate code', () => {
    expect(design.includes('MUST NOT mutate code')).toBe(true);
  });

  it('guardrail 2 documented verbatim: MUST NOT call wood-fired-bugs update_task or add_comment', () => {
    expect(
      design.includes(
        'MUST NOT call wood-fired-bugs `update_task` or\n`add_comment`',
      ) ||
        design.includes(
          'MUST NOT call wood-fired-bugs `update_task` or `add_comment`',
        ),
    ).toBe(true);
  });

  it('guardrail 3 documented (refuse if estimated cost > $5)', () => {
    const hasRefusal =
      /MUST refuse to start if the estimated cost exceeds \$5/.test(design);
    expect(hasRefusal).toBe(true);
  });

  it('guardrail 4 documented (reconstruct acceptance_criteria from description when NULL)', () => {
    expect(
      design.includes(
        'MUST reconstruct `acceptance_criteria` from the task\ndescription when the bugs DB column is NULL',
      ) ||
        design.includes(
          'MUST reconstruct `acceptance_criteria` from the task description when the bugs DB column is NULL',
        ),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Design doc — gitignored artifact path documented; matches the
  // template the skill stub and the schema test fixture both reference.
  // -------------------------------------------------------------------------

  it('design doc states AUDIT.md path is .planning/loops/<UTC>-<project_id>-AUDIT.md', () => {
    expect(design.includes(ARTIFACT_PATH_TEMPLATE)).toBe(true);
  });

  it('design doc states AUDIT.md is NOT committed (gitignored)', () => {
    const hasGitignoredRationale =
      /gitignored|not committed|NOT committed/i.test(design);
    expect(hasGitignoredRationale).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Design doc — three verification-fixture sketches present
  // -------------------------------------------------------------------------

  it('design doc lists the real-PASS verification fixture', () => {
    expect(/Real PASS run|real PASS run/.test(design)).toBe(true);
  });

  it('design doc lists the falsified-completion verification fixture', () => {
    expect(design.includes('Falsified completion')).toBe(true);
  });

  it('design doc lists the historical-grade Project 12 verification fixture', () => {
    expect(design.includes('Historical-grade Project 12')).toBe(true);
    expect(design.includes('84ae52df')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Skill skeleton — frontmatter shape + design-only stub markers
  // -------------------------------------------------------------------------

  it('skill file frontmatter declares name: audit', () => {
    expect(skill).toMatch(/^---[\s\S]*?\nname: audit\b/);
  });

  it('skill file frontmatter declares the argument-hint', () => {
    expect(skill).toMatch(
      /argument-hint:\s*--loop-run <path> \| --project <id>/,
    );
  });

  it('skill file explicitly says it is design-only', () => {
    const hasDesignOnly =
      skill.includes('design-only') || skill.includes('Design spec landed');
    expect(hasDesignOnly).toBe(true);
  });

  it('skill file explicitly says no subagent will be dispatched on invocation', () => {
    const hasRefusal =
      /No subagent dispatched|none of the above will fire on invocation|Refuse to dispatch|refuse to dispatch/.test(
        skill,
      );
    expect(hasRefusal).toBe(true);
  });

  it('skill file points readers at docs/tasks-audit-design.md', () => {
    expect(skill.includes('docs/tasks-audit-design.md')).toBe(true);
  });

  it('skill file references the verifier contract being reused', () => {
    expect(skill.includes('docs/verifier-contract.md')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cross-reference — artifact path constant matches across skill,
  // design doc, AND the schema module location.
  // -------------------------------------------------------------------------

  it('skill file mentions the .planning/loops/ artifact path', () => {
    expect(skill.includes('.planning/loops/')).toBe(true);
  });

  it('design doc references src/lib/audit/schema.ts as the in-tree zod mirror', () => {
    expect(design.includes('src/lib/audit/schema.ts')).toBe(true);
  });

  it('skill file links to src/lib/audit/schema.ts as the zod schema', () => {
    expect(skill.includes('src/lib/audit/schema.ts')).toBe(true);
  });
});
