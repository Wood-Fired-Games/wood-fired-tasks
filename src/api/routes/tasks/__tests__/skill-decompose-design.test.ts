import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Wave 5 (task #320) — /tasks:decompose DESIGN gate.
 *
 * Falsifiable static manifest that pins the design contract emitted by
 * #320 into BOTH:
 *
 *   - `docs/tasks-decompose-design.md` (the source-of-truth spec), AND
 *   - `skills/tasks/decompose.md` (the discovery stub that points at it).
 *
 * The runtime orchestration is deferred to follow-on tasks (listed in
 * the design doc's §11). This test is the FALSIFIABLE gate that protects
 * the design + the skeleton + the schema cross-references against
 * silent drift in the meantime.
 *
 * Pairs with `src/lib/decompose/__tests__/schema.test.ts` which locks
 * down the zod schemas the runtime will consume.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const DESIGN_DOC_PATH = resolve(
  REPO_ROOT,
  'docs/tasks-decompose-design.md',
);
const SKILL_PATH = resolve(REPO_ROOT, 'skills/tasks/decompose.md');

const REQUIRED_DESIGN_HEADERS = [
  '# /tasks:decompose Design Spec',
  '## Status',
  '## Why this exists',
  '## Contract',
  '## Methodology (9 steps)',
  '## Guardrails',
  '## DECOMPOSITION.md artifact schema',
  '## Acceptance criteria for each candidate task',
  '## Topology-driven advisory',
  '## Verification fixtures (deferred)',
  '## Cost budget',
  '## Follow-on tasks',
] as const;

const REQUIRED_STEP_NAMES = [
  'Goal capture',
  'Codebase recon',
  'Candidate task generation',
  'Independence check',
  'Topology decision',
  'Coverage check',
  'Sizing check',
  'Materialize',
  'Emit `DECOMPOSITION.md`',
] as const;

describe('/tasks:decompose DESIGN gate (#320)', () => {
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
  // Design doc — methodology covers all 9 named steps
  // -------------------------------------------------------------------------

  for (const stepName of REQUIRED_STEP_NAMES) {
    it(`design doc names methodology step: "${stepName}"`, () => {
      expect(design.includes(stepName)).toBe(true);
    });
  }

  // -------------------------------------------------------------------------
  // Design doc — Wave 4.1 topology_check reuse (no new MCP tool)
  // -------------------------------------------------------------------------

  it('design doc cites topology_check (Wave 4.1 reuse, no new MCP tool)', () => {
    expect(design.includes('topology_check')).toBe(true);
  });

  it('design doc cites task #318 as the topology_check origin', () => {
    expect(design.includes('#318')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Design doc — cost budget mentions both numbers
  // -------------------------------------------------------------------------

  it('design doc mentions the $5 soft cost target', () => {
    expect(design.includes('$5')).toBe(true);
  });

  it('design doc mentions the $15 hard cost cap', () => {
    expect(design.includes('$15')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Design doc — all four guardrails appear verbatim
  // -------------------------------------------------------------------------

  it('guardrail 1 documented verbatim: MUST NOT execute the decomposed tasks', () => {
    expect(design.includes('MUST NOT execute the decomposed tasks')).toBe(
      true,
    );
  });

  it('guardrail 2 documented verbatim: MUST NOT modify itself', () => {
    expect(design.includes('MUST NOT modify itself')).toBe(true);
  });

  it('guardrail 3 documented (30% interdependence halt)', () => {
    // Accept any of three phrasings so wording polish does not break the
    // gate, but lock in the load-bearing concept (30 percent threshold).
    const hasThreshold = /≥ 30 ?percent|≥ ?30%|30 ?percent|30%/i.test(design);
    expect(hasThreshold).toBe(true);
  });

  it('guardrail 4 documented (blast-radius keywords listed)', () => {
    expect(design.includes('deploy')).toBe(true);
    expect(design.includes('migrate production')).toBe(true);
    expect(design.includes('delete data')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Design doc — gitignored artifact path documented
  // -------------------------------------------------------------------------

  it('design doc states DECOMPOSITION.md path is .planning/decompositions/', () => {
    expect(design.includes('.planning/decompositions/')).toBe(true);
  });

  it('design doc states DECOMPOSITION.md is NOT committed (gitignored)', () => {
    const hasGitignoredRationale = /gitignored|not committed|NOT committed/i.test(
      design,
    );
    expect(hasGitignoredRationale).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Design doc — three of the four verification-fixture sketches present
  // -------------------------------------------------------------------------

  it('design doc lists the Project 12 replay verification fixture', () => {
    expect(design.includes('Project 12 replay')).toBe(true);
  });

  it('design doc lists the OIDC SSO DAG verification fixture', () => {
    expect(design.includes('OIDC SSO DAG')).toBe(true);
  });

  it('design doc lists the cyclic-halt verification fixture', () => {
    expect(/Cyclic halt|cyclic halt/.test(design)).toBe(true);
  });

  it('design doc lists the cost-guardrail verification fixture', () => {
    expect(/Cost guardrail|cost guardrail/.test(design)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Skill skeleton — frontmatter shape + design-only stub markers
  // -------------------------------------------------------------------------

  it('skill file frontmatter declares name: decompose', () => {
    expect(skill).toMatch(/^---[\s\S]*?\nname: decompose\b/);
  });

  it('skill file frontmatter declares the argument-hint', () => {
    expect(skill).toMatch(/argument-hint:\s*--project <id> --goal/);
  });

  it('skill file carries the design-only status caveat', () => {
    const hasCaveat =
      skill.includes('design-only') ||
      skill.includes('DESIGN landed') ||
      skill.includes('Design spec landed');
    expect(hasCaveat).toBe(true);
  });

  it('skill file points readers at docs/tasks-decompose-design.md', () => {
    expect(skill.includes('docs/tasks-decompose-design.md')).toBe(true);
  });

  it('skill file refuses to dispatch subagents while implementation is deferred', () => {
    const hasRefusal =
      /refuse to dispatch|Refuse to dispatch|No subagent dispatched/.test(
        skill,
      );
    expect(hasRefusal).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cross-reference — schema lives where the design says it does
  // -------------------------------------------------------------------------

  it('design doc references src/lib/decompose/schema.ts as the in-tree zod mirror', () => {
    expect(design.includes('src/lib/decompose/schema.ts')).toBe(true);
  });
});
