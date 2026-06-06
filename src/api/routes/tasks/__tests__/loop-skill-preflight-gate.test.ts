import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Wave 4.2 (task #319) — /tasks:loop topology pre-flight gate.
 *
 * Static manifest that pins the §2f topology pre-flight gate into
 * `skills/tasks/loop.md`. The skill markdown is the source of truth the
 * orchestrator reads at runtime; if a future edit silently weakens the gate
 * (removes the DAG_CYCLIC unconditional halt, drops the canonical halt
 * message, deletes the `--i-know-what-im-doing` escape hatch, or removes
 * the `gate_decision` recording), this test fails so the regression
 * cannot land green.
 *
 * The live end-to-end test (3-project fixture: FLAT proceeds, DAG halts,
 * DAG_CYCLIC halts even with override flag) is scheduled for task #324
 * (Wave 7.2). This file is the FALSIFIABLE gate that protects the
 * skill-markdown wiring in the meantime.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const LOOP_SKILL_PATH = resolve(REPO_ROOT, 'skills/tasks/loop.md');
const LOOP_SHARED_PATH = resolve(REPO_ROOT, 'skills/tasks/loop-shared.md');

function section2fBody(skill: string): string {
  const lines = skill.split('\n');
  const startIdx = lines.findIndex((line) => line.startsWith('### 2f. Topology pre-flight gate'));
  if (startIdx < 0) return '';
  // §2f ends at either the next `### ` heading, the next `## ` heading, or
  // a `---` horizontal rule — whichever comes first.
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('### ') || lines[i].startsWith('## ') || lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

describe('/tasks:loop skill — topology pre-flight gate wiring (#319)', () => {
  const skill = readFileSync(LOOP_SKILL_PATH, 'utf8');
  const section2f = section2fBody(skill);

  it('has the verbatim §2f topology pre-flight gate heading', () => {
    // Heading text is contract — orchestrator decisions doc pins this exact
    // string so callers can grep `### 2f.` to find the gate.
    const hasHeading = skill
      .split('\n')
      .some((line) => line === '### 2f. Topology pre-flight gate');
    expect(hasHeading).toBe(true);
  });

  it('§2f section body is non-empty', () => {
    expect(section2f.length).toBeGreaterThan(0);
  });

  it('§2f mentions the topology_check MCP tool by name', () => {
    // The gate is gated on the existing #318 MCP tool — no new tool added.
    // Renaming or removing the call breaks the gate; this assertion fails.
    expect(section2f).toMatch(/topology_check/);
  });

  it('§2f documents all three topology branches (FLAT, DAG, DAG_CYCLIC)', () => {
    expect(section2f).toMatch(/FLAT/);
    expect(section2f).toMatch(/DAG/);
    expect(section2f).toMatch(/DAG_CYCLIC/);
  });

  it('§2f records all four gate_decision values (allowed, auto_ordered, overridden, blocked)', () => {
    // The four values mirror LoopRunFrontmatterSchema's enum exactly.
    // Removing any branch desyncs the skill from the schema. Wave 11 added
    // `auto_ordered` for the auto-resolving DAG branch (Kahn's algorithm).
    expect(section2f).toMatch(/gate_decision\s*=\s*["']allowed["']/);
    expect(section2f).toMatch(/gate_decision\s*=\s*["']auto_ordered["']/);
    expect(section2f).toMatch(/gate_decision\s*=\s*["']overridden["']/);
    expect(section2f).toMatch(/gate_decision\s*=\s*["']blocked["']/);
  });

  it('§2f contains the verbatim DAG halt message', () => {
    // Canonical halt copy from the orchestrator decisions doc — any drift
    // breaks the contract that callers (CI, downstream tools) rely on to
    // detect the halt path.
    const canonicalDagHalt =
      'has <count> dependency edges. Use /tasks:loop-dag (for wave-by-wave parallel dispatch) or run tasks individually in topological order. Override with --i-know-what-im-doing.';
    expect(section2f.includes(canonicalDagHalt)).toBe(true);
  });

  it('§2f contains the verbatim DAG_CYCLIC halt message', () => {
    // The DAG_CYCLIC message must call out cycles AND state that the
    // override flag does not apply. Both are load-bearing for the
    // unconditional-halt safety property.
    const canonicalCyclicHalt =
      'has a dependency cycle (DAG_CYCLIC). Cannot loop — cycles must be broken before any runner can proceed. --i-know-what-im-doing does NOT apply.';
    expect(section2f.includes(canonicalCyclicHalt)).toBe(true);
  });

  it('§2f explicitly states DAG_CYCLIC cannot be overridden by --i-know-what-im-doing', () => {
    // Belt-and-suspenders: even if the canonical-message assertion above
    // drifts on whitespace, the safety property — DAG_CYCLIC is
    // unoverridable — MUST be stated in prose. Accept either of the two
    // phrasings documented in the orchestrator decisions doc.
    const hasDoesNotApply = /DAG_CYCLIC[\s\S]{0,500}does NOT (apply|override)/.test(section2f);
    const hasMustNotOverride = /DAG_CYCLIC[\s\S]{0,500}MUST NOT override/.test(section2f);
    const hasReverseDoesNotApply = /(does NOT (apply|override))[\s\S]{0,500}DAG_CYCLIC/.test(
      section2f,
    );
    expect(hasDoesNotApply || hasMustNotOverride || hasReverseDoesNotApply).toBe(true);
  });

  it('§2f references --i-know-what-im-doing as the DAG override flag', () => {
    expect(section2f).toMatch(/--i-know-what-im-doing/);
  });

  it('§1 Argument Parsing documents --i-know-what-im-doing as an accepted flag', () => {
    // The flag must be advertised in §1 so a user reading argument-hint can
    // discover it — not buried in §2f only. Pin the cross-section presence.
    const lines = skill.split('\n');
    const startIdx = lines.findIndex((line) => line.startsWith('## 1. Argument Parsing'));
    const endIdx = lines.findIndex((line, i) => i > startIdx && line.startsWith('## 2.'));
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const argSection = lines.slice(startIdx, endIdx).join('\n');
    expect(argSection).toMatch(/--i-know-what-im-doing/);
  });

  it('skill references --i-know-what-im-doing at least three times (§1, §2f, §9c sources table)', () => {
    // Three documented sites: argument parsing (§1), gate body (§2f),
    // frontmatter-source documentation (§9c gate_decision row). A drop
    // below 3 means one of those sites was silently removed.
    const matches = skill.match(/--i-know-what-im-doing/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('§9c frontmatter sources table documents the gate_decision row', () => {
    // The gate decision flows into the LOOP-RUN.md frontmatter via Step 9.
    // The sources table moved to loop-shared.md §C in task #346 (refactor),
    // but the gate_decision → Section 2f anchor is preserved verbatim there
    // so a reader tracing field origins can still find the §2f link.
    const loopShared = readFileSync(LOOP_SHARED_PATH, 'utf8');
    expect(loopShared).toMatch(/`gate_decision`[^|]*\|[^|]*Section 2f/);
  });

  it('Step 9 cross-check from #316 still present (verifier wiring not silently weakened)', () => {
    // Cross-wave regression guard — if §2f's insertion accidentally
    // displaced Step 9, every LOOP-RUN.md emission breaks. Mirrors the
    // analogous check in loop-skill-loop-run-emit.test.ts.
    const hasStep9 = skill.split('\n').some((line) => line === '### Step 9 — Emit LOOP-RUN.md');
    expect(hasStep9).toBe(true);
  });
});
