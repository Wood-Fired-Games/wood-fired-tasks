import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Wave 8 (task #321) — /tasks:decompose OPERATIONAL gate.
 *
 * The runtime landed: `skills/tasks/decompose.md` is no longer a
 * design-only stub, it is the executable 9-step pipeline. This test is
 * the FALSIFIABLE gate that pins the OPERATIONAL contract into BOTH:
 *
 *   - `docs/tasks-decompose-design.md` (the source-of-truth spec, LOCKED), AND
 *   - `skills/tasks/decompose.md` (the operational skill that implements it).
 *
 * Mirrors `skill-audit-design.test.ts` (which flipped /tasks:audit from
 * stub→runtime in #323). The assertions below verify the REAL design
 * contract — each cites a specific behavior or phrase the design §3/§5/§6
 * mandates, NOT arbitrary text that would trivially pass. The design-doc
 * half of the gate is unchanged (the doc is LOCKED); the skill half now
 * asserts operational behavior, not the old "refuses to dispatch" stub.
 *
 * Pairs with:
 *   - `src/lib/decompose/__tests__/schema.test.ts` — zod schemas the
 *     runtime consumes.
 *   - `skill-decompose-fixtures.test.ts` — the four §9 behavioral fixtures.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const DESIGN_DOC_PATH = resolve(REPO_ROOT, 'docs/tasks-decompose-design.md');
const SKILL_PATH = resolve(REPO_ROOT, 'skills/tasks/decompose.md');
const PLAN_TEMPLATE_PATH = resolve(REPO_ROOT, 'docs/superpowers/PLAN-TEMPLATE.md');
const PARITY_RETRO_FILENAME = '2026-06-01-wsjf-remote-parity-planning-gap.md';

/**
 * The 8 canonical deployment surfaces every decompose plan must check
 * (retro §Prevent P1). Used by the surface-coverage-matrix assertions
 * below. Each name must appear in the design doc + plan template, so
 * deleting any surface from those docs fails the gate.
 */
const EIGHT_SURFACES = [
  'stdio MCP',
  'remote MCP',
  'REST',
  'CLI',
  'skills',
  'client-package mirror',
  'docs/tool-count',
  'migration/backfill',
] as const;

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
      const headerOnOwnLine = design.split('\n').some((line) => line === header);
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
    expect(design.includes('MUST NOT execute the decomposed tasks')).toBe(true);
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
    const hasGitignoredRationale = /gitignored|not committed|NOT committed/i.test(design);
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
  // Skill — frontmatter shape (still-valid assertions, kept)
  // -------------------------------------------------------------------------

  it('skill file frontmatter declares name: decompose', () => {
    expect(skill).toMatch(/^---[\s\S]*?\nname: decompose\b/);
  });

  it('skill file frontmatter declares the argument-hint (incl. --dry-run)', () => {
    expect(skill).toMatch(/argument-hint:\s*--project <id> --goal/);
    // The operational skill supports --dry-run (design §2 Contract).
    expect(/argument-hint:[^\n]*--dry-run/.test(skill)).toBe(true);
  });

  it('skill file points readers at docs/tasks-decompose-design.md', () => {
    expect(skill.includes('docs/tasks-decompose-design.md')).toBe(true);
  });

  it('design doc references src/lib/decompose/schema.ts as the in-tree zod mirror', () => {
    expect(design.includes('src/lib/decompose/schema.ts')).toBe(true);
  });

  it('skill file links to src/lib/decompose/schema.ts as the zod schema', () => {
    expect(skill.includes('src/lib/decompose/schema.ts')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Skill is now OPERATIONAL (the #320 stub → #321 runtime flip).
  // Mirrors skill-audit-design.test.ts "skill file is now operational".
  // -------------------------------------------------------------------------

  it('skill file is now operational (NOT gated, NOT a design-only stub)', () => {
    // The flag MUST be present (separate e2e gate) but set to false.
    expect(/disable-model-invocation:\s*false/.test(skill)).toBe(true);
    expect(skill.includes('disable-model-invocation: true')).toBe(false);
    // The old stub's "design-only" / "implementation deferred" framing and
    // its "No subagent dispatched. No tasks materialized. No artifacts
    // written." sign-off must be gone — those are the markers that the
    // skill refused to run.
    expect(skill.includes('DESIGN-ONLY STUB')).toBe(false);
    expect(skill.includes('design-only as of #320')).toBe(false);
    expect(
      /No subagent dispatched\. No tasks materialized\. No artifacts written\./.test(skill),
    ).toBe(false);
  });

  it('skill file encodes all 9 operational pipeline step sections', () => {
    // Each step appears as an executable "## Step N — <name>" heading
    // (operational form), not a one-liner glance list.
    const requiredStepHeadings = [
      /## Step 1 — Goal capture/,
      /## Step 2 — Codebase recon/,
      /## Step 3 — Candidate task generation/,
      /## Step 4 — Independence check/,
      /## Step 5 — Topology decision/,
      /## Step 6 — Coverage check/,
      /## Step 7 — Sizing check/,
      /## Step 8 — Materialize/,
      /## Step 9 — Emit `DECOMPOSITION\.md`/,
    ];
    for (const re of requiredStepHeadings) {
      expect(re.test(skill)).toBe(true);
    }
  });

  it('skill file uses the correct mcp__wood-fired-tasks__ namespace in Preflight', () => {
    expect(
      skill.includes('mcp__wood-fired-tasks__create_task') &&
        skill.includes('mcp__wood-fired-tasks__add_dependency') &&
        skill.includes('mcp__wood-fired-tasks__topology_check'),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Operational behaviors — each ties to a SPECIFIC design mandate so the
  // gate is not circular (it would fail if the skill dropped the behavior).
  // -------------------------------------------------------------------------

  it('Step 2 dispatches exactly ONE Explore agent, bounded ≤50 calls / ≤8 min (design §3 Step 2)', () => {
    // Explore subagent_type + the documented bounds must both appear.
    expect(/subagent_type: ?"Explore"/.test(skill)).toBe(true);
    expect(/≤ ?50 tool calls/.test(skill)).toBe(true);
    expect(/≤ ?8 min/.test(skill)).toBe(true);
  });

  it('Step 3 dispatches a planner via general-purpose with INLINE instructions, 8–25 drafts (design §3 Step 3)', () => {
    // The design mandates an out-of-the-box dispatch: general-purpose +
    // embedded planner brief, producing 8–25 CandidateTaskSchema drafts.
    expect(skill.includes('general-purpose')).toBe(true);
    expect(skill.includes('CandidateTaskSchema')).toBe(true);
    expect(/8.{0,3}25/.test(skill)).toBe(true);
    // < 8 ⇒ single-task ask; > 25 ⇒ split ask (both branches present).
    expect(/< ?8/.test(skill) && /single task/.test(skill)).toBe(true);
    expect(/> ?25/.test(skill) && /split/.test(skill)).toBe(true);
  });

  it('Step 4 critic returns INDEPENDENT|ORDERED|MUTUALLY_EXCLUSIVE verdicts (design §3 Step 4)', () => {
    expect(skill.includes('INDEPENDENT')).toBe(true);
    expect(skill.includes('ORDERED')).toBe(true);
    expect(skill.includes('MUTUALLY_EXCLUSIVE')).toBe(true);
  });

  it('Step 5 calls topology_check WITH a fallback path when the tool is absent (mirror loop-dag)', () => {
    expect(skill.includes('topology_check')).toBe(true);
    // The fallback (local FLAT/DAG/DAG_CYCLIC classification) MUST be
    // documented — topology_check is conditionally registered.
    expect(/fallback/i.test(skill)).toBe(true);
    expect(skill.includes('FLAT')).toBe(true);
    expect(skill.includes('DAG_CYCLIC')).toBe(true);
  });

  it('Step 5 maps FLAT→/tasks:loop and DAG→/tasks:loop-dag with 1–4 wave grouping (design §8)', () => {
    expect(skill.includes('/tasks:loop')).toBe(true);
    expect(skill.includes('/tasks:loop-dag')).toBe(true);
    expect(/1.{0,3}4 waves/.test(skill)).toBe(true);
  });

  it('Step 6 coverage critic returns COMPLETE|GAPS|DUPLICATES, bounded ≤2 re-runs (design §3 Step 6)', () => {
    expect(skill.includes('COMPLETE')).toBe(true);
    expect(skill.includes('GAPS')).toBe(true);
    expect(skill.includes('DUPLICATES')).toBe(true);
    expect(/at most 2|≤ ?2 .*re-run|2 Step.4 re-run/i.test(skill)).toBe(true);
  });

  it('Step 7 enforces the ≤90-minute sizing cap and splits oversize candidates (design §3 Step 7)', () => {
    expect(/≤ ?90/.test(skill)).toBe(true);
    expect(/split/i.test(skill)).toBe(true);
  });

  it('Step 8 materializes via create_task + add_dependency, idempotent on decomposition_id, SKIPPED on --dry-run', () => {
    expect(skill.includes('create_task')).toBe(true);
    expect(skill.includes('add_dependency')).toBe(true);
    expect(/idempoten/i.test(skill)).toBe(true);
    expect(skill.includes('decomposition_id')).toBe(true);
    expect(/dry-run/.test(skill) && /[Ss]kip/.test(skill)).toBe(true);
  });

  it('Step 9 emits the .planning/decompositions/<UTC>-<project_id>.md artifact (gitignored)', () => {
    expect(skill.includes('.planning/decompositions/')).toBe(true);
    expect(/<UTC[^>]*>-<project_id>\.md/.test(skill)).toBe(true);
    expect(/gitignored/i.test(skill)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Guardrails — all four present as LIVE runtime rules (not stub prose).
  // -------------------------------------------------------------------------

  it('Guardrail 1 (plan/execute separation): skill NEVER calls claim_task or status transitions', () => {
    expect(skill.includes('MUST NOT execute the decomposed tasks')).toBe(true);
    expect(skill.includes('claim_task')).toBe(true);
    // claim_task / update_task must be named in the FORBIDDEN set.
    expect(/NOT permitted|NOT call|does NOT call|never calls/i.test(skill)).toBe(true);
  });

  it('Guardrail 2 (no self-rewrite): refuses Edit/Write against decompose.md / design doc / src/lib/decompose', () => {
    expect(skill.includes('MUST NOT modify itself')).toBe(true);
    expect(skill.includes('skills/tasks/decompose.md')).toBe(true);
    expect(skill.includes('docs/tasks-decompose-design.md')).toBe(true);
    expect(skill.includes('src/lib/decompose/')).toBe(true);
  });

  it('Guardrail 3 (≥30% interdependence halt) is a live rule with the high_interdependence abort reason', () => {
    const hasThreshold = /≥ ?30%|30 ?percent|0\.30/.test(skill);
    expect(hasThreshold).toBe(true);
    expect(skill.includes('high_interdependence')).toBe(true);
    expect(/halt/i.test(skill)).toBe(true);
  });

  it('Guardrail 4 (blast-radius refusal) lists all three keywords and fires BEFORE dispatch', () => {
    expect(skill.includes('deploy')).toBe(true);
    expect(skill.includes('migrate production')).toBe(true);
    expect(skill.includes('delete data')).toBe(true);
    // whole-word case-insensitive regex documented + must precede dispatch.
    expect(skill.includes('\\b(deploy|migrate production|delete data)\\b')).toBe(true);
    expect(/before any subagent dispatch|BEFORE any.*dispatch/i.test(skill)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cost cap — $5 checkpoint (run continues) + $15 hard halt (cost_cap_hit).
  // -------------------------------------------------------------------------

  it('skill encodes the 5 USD soft checkpoint (run continues) and the 15 USD hard cap halt', () => {
    // The skill body must NOT carry a literal `$5`/`$15`: those are captured
    // by argument substitution at skill-load time (`$5` → 5th positional arg)
    // and render corrupted. The cost figures are written as USD instead.
    expect(skill.includes('$5')).toBe(false);
    expect(skill.includes('$15')).toBe(false);
    expect(/5 ?USD/.test(skill)).toBe(true);
    expect(/15 ?USD/.test(skill)).toBe(true);
    expect(skill.includes('cost_cap_hit')).toBe(true);
    // 5 USD = checkpoint/continue; 15 USD = halt. Both semantics present.
    expect(/checkpoint/i.test(skill)).toBe(true);
    expect(/HALT|halt/.test(skill)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Surface-coverage matrix + invariant-rider step (task #649 — the
  // PREVENT-class fix for the WSJF remote-MCP-parity planning gap).
  //
  // These assertions are SUBSTANTIVE: deleting any of the 8 surface names,
  // the invariant-rider section, the stdio→remote-parity mapping, or the
  // retro citation makes the relevant test go RED. They are NOT vacuous.
  // -------------------------------------------------------------------------

  const planTemplate = readFileSync(PLAN_TEMPLATE_PATH, 'utf8');

  it('design doc documents the surface-coverage matrix with all 8 surfaces', () => {
    expect(design.includes('## Surface-coverage matrix')).toBe(true);
    for (const surface of EIGHT_SURFACES) {
      expect(design.includes(surface)).toBe(true);
    }
    // The "every non-N/A cell yields a task" rule must be stated.
    expect(/every non-N\/A cell yields a\s+task/i.test(design)).toBe(true);
  });

  it('design doc documents the invariant-rider step (Step 8c) and the stdio→remote-parity mapping', () => {
    expect(/invariant.rider/i.test(design)).toBe(true);
    expect(design.includes('Step 8c')).toBe(true);
    // The load-bearing mapping: a stdio MCP tool auto-emits a remote-MCP
    // parity task. Assert the real tokens (remote + parity + register-tools).
    expect(design.includes('remote')).toBe(true);
    expect(/parity/i.test(design)).toBe(true);
    expect(design.includes('src/mcp/remote/register-tools.ts')).toBe(true);
  });

  it('design doc cites the WSJF remote-parity retro as the motivating example', () => {
    expect(design.includes(PARITY_RETRO_FILENAME)).toBe(true);
    expect(design.includes('wsjf_ranking')).toBe(true);
    expect(design.includes('wsjf_health')).toBe(true);
  });

  it('plan template exists and contains the Surface-coverage matrix section with all 8 surfaces', () => {
    expect(planTemplate.includes('## Surface-coverage matrix')).toBe(true);
    for (const surface of EIGHT_SURFACES) {
      expect(planTemplate.includes(surface)).toBe(true);
    }
    // Every non-N/A cell must map to a task — the load-bearing rule.
    expect(/every non-N\/A cell MUST map to a task/i.test(planTemplate)).toBe(true);
  });

  it('plan template points at the decompose invariant-rider and the retro', () => {
    expect(/invariant.rider/i.test(planTemplate)).toBe(true);
    expect(planTemplate.includes(PARITY_RETRO_FILENAME)).toBe(true);
  });

  it('decompose skill encodes the invariant-rider materialize substep (Step 8c) naming the stdio→remote-parity mapping', () => {
    expect(skill.includes('Step 8c')).toBe(true);
    expect(/invariant.rider/i.test(skill)).toBe(true);
    // Names the load-bearing mapping and the parity test rider.
    expect(skill.includes('remote-MCP-parity')).toBe(true);
    expect(/parity/i.test(skill)).toBe(true);
    expect(skill.includes('src/mcp/remote/register-tools.ts')).toBe(true);
    // Lists all 8 surfaces so dropping one fails the gate.
    for (const surface of EIGHT_SURFACES) {
      expect(skill.includes(surface)).toBe(true);
    }
    // Cites the motivating retro.
    expect(skill.includes(PARITY_RETRO_FILENAME)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Terminal spec-coverage audit phase (task #818 — generalizes the Step 8c
  // CODEBASE-surface rider into a SPEC-grounded coverage check that runs after
  // Step 8 materialize and before the Step 9 emit, when --spec is supplied).
  //
  // These assertions are SUBSTANTIVE: dropping the audit phase, the --spec
  // flag, the auto-emit branch, the drift-flag branch, or the Guardrail-2
  // carve-out makes the matching test go RED. They are NOT vacuous.
  // -------------------------------------------------------------------------

  describe('Step 8d — terminal spec-coverage audit (#818)', () => {
    it('skill documents a TERMINAL spec-coverage audit phase gated on --spec, after Step 8 and before Step 9', () => {
      expect(skill.includes('Step 8d')).toBe(true);
      expect(/spec-coverage audit/i.test(skill)).toBe(true);
      expect(/terminal/i.test(skill)).toBe(true);
      // It is gated on the new --spec input.
      expect(skill.includes('--spec')).toBe(true);
      // Ordering: explicitly runs before the Step 9 DECOMPOSITION.md emit.
      expect(/BEFORE the Step 9|before the Step 9/.test(skill)).toBe(true);
    });

    it('skill argument-hint advertises the optional --spec <path> flag', () => {
      expect(/argument-hint:[^\n]*--spec <path>/.test(skill)).toBe(true);
    });

    it('skill bounds/skips Step 8d when no spec is supplied (no-op, recorded)', () => {
      expect(skill.includes('skipped (no --spec)')).toBe(true);
      // The spec is never a generation input — only the terminal cross-check.
      expect(/never (read by|seeds)|not a breakdown source|post-hoc/i.test(skill)).toBe(true);
    });

    it('skill cross-references the spec components + acceptance-criteria + file references', () => {
      expect(/components/i.test(skill)).toBe(true);
      expect(skill.includes('acceptance criteria')).toBe(true);
      expect(/file reference/i.test(skill)).toBe(true);
    });

    it('skill AUTO-EMITS coverage tasks for uncovered spec items, edged to the trigger and marked (rider)', () => {
      expect(/auto-emit coverage task/i.test(skill)).toBe(true);
      expect(/uncovered spec item/i.test(skill)).toBe(true);
      expect(skill.includes('edged to the trigger')).toBe(true);
      expect(skill.includes('(rider)')).toBe(true);
      // Reuses the Step 8b create_task / add_dependency materialize path.
      expect(skill.includes('create_task') && skill.includes('add_dependency')).toBe(true);
    });

    it('skill FLAGS factual drift (wrong file ref) for correction without silently rewriting', () => {
      expect(/factual drift/i.test(skill)).toBe(true);
      expect(skill.includes('DRIFT(')).toBe(true);
      // The named motivating examples (project 29 v2.0, buildRemoteMcpEntry).
      expect(skill.includes('buildRemoteMcpEntry')).toBe(true);
      expect(skill.includes('project 29')).toBe(true);
    });

    it('Step 8d honors Guardrail 2 — never edits decompose’s own files', () => {
      // The audit MUST NOT edit the three protected paths, even when the spec
      // references them.
      expect(skill.includes('Guardrail 2')).toBe(true);
      expect(skill.includes('skills/tasks/decompose.md')).toBe(true);
      expect(skill.includes('docs/tasks-decompose-design.md')).toBe(true);
      expect(skill.includes('src/lib/decompose/')).toBe(true);
      expect(/out-of-scope \(Guardrail 2\)/.test(skill)).toBe(true);
    });

    it('skill records the audit verdict in DECOMPOSITION.md (body §8 Spec-Coverage Audit)', () => {
      expect(skill.includes('## Spec-Coverage Audit')).toBe(true);
      expect(/audit verdict/i.test(skill)).toBe(true);
    });

    it('design doc documents Step 8d as a numbered step with rationale (source of truth)', () => {
      expect(design.includes('Step 8d')).toBe(true);
      expect(/spec-coverage audit/i.test(design)).toBe(true);
      // Rationale: generalizes the 8c CODEBASE-surface rider into a spec check.
      expect(/spec-grounded/i.test(design)).toBe(true);
      // Motivating example + drift example are cited in the design.
      expect(design.includes('project 29') || design.includes('29 v2.0')).toBe(true);
      expect(design.includes('buildRemoteMcpEntry')).toBe(true);
    });

    it('design doc records the §8 Spec-Coverage Audit artifact body section', () => {
      expect(design.includes('## Spec-Coverage Audit')).toBe(true);
    });

    it('design doc keeps Step 8d Guardrail-2 safe (never edits decompose’s own files)', () => {
      // The design must state the audit is creation-only / read-only and the
      // protected paths stay protected.
      expect(design.includes('Step 8d') && design.includes('Guardrail 2')).toBe(true);
      expect(design.includes('src/lib/decompose/')).toBe(true);
    });
  });
});
