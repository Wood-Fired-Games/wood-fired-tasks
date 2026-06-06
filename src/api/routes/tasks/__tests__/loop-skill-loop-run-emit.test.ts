import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Wave 3.1 (task #316) — /tasks:loop LOOP-RUN.md emission gate.
 *
 * Static manifest that pins the Step 9 emission contract into
 * `skills/tasks/loop.md`. The skill markdown is the source of truth the
 * orchestrator reads at runtime; if a future edit silently removes Step 9
 * (or the kill-safe incremental rewrite, or the gitignored rationale), this
 * test fails so the regression cannot land green.
 *
 * The live end-to-end test (3-task fixture run + Project 12 replay) is
 * scheduled for task #324 (Wave 7.2). This file is the FALSIFIABLE gate that
 * protects the skill-markdown wiring + cross-references in the meantime.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const LOOP_SKILL_PATH = resolve(REPO_ROOT, 'skills/tasks/loop.md');

function step9Section(skill: string): string {
  const lines = skill.split('\n');
  const startIdx = lines.findIndex((line) => line.startsWith('### Step 9 — Emit LOOP-RUN.md'));
  if (startIdx < 0) return '';
  // The Step 9 section ends at either the next `### Step ` heading (none
  // currently) or the next `---` horizontal rule (the section break before
  // "## Pre-Existing Breakage Handling").
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('### Step ') || lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

describe('/tasks:loop skill — LOOP-RUN.md emission wiring (#316)', () => {
  const skill = readFileSync(LOOP_SKILL_PATH, 'utf8');
  const step9 = step9Section(skill);

  it('has a Step 9 heading dedicated to emitting LOOP-RUN.md', () => {
    const hasHeading = skill.split('\n').some((line) => line === '### Step 9 — Emit LOOP-RUN.md');
    expect(hasHeading).toBe(true);
  });

  it('Step 9 section is non-empty', () => {
    expect(step9.length).toBeGreaterThan(0);
  });

  it('Step 9 references the .planning/loops/ artifact directory', () => {
    expect(step9.includes('.planning/loops/')).toBe(true);
  });

  it('Step 9 cites docs/loop-run-schema.md as the contract source', () => {
    expect(step9.includes('docs/loop-run-schema.md')).toBe(true);
  });

  it('Step 9 references the in-tree zod schema at src/lib/loop-run/schema.ts', () => {
    expect(step9.includes('src/lib/loop-run/schema.ts')).toBe(true);
  });

  it('Step 9 documents the kill-safe incremental rewrite pattern', () => {
    // Accept any of three phrasings — keeps the test stable against
    // wording polish but locks in the load-bearing concept.
    const hasIncrementalPattern =
      /incrementally|after each task|after every task|after EACH task/i.test(step9);
    expect(hasIncrementalPattern).toBe(true);
  });

  it('Step 9 documents the "not committed" rationale (gitignored)', () => {
    const hasRationale = /gitignored|not committed|MUST NOT `git add`/i.test(step9);
    expect(hasRationale).toBe(true);
  });

  it('§3 intro reads "ten steps" after Wave 3.2 (#317) added Step 10 integration audit', () => {
    // Pre-Wave-3.2 this said "nine steps"; Wave 3.2 (task #317) added Step 10
    // (integration audit at run termination) and updated the intro. Test
    // pinned at "ten steps" so any future addition/removal of a step that
    // forgets to update the intro fails here.
    expect(skill).toMatch(/\*\*ten steps\*\*/);
    expect(skill).not.toMatch(/\*\*nine steps\*\*/);
    expect(skill).not.toMatch(/\*\*eight steps\*\*/);
  });

  it('verifier wiring from #315 is preserved (Step 8 close-the-task heading still present)', () => {
    // Cross-check that the Wave 3.1 edit did not silently weaken the
    // generator/critic separation from Wave 2.2. If Step 8 disappeared
    // the verifier gate is gone.
    const hasStep8Close = skill
      .split('\n')
      .some((line) => /^### Step 8 — Close the task/.test(line));
    expect(hasStep8Close).toBe(true);
  });
});
