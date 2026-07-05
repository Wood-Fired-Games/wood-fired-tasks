import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Wave 4.3 (task #341) — /tasks:loop-dag DAG executor static gate.
 *
 * Falsifiable manifest that pins the load-bearing contract of
 * `skills/tasks/loop-dag.md` into the test suite. The skill markdown is the
 * source of truth the orchestrator reads at runtime; if a future edit
 * silently weakens the executor (drops the FLAT refusal, drops the
 * DAG_CYCLIC refusal, removes the frontier-fixture invariant, drops the
 * mandatory verifier dispatch reference, deletes the wave_summary body
 * section requirement, etc.), this test fails so the regression cannot
 * land green.
 *
 * The live end-to-end test (5-task / 4-edge / 3-wave DAG fixture +
 * FAIL-stops-downstream injection + Project 11 FLAT refusal + 2-task
 * cyclic refusal) is deferred to the runtime implementation follow-on
 * task. This file is the in-tree contract gate that protects the
 * skill-markdown wiring in the meantime.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..');
const LOOP_DAG_SKILL_PATH = resolve(REPO_ROOT, 'skills/tasks/loop-dag.md');

describe('/tasks:loop-dag skill — DAG executor contract (#341)', () => {
  const skill = readFileSync(LOOP_DAG_SKILL_PATH, 'utf8');

  it('has a valid frontmatter naming the skill `loop-dag`', () => {
    expect(skill.startsWith('---\n')).toBe(true);
    const fmEnd = skill.indexOf('\n---\n', 4);
    expect(fmEnd).toBeGreaterThan(0);
    const frontmatter = skill.slice(4, fmEnd);
    expect(frontmatter).toMatch(/^name:\s*loop-dag\s*$/m);
    expect(frontmatter).toMatch(/^description:.+/m);
    expect(frontmatter).toMatch(/^argument-hint:.+--max-waves.+--concurrency/m);
  });

  it('§2f refuses FLAT topology with a verbatim canonical message', () => {
    // The FLAT refusal must call /tasks:loop out by name as the correct
    // executor — silent fallthrough would defeat the entire point of the
    // topology gate.
    expect(skill).toMatch(/topology:\s*["']FLAT["']/);
    expect(skill).toMatch(
      /has zero dependency edges \(topology=FLAT\)\. \/tasks:loop-dag is the wrong executor for this project — use \/tasks:loop instead/,
    );
  });

  it('§2f refuses DAG_CYCLIC topology with a verbatim canonical message', () => {
    expect(skill).toMatch(/topology:\s*["']DAG_CYCLIC["']/);
    expect(skill).toMatch(
      /has a dependency cycle \(DAG_CYCLIC\)\. Cannot loop — cycles must be broken before any runner can proceed/,
    );
    // The refusal must also explicitly state there is no override flag —
    // belt-and-suspenders, mirrors loop-skill-preflight-gate.test.ts's
    // DAG_CYCLIC unconditional-halt assertion.
    expect(skill).toMatch(/No override flag applies/);
  });

  it('§2f accepts DAG with gate_decision="allowed" and no --i-know-what-im-doing override', () => {
    // The skill MUST set gate_decision="allowed" on the DAG happy path
    // (matching LoopRunFrontmatterSchema's enum) and MUST NOT introduce
    // an override flag — running a DAG flat would silently violate the
    // dependency contract.
    expect(skill).toMatch(/topology:\s*["']DAG["']/);
    expect(skill).toMatch(/gate_decision\s*=\s*["']allowed["']/);
    expect(skill).toMatch(/No `--i-know-what-im-doing` override exists for this skill/);
  });

  it('records gate_decision values matching LoopRunFrontmatterSchema', () => {
    // /tasks:loop-dag only emits gate_decision="allowed" (DAG happy) or
    // "blocked" (FLAT/DAG_CYCLIC refusal). The other two enum values
    // (auto_ordered, overridden) are /tasks:loop-only. The skill MUST
    // reference both values it emits so any drift from the schema is
    // visible.
    expect(skill).toMatch(/gate_decision\s*=\s*["']allowed["']/);
    expect(skill).toMatch(/gate_decision\s*=\s*["']blocked["']/);
  });

  it('§3a pins the frontier-fixture correctness invariant', () => {
    // The fixture is the load-bearing correctness contract from #341's
    // acceptance criteria: edges {334→337, 335→337, 337→338, 337→339}
    // MUST produce waves {334, 335} / {337} / {338, 339}. Any change to
    // the frontier algorithm must preserve this fixture's wave shape.
    expect(skill).toMatch(/334.+337/);
    expect(skill).toMatch(/335.+337/);
    expect(skill).toMatch(/337.+338/);
    expect(skill).toMatch(/337.+339/);
    expect(skill).toMatch(/\{334,\s*335\}.+\{337\}.+\{338,\s*339\}/);
  });

  it('§3a defines the frontier as open tasks whose blocked_by edges are all satisfied', () => {
    // The textual definition of the frontier MUST appear verbatim — this
    // is the algorithmic invariant the test fixture above exercises.
    expect(skill).toMatch(/frontier.+open tasks whose\s+`blocked_by`\s+edges are ALL closed/);
  });

  it('§3b dispatches workers in parallel under a --concurrency cap', () => {
    // Parallel dispatch is the entire reason /tasks:loop-dag exists as a
    // sibling to /tasks:loop. The skill MUST tell the orchestrator to
    // issue the wave's Agent calls in a single message when concurrency
    // K >= 2, and MUST require a `name:` per worker so SendMessage
    // diagnostics can reach a single worker mid-wave.
    expect(skill).toMatch(/--concurrency K\s*>=?\s*2/);
    expect(skill).toMatch(/in a \*\*single message\*\* so they execute concurrently/);
    expect(skill).toMatch(/name:\s*"worker-task-<id>"/);
  });

  it('§3d mandates a tasks-verifier dispatch per worker (#315 contract)', () => {
    // The mandatory verifier dispatch IS the #315 generator/critic
    // separation rule applied to a DAG runner. Dropping it would silently
    // re-introduce the "closed status, no evidence" failure mode #315
    // existed to eliminate.
    expect(skill).toMatch(/tasks-verifier/);
    expect(skill).toMatch(/non-negotiable/);
    // The skill MUST cite the loop.md §Step 7 reuse so the contract
    // doesn't drift between the two skills.
    expect(skill).toMatch(/loop\.md.+§Step 7/);
  });

  it('§3d FAIL branch flips the task to status=blocked and freezes downstream', () => {
    // The load-bearing dependency-respecting property: FAIL stops the
    // chain. The skill MUST explicitly state downstream tasks STAY OPEN
    // and will not appear on a future frontier — silent retry would
    // defeat the entire executor.
    expect(skill).toMatch(/status["']?\s*:\s*["']blocked["']/);
    expect(skill).toMatch(/Downstream tasks.+MUST stay\s+`open`/);
    expect(skill).toMatch(/MUST NOT silently re-attempt/);
  });

  it('§3e records a wave_summary entry per wave with task_ids + verdicts', () => {
    // The wave_summary is the audit artifact that makes a DAG run
    // replayable wave-by-wave. Without per-wave task_ids + verdicts the
    // LOOP-RUN.md output cannot answer "which tasks ran in parallel?".
    expect(skill).toMatch(/wave_summary/);
    expect(skill).toMatch(/wave_index/);
    expect(skill).toMatch(/task_ids/);
    expect(skill).toMatch(/verdicts/);
  });

  it('§3f runs the integration-auditor per wave on file overlaps (#317 contract)', () => {
    // The per-wave integration audit is the #317 contract scaled to wave
    // granularity. The skill MUST reuse loop.md §10b–§10e verbatim and
    // MUST emit a per-wave artifact with a -wave<idx>- suffix so it
    // doesn't collide with the run-termination integration-audit
    // artifact from §4.
    expect(skill).toMatch(/§3f/);
    expect(skill).toMatch(/integration-auditor/);
    expect(skill).toMatch(/-wave<wave_index>-integration\.md/);
  });

  it('§5d emits a `## Wave Summary` body section in LOOP-RUN.md', () => {
    // The body section is the on-disk surface of the §3e wave_summary
    // state. The skill prose IS the contract — the LoopRunFrontmatterSchema
    // is deliberately not extended (mirrors the Wave 3.1 / #316 decision
    // that body sections do not need a zod schema mirror).
    expect(skill).toMatch(/## Wave Summary/);
    expect(skill).toMatch(/wave_index \| task_ids \| started_at \| ended_at/);
  });

  it('§5d emits a `## Stalled Tasks` body section when the frontier empties with open tasks remaining', () => {
    // The stalled-tasks section is what surfaces transitively-blocked
    // work after a FAIL. Without it, a user reading LOOP-RUN.md cannot
    // tell whether the loop terminated cleanly or stranded downstream
    // tasks because of an upstream FAIL.
    expect(skill).toMatch(/## Stalled Tasks/);
    expect(skill).toMatch(/blocked transitively by/);
  });

  it('§5b emits LOOP-RUN.md kill-safely after each wave', () => {
    // Kill-safe re-emission per wave is the analog of loop.md §9b's
    // per-task re-emission. Without it, a killed run leaves no audit
    // trail.
    expect(skill).toMatch(/kill-safe/i);
    expect(skill).toMatch(/after EACH wave/);
  });

  it('artifact path is .planning/loops/<UTC-timestamp>-<project_id>.md (same as /tasks:loop)', () => {
    // Shared path convention — keeps `.planning/loops/` consistent so
    // tooling reading either /tasks:loop or /tasks:loop-dag artifacts
    // does not need to special-case the path.
    expect(skill).toMatch(/\.planning\/loops\/<UTC-timestamp>-<project_id>\.md/);
  });

  it('Important Rules pin the generator/critic separation and DAG-only refusal contract', () => {
    // The four load-bearing rules are: (1) generator/critic separation,
    // (2) wave-by-wave parallel dispatch, (3) FAIL stops the chain,
    // (4) refuse FLAT, (5) refuse DAG_CYCLIC. All must be present.
    expect(skill).toMatch(/Generator\/critic separation/);
    expect(skill).toMatch(/Wave-by-wave parallel dispatch/);
    expect(skill).toMatch(/Verifier=FAIL stops the dependency chain/);
    expect(skill).toMatch(/MUST NOT execute when topology is FLAT/);
    expect(skill).toMatch(/MUST NOT execute when topology is DAG_CYCLIC/);
  });

  it('does NOT introduce a new MCP tool — reuses topology_check (#318)', () => {
    // #318 is the only topology classifier. /tasks:loop-dag MUST consume
    // its output, not duplicate it.
    expect(skill).toMatch(/topology_check/);
  });

  it('does NOT mention /gsd-autonomous anywhere in the skill', () => {
    // Wave 4.3 / #341 explicitly eliminates the /gsd-autonomous string
    // from the advisory chain. The new skill MUST be a clean break.
    expect(skill).not.toMatch(/\/gsd-autonomous/);
  });
});

describe('NOT_VERIFIED handling consistency (2026-07 quality plan T2)', () => {
  const dagText = readFileSync(
    resolve(__dirname, '../../../../../skills/tasks/loop-dag.md'),
    'utf8',
  );

  it('§6c no longer maps a verifier-emitted NOT_VERIFIED to status=blocked', () => {
    expect(dagText).not.toMatch(/\*\*NOT_VERIFIED\*\* \| `update_task → status=blocked`/);
  });

  it('§6c distinguishes verifier-emitted from dispatch-failure NOT_VERIFIED', () => {
    expect(dagText).toMatch(/NOT_VERIFIED \(verifier-emitted\)/);
    expect(dagText).toMatch(/NOT_VERIFIED \(dispatch failure/);
  });

  it('§3f mandates build+test on the integrated tree per wave (2026-07 quality plan T11)', () => {
    expect(dagText).toMatch(/Post-integration validation \(MANDATORY, per wave\)/);
    expect(dagText).toMatch(/INTEGRATED tree/);
  });
});
