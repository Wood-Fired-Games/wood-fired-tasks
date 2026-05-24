import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Task #346 — loop.md refactor + loop-shared.md extraction gate.
 *
 * Static manifest that pins the refactor's load-bearing invariants:
 *
 *  1. `skills/tasks/loop-shared.md` exists, is non-invocable
 *     (`disable-model-invocation: true`), and contains the three blocks
 *     §A (worker brief template), §B (VerifierInputs envelope spec),
 *     §C (LOOP-RUN.md frontmatter required fields).
 *  2. Both `loop.md` and `loop-dag.md` carry at least one link back to
 *     `loop-shared.md` so the orchestrator can find the shared contracts
 *     mid-run.
 *  3. `loop.md` stays under the 700-line hard cap the refactor commits to.
 *  4. The 5+ original "cross-repo" mentions in `loop.md` are consolidated
 *     to ≤ 3 lowercase references (canonical §2a block + cross-references).
 *
 * Each assertion is independently falsifiable so a regression that, say,
 * silently drops the link from `loop-dag.md` or bloats `loop.md` past 700
 * lines fails the gate before it ships.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const LOOP_PATH = resolve(REPO_ROOT, 'skills/tasks/loop.md');
const LOOP_DAG_PATH = resolve(REPO_ROOT, 'skills/tasks/loop-dag.md');
const LOOP_SHARED_PATH = resolve(REPO_ROOT, 'skills/tasks/loop-shared.md');

function countLines(path: string): number {
  return readFileSync(path, 'utf8').split('\n').length;
}

describe('loop-shared.md extraction gate (#346)', () => {
  it('loop-shared.md exists as a regular file', () => {
    expect(() => statSync(LOOP_SHARED_PATH)).not.toThrow();
    expect(statSync(LOOP_SHARED_PATH).isFile()).toBe(true);
  });

  it('loop-shared.md frontmatter declares disable-model-invocation: true', () => {
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    expect(text.startsWith('---\n')).toBe(true);
    const fmEnd = text.indexOf('\n---\n', 4);
    expect(fmEnd).toBeGreaterThan(0);
    const frontmatter = text.slice(4, fmEnd);
    expect(frontmatter).toMatch(/^name:\s*loop-shared\s*$/m);
    expect(frontmatter).toMatch(/^disable-model-invocation:\s*true\s*$/m);
  });

  it('loop-shared.md contains §A worker brief template heading', () => {
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    const hasHeading = text
      .split('\n')
      .some((line) => /^##\s+§A\.\s+Worker brief template/.test(line));
    expect(hasHeading).toBe(true);
  });

  it('loop-shared.md contains §B VerifierInputs envelope spec heading', () => {
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    const hasHeading = text
      .split('\n')
      .some((line) => /^##\s+§B\.\s+VerifierInputs envelope spec/.test(line));
    expect(hasHeading).toBe(true);
  });

  it('loop-shared.md contains §C LOOP-RUN.md frontmatter required fields heading', () => {
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    const hasHeading = text
      .split('\n')
      .some((line) => /^##\s+§C\.\s+LOOP-RUN\.md frontmatter required fields/.test(line));
    expect(hasHeading).toBe(true);
  });

  it('loop-shared.md §A retains the load-bearing "Do NOT commit" closing constraint', () => {
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    expect(text).toMatch(/Do NOT commit/);
  });

  it('loop-shared.md §B retains the VerifierInputs interface fields', () => {
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    expect(text).toMatch(/task_id:\s*<id>/);
    expect(text).toMatch(/acceptance_criteria:\s*<string>/);
    expect(text).toMatch(/worker_subagent_session_id:\s*<string>/);
    expect(text).toMatch(/commit_shas:\s*<string\[\]>/);
    expect(text).toMatch(/file_changes:\s*<string\[\]>/);
  });

  it('loop-shared.md §C lists all 14 LOOP-RUN.md frontmatter fields', () => {
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    // Each field appears in the table as `field_name` in backticks.
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
      'gate_decision',
    ];
    for (const field of REQUIRED_FIELDS) {
      expect(text).toContain(`\`${field}\``);
    }
  });

  it('loop.md links to loop-shared.md', () => {
    const text = readFileSync(LOOP_PATH, 'utf8');
    expect(text).toMatch(/loop-shared\.md/);
  });

  it('loop-dag.md links to loop-shared.md', () => {
    const text = readFileSync(LOOP_DAG_PATH, 'utf8');
    expect(text).toMatch(/loop-shared\.md/);
  });

  it('loop.md stays under the 700-line hard cap', () => {
    expect(countLines(LOOP_PATH)).toBeLessThan(700);
  });

  it('loop.md has ≤ 3 lowercase "cross-repo" mentions (consolidated to canonical §2a)', () => {
    const text = readFileSync(LOOP_PATH, 'utf8');
    const matches = text.match(/cross-repo/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(3);
  });

  it('loop.md preserves the canonical §2a "Cross-repo scope detection" anchor', () => {
    // Capitalized form — the canonical heading reference that §2c, §2e, and
    // Step 4 defer to. Removing this anchor would orphan every cross-reference.
    const text = readFileSync(LOOP_PATH, 'utf8');
    expect(text).toMatch(/\*\*Cross-repo scope detection\*\*/);
  });

  it('loop-dag.md top-of-file cross-reference points at loop-shared.md §A/§B/§C', () => {
    // The first-200-line window MUST mention §A, §B, and §C so a fresh reader
    // sees the cross-reference before diving into the wave-loop sections.
    const text = readFileSync(LOOP_DAG_PATH, 'utf8');
    const head = text.split('\n').slice(0, 200).join('\n');
    expect(head).toMatch(/§A/);
    expect(head).toMatch(/§B/);
    expect(head).toMatch(/§C/);
  });

  it('loop-dag.md is smaller than the pre-refactor baseline (≤ 400 lines target)', () => {
    // Pre-refactor baseline: 444 lines. Refactor goal: ~300, hard ceiling 400.
    expect(countLines(LOOP_DAG_PATH)).toBeLessThanOrEqual(400);
  });
});
