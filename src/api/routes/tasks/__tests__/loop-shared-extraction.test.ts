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
const TASKS_VERIFIER_PATH = resolve(REPO_ROOT, 'skills/agents/tasks-verifier.md');

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

  it('loop-dag.md stays under the 500-line hard cap', () => {
    // Pre-refactor baseline: 444 lines. Refactor goal: ~300; hard ceiling raised
    // 400→500 to give loop-hardening additions room without forcing extraction
    // of every clause into loop-shared.md.
    expect(countLines(LOOP_DAG_PATH)).toBeLessThanOrEqual(500);
  });

  it('loop.md never labels the §L anchor as §A (2026-07 quality plan T5)', () => {
    const text = readFileSync(LOOP_PATH, 'utf8');
    expect(text).not.toMatch(/§A\]\(\.?\/?loop-shared\.md#l-anti-fabrication/);
  });

  it('§A Reporting back requires a Per-AC evidence map (2026-07 quality plan T7)', () => {
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    expect(text).toMatch(/\*\*Per-AC evidence map\*\*/);
  });

  it('loop.md Step 5 rejects reports missing the Per-AC evidence map', () => {
    const text = readFileSync(LOOP_PATH, 'utf8');
    expect(text).toMatch(/Per-AC evidence map/);
  });

  it('loop-shared.md contains §T decomposition artifact reuse (2026-07 quality plan T10)', () => {
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    expect(text).toMatch(/^##\s+§T\.\s+Decomposition artifact reuse/m);
  });

  it('both executors point at §T', () => {
    expect(readFileSync(LOOP_PATH, 'utf8')).toMatch(/§T/);
    expect(readFileSync(LOOP_DAG_PATH, 'utf8')).toMatch(/§T/);
  });

  it('loop-shared.md contains §S execution ledger (2026-07 quality plan T13)', () => {
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    expect(text).toMatch(/^##\s+§S\.\s+Execution ledger/m);
  });

  it('all four orchestrator skills point at §S anchor link (not just bare §S label)', () => {
    // AC2: bare "§S" is insufficient — a section can keep the label while
    // reverting the pointer from the full anchor to free text.  Require
    // the concrete link `loop-shared.md#s-execution-ledger` so a regression
    // that drops the anchor is caught even if the §S label survives.
    for (const rel of [
      'skills/tasks/loop.md',
      'skills/tasks/loop-dag.md',
      'skills/tasks/decompose.md',
      'skills/tasks/audit.md',
    ]) {
      expect(readFileSync(resolve(REPO_ROOT, rel), 'utf8')).toMatch(
        /loop-shared\.md#s-execution-ledger/,
      );
    }
  });

  it('loop-shared.md §S names a concrete ## Ledger Defects section (2026-07 quality plan T13)', () => {
    // AC2: §S must name a concrete artifact section so enforcement does not
    // rely on the model volunteering a confession. Detects regression if the
    // section heading is silently removed from §S.
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    expect(text).toMatch(/## Ledger Defects/);
    expect(text).toMatch(/_No ledger defects: every ledger row completed\._/);
  });

  it('tasks-verifier.md step 5 records a synthetic check when self-validation is unavailable or exhausted (2026-07 quality plan T13)', () => {
    // AC1: when the fallback fires (validator unavailable) or two re-validates
    // are exhausted, the verifier must record it as a synthetic check so the
    // orchestrator knows the gate never ran. Detects regression if this
    // instruction is silently dropped from step 5.
    const text = readFileSync(TASKS_VERIFIER_PATH, 'utf8');
    expect(text).toMatch(/add a synthetic check/);
    expect(text).toMatch(/"name": "self-validation"/);
    expect(text).toMatch(/UNCHECKABLE: self-validation unavailable/);
    expect(text).toMatch(/UNCHECKABLE: self-validation exhausted after/);
  });

  it('loop-shared.md §B no longer instructs verifier to surface unplanned-fixes in additional_observations (2026-07 quality plan T13)', () => {
    // AC3: additional_observations is an orchestrator→verifier INPUT field;
    // the old wording told the verifier to write there (invalid). Now it must
    // surface the assessment as a dedicated check instead.
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    expect(text).not.toMatch(/Surface the assessment in `additional_observations`/);
    // The replacement instruction must be present.
    expect(text).toMatch(/Surface the assessment as a dedicated check/);
    expect(text).toMatch(/"unplanned fixes assessment"/);
  });

  it('tasks-verifier.md step 0 distinguishes baseline mismatch from unresolvable baseline (2026-07 quality plan T13; SCM migration #1538)', () => {
    // AC4 (post-SCM-migration): step 0 resolves the worktree baseline via
    // `tasks scm baseline` (data.id), not raw git. Two distinct NOT_VERIFIED
    // failure shapes remain — (a) baseline resolved but its id diverges from
    // base_sha, (b) baseline unresolvable (backend error / shallow clone) —
    // each emitting different evidence text.
    const text = readFileSync(TASKS_VERIFIER_PATH, 'utf8');
    expect(text).toMatch(/tasks scm baseline/);
    expect(text).toMatch(/Baseline resolved but/);
    expect(text).toMatch(/Baseline unresolvable/);
    expect(text).toMatch(/worktree baseline <data\.id> ≠ base_sha/);
    expect(text).toMatch(/cannot assert the worktree baseline/);
  });

  it('loop-shared.md gates raw-git STEP 0 and §Q behind the GIT/PLATFORM-WORKTREE ISOLATION ONLY callout (task #1553)', () => {
    // The two executable raw-git paths in loop-shared.md — the §A STEP 0
    // worktree-base guard and §Q worktree-patch integration mechanics — are
    // reachable from backend-agnostic (pluggable-SCM) orchestration and only
    // apply under the git/platform-worktree isolation path. Each region MUST
    // open with the exact gate phrase, pinned verbatim so a regression that
    // silently drops the gate (or paraphrases it) fails this test.
    const GATE_PHRASE = 'GIT/PLATFORM-WORKTREE ISOLATION ONLY';
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    const lines = text.split('\n');

    const step0Start = lines.findIndex((line) =>
      /^## STEP 0 — Worktree base correction/.test(line),
    );
    expect(step0Start).toBeGreaterThanOrEqual(0);
    const step0End = lines.findIndex(
      (line, i) => i > step0Start && /^## Working dir \/ Cross-repo context/.test(line),
    );
    expect(step0End).toBeGreaterThan(step0Start);
    const step0Region = lines.slice(step0Start, step0End).join('\n');
    expect(step0Region).toContain(GATE_PHRASE);

    const qStart = lines.findIndex((line) =>
      /^##\s+§Q\.\s+Worktree-patch integration mechanics/.test(line),
    );
    expect(qStart).toBeGreaterThanOrEqual(0);
    const qEnd = lines.findIndex((line, i) => i > qStart && /^##\s+§R\./.test(line));
    expect(qEnd).toBeGreaterThan(qStart);
    const qRegion = lines.slice(qStart, qEnd).join('\n');
    expect(qRegion).toContain(GATE_PHRASE);
  });

  it('loop-shared.md qualifies the incidental raw-git reads (§D diff excerpts, §O reachability diff) as git-backend with an scm changed-files fallback (task #1553)', () => {
    // These reads are read-only evidence gathering, genuinely git-specific
    // (path-scoped diff excerpts), so they carry an inline qualifier rather
    // than a full step-skip gate — pin that the qualifier text survives.
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    const qualifierMatches =
      text.match(/git backend; under perforce\/none derive the equivalent/g) ?? [];
    // §D has two occurrences (task #<id_a> and #<id_b> diff excerpts), §O has one.
    expect(qualifierMatches.length).toBeGreaterThanOrEqual(3);
    expect(text).toMatch(/tasks scm changed-files <base>/);
  });

  it('loop-shared.md §A identity-resolution note lists p4 info User ahead of $USER (task #1562)', () => {
    // §A's identity-resolution note must insert `p4 info` (perforce User source)
    // ahead of `$USER` in the resolution chain, matching docs/SCM.md's
    // documented order (git config user.email → p4 info User → $USER →
    // claude-<model>-<purpose>). Region-sliced on the §A heading through the
    // next top-level §-heading (§L) so this only checks the §A slice.
    const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
    const lines = text.split('\n');

    const aStart = lines.findIndex((line) => /^##\s+§A\.\s+Worker brief template/.test(line));
    expect(aStart).toBeGreaterThanOrEqual(0);
    const aEnd = lines.findIndex((line, i) => i > aStart && /^##\s+§L\./.test(line));
    expect(aEnd).toBeGreaterThan(aStart);
    const aRegion = lines.slice(aStart, aEnd).join('\n');

    const p4Index = aRegion.indexOf('p4 info');
    const userIndex = aRegion.indexOf('$USER');
    expect(p4Index).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(p4Index).toBeLessThan(userIndex);
  });
});
