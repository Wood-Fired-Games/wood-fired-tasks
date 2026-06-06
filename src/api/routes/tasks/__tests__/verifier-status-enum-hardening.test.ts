import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Hardening gate (post-Wave-2 session findings, 2026-05-23).
 *
 * The tasks-verifier subagent emitted `checks[i].status: "PARTIAL"` twice in
 * one session — that's invalid (the per-check enum is PASS|FAIL|SKIP only;
 * PARTIAL is reserved for the top-level `verdict`). This file pins the
 * remediation across all four affected surfaces so a future edit cannot
 * silently undo the fix:
 *
 *   1. skills/agents/tasks-verifier.md — ⚠ callout + wrong/right example.
 *   2. docs/verifier-contract.md       — analogous "Two enums" callout.
 *   3. skills/tasks/loop.md §7c        — auto-repair guidance + SendMessage
 *                                        re-dispatch path for invalid status.
 *   4. skills/tasks/loop.md            — Important Rules callout: orchestrator
 *                                        may DOWNGRADE only, never UPGRADE.
 *   5. skills/tasks/loop.md §7b        — defaults to general-purpose subagent
 *                                        (named tasks-verifier is best-effort,
 *                                        not the primary dispatch path).
 *
 * Each section is a single tight assertion. If any of these regress, the
 * verifier-status bug will re-surface.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const VERIFIER_AGENT = resolve(REPO_ROOT, 'skills/agents/tasks-verifier.md');
const VERIFIER_CONTRACT = resolve(REPO_ROOT, 'docs/verifier-contract.md');
const LOOP_SKILL = resolve(REPO_ROOT, 'skills/tasks/loop.md');

describe('verifier status-enum hardening (post-Wave-2 session)', () => {
  const verifierAgent = readFileSync(VERIFIER_AGENT, 'utf8');
  const verifierContract = readFileSync(VERIFIER_CONTRACT, 'utf8');
  const loopSkill = readFileSync(LOOP_SKILL, 'utf8');

  describe('skills/agents/tasks-verifier.md', () => {
    it('has a ⚠ callout distinguishing top-level verdict from per-check status', () => {
      // The agent prompt is the highest-leverage surface — this is the file
      // the verifier subagent actually reads. The callout's headline must
      // be a heading the model can't gloss over.
      expect(verifierAgent).toMatch(/##\s+⚠\s+TWO different enums/);
    });

    it('shows a wrong example using status: "PARTIAL" (so the model recognizes the bug pattern)', () => {
      // The wrong example must appear verbatim in a fenced JSON block so the
      // model can pattern-match against its own output draft.
      expect(verifierAgent).toMatch(/"status":\s*"PARTIAL"/);
    });

    it('shows the right example using status: "SKIP" + UNCHECKABLE: prefix', () => {
      // Paired with the wrong example, the right example must exist.
      expect(verifierAgent).toMatch(/"status":\s*"SKIP"/);
      expect(verifierAgent).toMatch(/UNCHECKABLE:/);
    });

    it('reminds the verifier to self-check before emitting', () => {
      // A "before you emit, scan your checks[].status values" self-check
      // is the last-line-of-defense against the bug.
      expect(verifierAgent).toMatch(/Self-check before emitting/);
    });
  });

  describe('docs/verifier-contract.md', () => {
    it('has a "Two enums" callout matching the agent prompt', () => {
      // Contract doc must agree with the agent prompt verbatim on the rule;
      // future readers may reach the contract before the agent definition.
      expect(verifierContract).toMatch(/##\s+⚠\s+Two enums/i);
    });

    it('documents that status="PARTIAL" will fail schema validation', () => {
      // Knowing the failure mode (schema reject → NOT_VERIFIED) is essential
      // context for verifier authors writing future test fixtures.
      expect(verifierContract).toMatch(/PARTIAL.*[Ss]chema|[Ss]chema.*PARTIAL/);
    });
  });

  describe('skills/tasks/loop.md §7c — auto-repair invalid status', () => {
    it('describes the SendMessage re-dispatch path for invalid status: PARTIAL', () => {
      // When the verifier emits the bug, the orchestrator must NOT silently
      // accept or normalize — it must re-brief the same agent via SendMessage
      // (or dispatch fresh) with a tight diagnostic. This catches a future
      // edit that drops the re-dispatch protocol.
      const has = /SendMessage|re-dispatch|fresh verifier/i.test(loopSkill);
      expect(has).toBe(true);
    });

    it('names the invalid status="PARTIAL" pattern explicitly so future readers know the bug', () => {
      // Hard-coding the known failure mode in the skill itself prevents
      // re-discovery; future verifiers either follow the rule, or the
      // orchestrator catches the bug at parse time.
      expect(loopSkill).toMatch(/status:\s*"PARTIAL"|status.*PARTIAL.*invalid/i);
    });
  });

  describe('skills/tasks/loop.md — orchestrator override is DOWNGRADE-only', () => {
    it('states that the orchestrator MUST NOT upgrade verdicts', () => {
      // Upgrades (FAIL→PASS, PARTIAL→PASS, NOT_VERIFIED→anything) MUST come
      // from a fresh verifier with new evidence. The Wave-2 session violated
      // this twice; this rule pin prevents the rule itself from being
      // softened or removed.
      const upgradeForbidden =
        /MUST NOT upgrade/i.test(loopSkill) || /never upgrade/i.test(loopSkill);
      expect(upgradeForbidden).toBe(true);
    });

    it('mentions DOWNGRADE as the allowed override class', () => {
      // The allowed/forbidden distinction must be EXPLICIT — not just
      // "MUST NOT upgrade" but also "downgrades ARE allowed when the rollup
      // table contradicts the emitted verdict." Otherwise readers conclude
      // ALL overrides are forbidden, which would break the deterministic
      // rollup safety net.
      expect(loopSkill).toMatch(/DOWNGRADE|downgrade/);
    });
  });

  describe('skills/tasks/loop.md §7b — defaults to general-purpose subagent', () => {
    it('makes general-purpose the default subagent_type, not just a fallback', () => {
      // Named agents (subagent_type: "tasks-verifier") are only registered
      // after install.sh runs AND a fresh session starts. In any session
      // mid-flight the named agent typically isn't available, and an Agent
      // call with an unknown subagent_type FAILS. Defaulting to
      // general-purpose + embedded prompt is the reliable path. This
      // assertion guards against a future edit reverting to "prefer named,
      // fall back" which biases toward the unreliable path.
      expect(loopSkill).toMatch(/Default to .*general-purpose/i);
    });
  });
});
