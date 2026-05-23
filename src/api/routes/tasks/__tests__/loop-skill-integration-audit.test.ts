import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Wave 3.2 (task #317) — /tasks:loop INTEGRATION-AUDIT.md emission gate.
 *
 * Static manifest that pins the Step 10 integration-audit contract into
 * `skills/tasks/loop.md`. The skill markdown is the source of truth the
 * orchestrator reads at runtime; if a future edit silently removes Step 10
 * (or the empty-overlap suppression, or the BROKEN-revert protocol), this
 * test fails so the regression cannot land green.
 *
 * The live end-to-end test (multi-task fixture run with deliberate overlap
 * fixtures) is scheduled for task #324 (Wave 7.2). This file is the
 * FALSIFIABLE gate that protects the skill-markdown wiring + cross-references
 * in the meantime — plus the cross-references to Step 8 (close gate from
 * #315) and Step 9 (LOOP-RUN.md emit from #316) to catch silent
 * regressions on either side.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const LOOP_SKILL_PATH = resolve(REPO_ROOT, 'skills/tasks/loop.md');

function step10Section(skill: string): string {
  const lines = skill.split('\n');
  const startIdx = lines.findIndex((line) =>
    line.startsWith('### Step 10 — Integration audit'),
  );
  if (startIdx < 0) return '';
  // Step 10 is the terminal step; the section ends at the next `### Step `
  // heading (none currently) or the next top-level `## ` heading (e.g.
  // "## Pre-Existing Breakage Handling"). We deliberately do NOT key off
  // bare `---` lines here because the Step 10 body contains a YAML
  // frontmatter example inside a fenced code block that uses `---` as the
  // YAML delimiter — keying off `---` would truncate the section at the
  // example and hide the rest of the contract from the regression gate.
  let endIdx = lines.length;
  let inFence = false;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // Track fenced code blocks (triple-backtick) so headings/markers inside
    // a fence never count as section terminators.
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith('### Step ') || line.startsWith('## ')) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

describe('/tasks:loop skill — INTEGRATION-AUDIT.md emission wiring (#317)', () => {
  const skill = readFileSync(LOOP_SKILL_PATH, 'utf8');
  const step10 = step10Section(skill);

  it('has a Step 10 heading dedicated to integration audit', () => {
    const hasHeading = skill
      .split('\n')
      .some((line) => line.startsWith('### Step 10 — Integration audit'));
    expect(hasHeading).toBe(true);
  });

  it('Step 10 section is non-empty', () => {
    expect(step10.length).toBeGreaterThan(0);
  });

  it('Step 10 mentions the `-integration.md` artifact filename suffix', () => {
    // The filename convention is .planning/loops/<UTC>-<project_id>-integration.md
    // — keying the regression on `-integration.md` is stable against minor
    // path-format wording changes.
    expect(step10.includes('-integration.md')).toBe(true);
  });

  it('Step 10 references the .planning/loops/ artifact directory', () => {
    expect(step10.includes('.planning/loops/')).toBe(true);
  });

  it('Step 10 documents all three verdicts (SAFE, RISKY, BROKEN)', () => {
    expect(step10.includes('SAFE')).toBe(true);
    expect(step10.includes('RISKY')).toBe(true);
    expect(step10.includes('BROKEN')).toBe(true);
  });

  it('Step 10 names the integration-auditor subagent at least twice', () => {
    // Dispatch invocation + cross-reference to the agent definition file =
    // minimum 2 mentions. A future edit that removes the dispatch but leaves
    // a stale link would still fail because the dispatch pseudocode and the
    // bounds recap both reference the agent by name.
    const matches = step10.match(/integration-auditor/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('Step 10 states the empty-overlap suppression rule (no overlaps → no file)', () => {
    // Accept any of these phrasings; the load-bearing concept is "don't emit
    // when overlaps are empty". Falsifiable: a future edit that silently
    // emits an empty INTEGRATION-AUDIT.md would have to remove the rule.
    const hasSuppressionRule =
      /empty-overlap suppression|no overlaps.*not emit|do NOT emit INTEGRATION-AUDIT/i.test(
        step10,
      );
    expect(hasSuppressionRule).toBe(true);
  });

  it('Step 10 states the BROKEN-reverts-tasks-to-in_progress rule', () => {
    // BROKEN must revert tasks from done back to in_progress. Anchor on
    // both the BROKEN keyword and the in_progress transition appearing in
    // the same section.
    expect(step10.includes('BROKEN')).toBe(true);
    expect(step10.includes('in_progress')).toBe(true);
    // Stronger anchor: a "revert" verb near the BROKEN handling.
    const hasRevertLanguage = /revert/i.test(step10);
    expect(hasRevertLanguage).toBe(true);
  });

  it('Step 10 references the skills/agents/integration-auditor.md agent file', () => {
    expect(step10.includes('skills/agents/integration-auditor.md')).toBe(true);
  });

  it('Step 10 documents the per-overlap auditor dispatch (one per overlap, not one per file)', () => {
    // Load-bearing UX: each (file, task-pair) overlap gets its own auditor
    // invocation. A regression that batches multiple overlaps into one
    // auditor call would lose the per-overlap evidence trail.
    const hasPerOverlapRule = /one per overlap|per overlap|one auditor per overlap/i.test(
      step10,
    );
    expect(hasPerOverlapRule).toBe(true);
  });

  it('Step 10 documents the generated-file exclusion list (package-lock.json, *.lock, dist, coverage)', () => {
    expect(step10.includes('package-lock.json')).toBe(true);
    expect(step10.includes('*.lock')).toBe(true);
    expect(step10.includes('dist/')).toBe(true);
    expect(step10.includes('coverage/')).toBe(true);
  });

  it('Step 10 documents the run-termination trigger (NOT per-iteration)', () => {
    // Anchor on the explicit "ONCE" / "not per iteration" rule. A regression
    // that fires Step 10 every iteration would consume the auditor's budget
    // and produce dozens of redundant audits per run.
    const hasTerminationRule =
      /runs ONCE|run termination|not per iteration|terminal step/i.test(step10);
    expect(hasTerminationRule).toBe(true);
  });

  it('Step 10 documents the final LOOP-RUN.md re-emit on BROKEN', () => {
    // The orchestrator must re-emit Step 9 ONE final time after reverts so
    // the LOOP-RUN.md reflects the post-revert state, including a
    // `## Integration Failure` body section.
    expect(step10).toMatch(/re-emit/i);
    expect(step10.includes('Integration Failure')).toBe(true);
  });

  it('Step 10 cites the in-tree zod schema at src/lib/loop-run/integration-audit-schema.ts', () => {
    expect(step10.includes('src/lib/loop-run/integration-audit-schema.ts')).toBe(true);
  });

  it('§3 intro reads "ten steps" (NOT "nine steps") after #317', () => {
    expect(skill).toMatch(/\*\*ten steps\*\*/);
    expect(skill).not.toMatch(/\*\*nine steps\*\*/);
  });

  it('Step 9 (LOOP-RUN.md emit) is preserved — regression catch for #316 wiring', () => {
    // Cross-check that the Wave 3.2 edit did not silently weaken the
    // LOOP-RUN.md emission from Wave 3.1. If Step 9 disappeared the
    // run-summary artifact is gone.
    const hasStep9 = skill
      .split('\n')
      .some((line) => line.startsWith('### Step 9 — Emit LOOP-RUN.md'));
    expect(hasStep9).toBe(true);
  });

  it('Step 8 (close the bugs-db task) is preserved — regression catch for #315 wiring', () => {
    // Cross-check that the Wave 3.2 edit did not silently weaken the
    // verifier-gated close from Wave 2.2.
    const hasStep8 = skill
      .split('\n')
      .some((line) => /^### Step 8 — Close the bugs-db task/.test(line));
    expect(hasStep8).toBe(true);
  });

  it('skill references integration-auditor across the file at least 3 times', () => {
    // Step 10 dispatch + cross-reference at top of Step 10 + bounds recap.
    // A future edit that removes one mention without removing them all is
    // still a regression — the agent should be referenced wherever the
    // dispatch path is documented.
    const matches = skill.match(/integration-auditor/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});
