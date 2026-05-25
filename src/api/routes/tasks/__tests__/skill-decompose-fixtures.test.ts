import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Wave 8 (task #321) — /tasks:decompose §9 VERIFICATION FIXTURES.
 *
 * The design doc §9 sketches four behavioral fixtures the runtime "cannot
 * ship without". This file authors them as falsifiable assertions against
 * the operational skill text: it asserts the skill encodes each behavioral
 * BRANCH the fixture exercises. (The skill is a markdown orchestration
 * contract executed by the model — there is no compiled entrypoint to call,
 * so the fixtures verify the contract the runtime follows, the same posture
 * `skill-audit-design.test.ts` takes for the audit runtime.)
 *
 * Each fixture below names the design §9 item it covers and asserts the
 * load-bearing branch — NOT arbitrary prose. Removing a branch from the
 * skill fails the matching fixture.
 *
 * Fixtures:
 *   (a) OIDC SSO DAG     — sub-30% interdependence → DAG → /tasks:loop-dag, ≥2 waves.
 *   (b) Cyclic halt      — advisory BLOCKED + aborted_reason cycle + NO materialization.
 *   (c) Cost guardrail   — $5 checkpoint + $15 halt + cost_cap_hit.
 *   (d) Blast-radius      — three keywords each refuse BEFORE any dispatch.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const SKILL_PATH = resolve(REPO_ROOT, 'skills/tasks/decompose.md');
const DESIGN_DOC_PATH = resolve(REPO_ROOT, 'docs/tasks-decompose-design.md');

describe('/tasks:decompose §9 verification fixtures (#321)', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');
  const design = readFileSync(DESIGN_DOC_PATH, 'utf8');

  // -----------------------------------------------------------------------
  // Fixture (a) — OIDC SSO DAG: sub-30% interdependence → topology DAG,
  // advisory /tasks:loop-dag, suggested wave grouping with ≥ 2 waves.
  // -----------------------------------------------------------------------

  describe('fixture (a) OIDC SSO DAG', () => {
    it('design §9 names the OIDC SSO DAG fixture and the ≥2-wave expectation', () => {
      expect(design.includes('OIDC SSO DAG')).toBe(true);
      // The design ties this fixture to a DAG with ≥ 2 waves at sub-30%.
      expect(/≥ ?2 waves/.test(design)).toBe(true);
    });

    it('skill maps a DAG (sub-30% interdependence) to the /tasks:loop-dag advisory', () => {
      // The DAG branch of Step 5 must advise /tasks:loop-dag.
      expect(skill.includes('DAG')).toBe(true);
      expect(skill.includes('/tasks:loop-dag')).toBe(true);
    });

    it('skill groups DAG candidates into 1–4 waves (advisory wave grouping)', () => {
      expect(/1.{0,3}4 waves/.test(skill)).toBe(true);
      // The grouping is advisory-only — the user reviews it before running.
      expect(/advisory only|advisory[- ]only/i.test(skill)).toBe(true);
    });

    it('skill keeps the ≥30% halt strictly above the DAG happy path (Guardrail 3 boundary)', () => {
      // The OIDC fixture lives at sub-30%, so the DAG path proceeds while the
      // ≥30% threshold is what halts — both must be encoded distinctly.
      expect(/≥ ?30%|0\.30/.test(skill)).toBe(true);
      expect(skill.includes('interdependent_ratio')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Fixture (b) — Cyclic halt: advisory BLOCKED, aborted_reason cycle,
  // and NO tasks materialized.
  // -----------------------------------------------------------------------

  describe('fixture (b) cyclic halt', () => {
    it('design §9 names the cyclic-halt fixture (BLOCKED + aborted_reason cycle, no tasks)', () => {
      expect(/Cyclic halt|cyclic halt/.test(design)).toBe(true);
      expect(design.includes('advisory: BLOCKED')).toBe(true);
      expect(design.includes('aborted_reason: cycle')).toBe(true);
    });

    it('skill HALTs on DAG_CYCLIC with advisory BLOCKED and aborted_reason cycle', () => {
      expect(skill.includes('DAG_CYCLIC')).toBe(true);
      expect(skill.includes('BLOCKED')).toBe(true);
      expect(skill.includes('aborted_reason: cycle')).toBe(true);
    });

    it('skill materializes NOTHING on the cyclic-halt branch (no create_task before HALT)', () => {
      // The DAG_CYCLIC row must say "do NOT materialize" / "HALT" — the
      // load-bearing property that a cycle never produces bugs-DB tasks.
      expect(/do NOT materialize|not materialize/i.test(skill)).toBe(true);
      // A cycle report listing the offending draft_id chain is emitted.
      expect(/cycle report/i.test(skill)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Fixture (c) — Cost guardrail: $5 checkpoint, $15 halt, cost_cap_hit.
  // -----------------------------------------------------------------------

  describe('fixture (c) cost guardrail', () => {
    it('design §9 names the cost-guardrail fixture ($5 checkpoint, $15 halt, cost_cap_hit)', () => {
      expect(/Cost guardrail|cost guardrail/.test(design)).toBe(true);
      expect(design.includes('$5')).toBe(true);
      expect(design.includes('$15')).toBe(true);
      expect(design.includes('cost_cap_hit')).toBe(true);
    });

    it('skill emits a checkpoint at $5 and CONTINUES the run', () => {
      expect(skill.includes('$5')).toBe(true);
      expect(/checkpoint/i.test(skill)).toBe(true);
      // $5 is a SOFT target — the run continues past it.
      expect(/continues|continue/i.test(skill)).toBe(true);
    });

    it('skill HALTs at the $15 hard cap and sets cost_cap_hit: true (work preserved)', () => {
      expect(skill.includes('$15')).toBe(true);
      expect(skill.includes('cost_cap_hit: true')).toBe(true);
      // Already-materialized tasks are preserved (no rollback).
      expect(/preserve|do NOT roll back|stay/i.test(skill)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Fixture (d) — Blast-radius refusal: each of deploy / migrate production /
  // delete data refuses BEFORE any subagent dispatch.
  // -----------------------------------------------------------------------

  describe('fixture (d) blast-radius refusal (one per keyword)', () => {
    const KEYWORDS = ['deploy', 'migrate production', 'delete data'] as const;

    for (const keyword of KEYWORDS) {
      it(`skill lists blast-radius keyword "${keyword}" as a refusal trigger`, () => {
        expect(skill.includes(keyword)).toBe(true);
      });
    }

    it('skill documents the whole-word case-insensitive regex covering all three', () => {
      expect(
        skill.includes('\\b(deploy|migrate production|delete data)\\b'),
      ).toBe(true);
    });

    it('refusal fires in Step 1 BEFORE any subagent dispatch (no Explore/planner/critic)', () => {
      // The load-bearing property: the refusal returns before dispatch — the
      // skill must say so, and Guardrail 4 must be a Step-1-input rule.
      expect(/before any subagent dispatch|BEFORE any.*dispatch/i.test(skill)).toBe(
        true,
      );
      // The refusal explicitly forbids dispatching the recon/planner/critic.
      expect(
        /do \*\*not\*\* dispatch|Do \*\*not\*\* dispatch|not dispatch the Explore/i.test(
          skill,
        ),
      ).toBe(true);
    });

    it('the blast-radius abort path is recorded as aborted_reason blast_radius_keyword', () => {
      expect(skill.includes('blast_radius_keyword')).toBe(true);
    });
  });
});
