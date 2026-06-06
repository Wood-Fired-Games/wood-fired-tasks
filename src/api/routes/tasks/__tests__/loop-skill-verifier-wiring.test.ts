import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Wave 2.2 (task #315) — /tasks:loop verifier-wiring gate.
 *
 * Static manifest that pins the verifier dispatch into `skills/tasks/loop.md`.
 * The skill markdown is the source of truth the orchestrator reads at
 * runtime; if a future edit silently removes the verifier dispatch step
 * (or the verdict branches, or the generator/critic separation rule),
 * this test fails so the regression cannot land green.
 *
 * The live end-to-end test (3-task fixture project, 2 PASS + 1 FAIL
 * verdict distribution, non-NULL verification_evidence on all rows) is
 * scheduled for task #324 (Wave 7.2). This file is the FALSIFIABLE gate
 * that protects the skill-markdown wiring in the meantime.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const LOOP_SKILL_PATH = resolve(REPO_ROOT, 'skills/tasks/loop.md');

describe('/tasks:loop skill — verifier dispatch wiring (#315)', () => {
  const skill = readFileSync(LOOP_SKILL_PATH, 'utf8');

  it('mentions the tasks-verifier subagent by name', () => {
    expect(skill).toMatch(/tasks-verifier/);
  });

  it('cites docs/verifier-contract.md as the authoritative contract', () => {
    expect(skill.includes('docs/verifier-contract.md')).toBe(true);
  });

  it('has a Step 7 heading dedicated to dispatching the verifier', () => {
    // Verbatim heading — orchestrator decision: insertion point between
    // commit/push (old Step 6) and close (renumbered to Step 8).
    const hasHeading = skill
      .split('\n')
      .some((line) => line.startsWith('### Step 7 — Dispatch tasks-verifier'));
    expect(hasHeading).toBe(true);
  });

  it('renumbers the close-the-task step to Step 8', () => {
    // The pre-Wave-2.2 close step was Step 7; after the verifier insert
    // it must be Step 8. Catches a future edit that removes the verifier
    // and silently shifts close back to Step 7 without restoring the
    // dispatch logic.
    const hasStep8Close = skill
      .split('\n')
      .some((line) => /^### Step 8 — Close the task/.test(line));
    expect(hasStep8Close).toBe(true);
  });

  it('documents the four verdict branches (PASS, FAIL, PARTIAL, NOT_VERIFIED)', () => {
    // Quote style is permissive — either "PASS" or 'PASS' satisfies.
    expect(skill).toMatch(/verdict:\s*["']PASS["']/);
    expect(skill).toMatch(/verdict:\s*["']FAIL["']/);
    expect(skill).toMatch(/verdict:\s*["']PARTIAL["']/);
    expect(skill).toMatch(/verdict:\s*["']NOT_VERIFIED["']/);
  });

  it('flips the task to blocked on the FAIL branch', () => {
    // The blocked transition is the load-bearing safety property of the
    // FAIL branch — without it a FAIL verdict could silently become done.
    expect(skill.includes('status": "blocked"') || skill.includes("status': 'blocked'")).toBe(true);
  });

  it('has a Generator/critic separation callout', () => {
    // Accept either a heading or a bullet-bold form. The rule must be
    // surfaced as a top-level callout under Important Rules, not buried
    // inside Step 7 prose.
    const hasCallout =
      /^###\s+Generator\/critic separation/m.test(skill) ||
      /^-\s+\*\*Generator\/critic separation[^*]*\*\*/m.test(skill);
    expect(hasCallout).toBe(true);
  });

  it('forbids the orchestrator from grading its own dispatches', () => {
    // Anchor: "MUST NOT" within a short window of "verifier" or "grade".
    // This guarantees the separation rule is stated as a hard constraint,
    // not a soft preference.
    const mustNotNearVerifier = /MUST NOT[^\n]{0,200}(verifier|grade)/i.test(skill);
    const mustNotNearVerifierReverse = /(verifier|grade)[^\n]{0,200}MUST NOT/i.test(skill);
    expect(mustNotNearVerifier || mustNotNearVerifierReverse).toBe(true);
  });

  it('references tasks-verifier in at least 3 distinct contexts', () => {
    // Dispatch invocation + separation callout + cross-reference =
    // minimum 3 mentions. A future edit that removes the dispatch but
    // leaves a stale link still fails: the dispatch pseudocode alone
    // accounts for 2+ of these mentions.
    const matches = skill.match(/tasks-verifier/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});
