# /tasks:* Skill Pipeline Quality Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the output quality of the planning → decomposition → execution → validation → integration pipeline (`/tasks:decompose`, `/tasks:loop`, `/tasks:loop-dag`, `/tasks:audit`, `tasks-verifier`, `integration-auditor`) so any model running any role produces more accurate, verifiable, consistent results.

**Architecture:** The skills are markdown contracts pinned by vitest "design gate" tests under `src/api/routes/tasks/__tests__/`. Every change here is therefore TDD-able: extend the design test to pin the new/changed contract text (RED), edit the skill prose (GREEN), commit. Two changes also touch code (`src/lib/decompose/schema.ts`, `src/lib/audit/schema.ts`, one new validation helper + CLI script).

**Tech Stack:** Markdown skills, TypeScript + zod schemas, vitest, Node ≥ 22 ESM, biome.

## Evaluation findings this plan implements (context for the implementer)

Read this before starting — it is the "why" behind each task.

**Confirmed defects (P0):**

1. **NOT_VERIFIED contradiction.** `loop.md` §7d: verifier-emitted NOT_VERIFIED → task **stays `in_progress`** ("treat as PARTIAL"). `loop-dag.md` §6c verdict table: `NOT_VERIFIED | update_task → status=blocked | ... | Same as FAIL.` — while `loop-dag.md` §3d says "same handling as loop.md §7d NOT_VERIFIED branch". A model following §6c blocks tasks that §3d/§7d say should stay in_progress. (The §3c *dispatch-failure* path → `blocked` is intentional and different; the table conflates the two.)
2. **VerifierInputs envelope drift.** `loop-shared.md` §B defines 6 fields including `base_sha` and mandates the verifier's FIRST check assert the base — but `skills/agents/tasks-verifier.md` documents only 5 input fields, never mentions `base_sha`, and has no base-assertion step. `audit.md` Step 3 also shows the 5-field envelope with no note on why `base_sha` is absent. The read-side backstop for the loop-dag stale-worktree hazard is therefore not actually in the verifier's own instructions.
3. **Mislabeled cross-references.** `loop.md:326` and `loop.md:698` cite "`loop-shared.md` §A" while linking the `#l-anti-fabrication--evidence-integrity-canon` anchor (§L). A model told "read §A" lands on the worker-brief template.
4. **Verifier self-contradiction on running tests.** `tasks-verifier.md` Bounds: "Don't run `npm test` unless a criterion specifically references a test" — yet Failure modes requires catching "Collateral damage — criteria satisfied, but `npm test` exits non-zero on unrelated tests." As written, the collateral-damage check is unreachable in the common case. Root fix: the orchestrator already independently re-ran build/test/lint in Step 5; those results should flow to the verifier via `additional_observations` as citable evidence.

**Quality gaps (P1):**

5. **Verifier schema-emission friction is treated downstream, not at the source.** §G documents five recurring parse-failure patterns with a 2-round-trip SendMessage repair protocol. A self-validation CLI the verifier runs on its own JSON *before* emitting eliminates most failures for any model.
6. **Workers don't map ACs to evidence.** The §A brief's "Reporting back" has baseline/post-edit test blocks but no per-AC evidence map, so the verifier re-derives everything and the orchestrator can't catch missed criteria before the verifier round-trip.
7. **Decompose materializes tasks that downstream gates reject.** `loop-dag.md` §2g refuses hand-replay/uncheckable-AC tasks at *execution* time; decompose has no equivalent gate at *planning* time. Also, candidates carry no `target_files`, so file-collision risk (the direct cause of integration-audit RISKY/BROKEN verdicts) is invisible at planning time, and citations to files/symbols are only fact-checked when `--spec` is passed.
8. **The decompose → loop handoff drops artifacts.** DECOMPOSITION.md (recon summary, per-candidate rationale, coverage matrix) is never consumed by `/tasks:loop[-dag]` — §2a re-discovers everything from scratch and worker briefs lose the planner's context.
9. **loop-dag has no post-integration validation on the integrated tree.** Workers validate inside their worktrees; PASS patches are applied to the integration tree, but no wave-level build+test runs on the *integrated* result unless CLI/docs/skills globs happen to match (§P). Known real-world failure: biome ignores `.claude/**`, so lint/format ran on 0 files inside worktrees.
10. **Audit degrades to zero value at the cost cap.** A 20-task run (> 5 USD estimate) dispatches **zero** verifiers instead of grading as many as the budget allows. And AUDIT.md never compares the audit verdict to the original loop verdict — verdict drift is the single most interesting audit signal.
11. **Model-agnostic step tracking.** The orchestrator skills are 400–900-line prose contracts; weaker models silently skip steps. A compact execution-ledger checklist mirrored into the harness todo list makes skipped steps visible regardless of model.

## Global Constraints

- **Baseline first:** `npm run build && npm test` MUST be green on the unchanged tree before Task 1. Any pre-existing failure is a separate housekeeping commit first (repo zero-tolerance policy: never proceed on red).
- **`loop.md` hard line cap: ≤ 700 lines** — enforced by `src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts`. `loop.md` is currently **698 lines**. Task 12 (the trim) runs FIRST among loop.md-touching tasks to create headroom. After every `loop.md` edit run `wc -l skills/tasks/loop.md` and the extraction test.
- **Design docs win over skills.** `decompose.md` defers to `docs/tasks-decompose-design.md`; `audit.md` defers to `docs/tasks-audit-design.md`. Any contract change in those skills MUST update the corresponding design doc **in the same commit**.
- **Design-gate tests pin skill prose.** `skill-decompose-design.test.ts` (56 its), `skill-audit-design.test.ts`, `loop-dag-skill-design.test.ts` (19), `loop-skill-verifier-wiring.test.ts` (11), `verifier-status-enum-hardening.test.ts` (11), `loop-shared-extraction.test.ts` (20), `loop-terminal-gate.test.ts`, `loop-skill-preflight-gate.test.ts`, `integration-auditor-agent-def.test.ts`. Before editing any skill file, `grep -l "<phrase you are changing>" src/api/routes/tasks/__tests__/*.ts` and update pinned assertions in the same commit. Never delete an assertion without replacing it with one pinning the corrected contract.
- **Never weaken a guardrail.** No change may relax Guardrails 1–4 (decompose), Guardrails 1–4 (audit), generator/critic separation, anti-fabrication §L, or the no-upgrade rule.
- **Lint:** `npm run lint` green after every task (biome).
- **Commits:** one commit per task, exact `git add` of named files only, subject < 70 chars.
- **Gitignored artifacts:** never commit `.planning/**`, `data/`, `*.db`.

---

### Task 1: Trim `loop.md` to create line-cap headroom

Do this first: later tasks add ~4 lines to `loop.md`; it sits at 698/700.

**Files:**
- Modify: `skills/tasks/loop.md` (Step 4, lines ~283–285)

- [ ] **Step 1: Confirm no test pins the paragraphs being compressed**

Run: `grep -rn "third-party\|stack-specialist\|vendor-neutral" src/api/routes/tasks/__tests__/ docs/loop-run-schema.md`
Expected: no matches in test files (if a test matches, pick a different trim target inside Step 4's prose and update this task's Step 2 accordingly — the invariant is only "net ≥ 6 lines removed from loop.md without touching any pinned phrase").

- [ ] **Step 2: Replace the two Step-4 vendor paragraphs with one sentence**

In `skills/tasks/loop.md`, replace this text (currently two paragraphs, lines ~283–285):

```
Use the `Agent` tool with the Claude Code platform's default `general-purpose` subagent type. This skill deliberately does NOT pin the orchestrator to any third-party agent plugin — briefs are the load-bearing part, not the agent type, and depending on an external plugin would couple the skill's behaviour to a tool that may not be installed on every host. For read-only investigation steps where no edits are needed, the platform's `Explore` subagent type is the right choice.

If the user has installed third-party stack-specialist agents (e.g. a .NET-focused plugin) and wants the orchestrator to prefer them on matching stacks, the user should configure that routing themselves — the skill stays vendor-neutral by default.
```

with:

```
Use the `Agent` tool with the platform's default `general-purpose` subagent type (briefs are the load-bearing part, not the agent type; `Explore` for read-only investigation). The skill stays vendor-neutral — users who prefer third-party stack-specialist agents configure that routing themselves.
```

- [ ] **Step 3: Verify cap + suite**

Run: `wc -l skills/tasks/loop.md` → Expected: ≤ 694.
Run: `npx vitest run src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts` → Expected: PASS (20 tests).
Run: `npm test` → Expected: green.

- [ ] **Step 4: Commit**

```bash
git add skills/tasks/loop.md
git commit -m "refactor(skills): compress loop.md Step 4 vendor prose for line-cap headroom"
```

---

### Task 2: Reconcile NOT_VERIFIED handling between loop.md and loop-dag.md

**Files:**
- Modify: `skills/tasks/loop-dag.md` (§6c verdict table, lines ~390–395)
- Test: `src/api/routes/tasks/__tests__/loop-dag-skill-design.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `loop-dag-skill-design.test.ts` (reuse the file's existing path constant for loop-dag.md if present; otherwise define locally):

```ts
describe('NOT_VERIFIED handling consistency (2026-07 quality plan T2)', () => {
  const dagText = readFileSync(
    resolve(__dirname, '../../../../../skills/tasks/loop-dag.md'),
    'utf8',
  );

  it('§6c no longer maps a verifier-emitted NOT_VERIFIED to status=blocked', () => {
    expect(dagText).not.toMatch(
      /\*\*NOT_VERIFIED\*\* \| `update_task → status=blocked`/,
    );
  });

  it('§6c distinguishes verifier-emitted from dispatch-failure NOT_VERIFIED', () => {
    expect(dagText).toMatch(/NOT_VERIFIED \(verifier-emitted\)/);
    expect(dagText).toMatch(/NOT_VERIFIED \(dispatch failure/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api/routes/tasks/__tests__/loop-dag-skill-design.test.ts -t "NOT_VERIFIED"`
Expected: FAIL — the current table row `| **NOT_VERIFIED** | update_task → status=blocked ... | Same as FAIL. |` matches the forbidden pattern.

- [ ] **Step 3: Fix the §6c table**

In `skills/tasks/loop-dag.md` §6c, replace the row:

```
| **NOT_VERIFIED** | `update_task → status=blocked`, write synthesized evidence | none | Same as FAIL. |
```

with:

```
| **NOT_VERIFIED (verifier-emitted)** | `update_task` (status stays `in_progress`), write evidence + comment | none | Downstream stays open. Same as `loop.md` §7d — backfill ACs and re-queue. |
| **NOT_VERIFIED (dispatch failure — §3c crash/timeout/parse-fail)** | `update_task → status=blocked`, write synthesized evidence | none | Same as FAIL for THIS run. |
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run src/api/routes/tasks/__tests__/loop-dag-skill-design.test.ts`
Expected: PASS (21 tests).

- [ ] **Step 5: Commit**

```bash
git add skills/tasks/loop-dag.md src/api/routes/tasks/__tests__/loop-dag-skill-design.test.ts
git commit -m "fix(skills): split loop-dag §6c NOT_VERIFIED row — verifier vs dispatch-failure"
```

---

### Task 3: Propagate `base_sha` into the verifier agent + audit envelope note

**Files:**
- Modify: `skills/agents/tasks-verifier.md` (Inputs block, Workflow, Bash allowlist)
- Modify: `skills/tasks/audit.md` (Step 3 envelope block)
- Test: `src/api/routes/tasks/__tests__/loop-skill-verifier-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `loop-skill-verifier-wiring.test.ts`:

```ts
describe('base_sha envelope propagation (2026-07 quality plan T3)', () => {
  const verifierText = readFileSync(
    resolve(__dirname, '../../../../../skills/agents/tasks-verifier.md'),
    'utf8',
  );
  const auditText = readFileSync(
    resolve(__dirname, '../../../../../skills/tasks/audit.md'),
    'utf8',
  );

  it('tasks-verifier.md documents base_sha in its Inputs', () => {
    expect(verifierText).toMatch(/"base_sha"/);
  });

  it('tasks-verifier.md mandates the base-integrity first check', () => {
    expect(verifierText).toMatch(/git merge-base --is-ancestor/);
    expect(verifierText).toMatch(/NOT_VERIFIED.*base mismatch|base mismatch.*NOT_VERIFIED/is);
  });

  it('audit.md documents why base_sha is omitted retrospectively', () => {
    expect(auditText).toMatch(/base_sha.*omitted/is);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/api/routes/tasks/__tests__/loop-skill-verifier-wiring.test.ts -t "base_sha"`
Expected: FAIL (3 tests).

- [ ] **Step 3: Update `tasks-verifier.md`**

(a) In the Inputs JSON block, after `"file_changes": ["path/to/file", "..."]` add:

```json
  "base_sha": "<expected integration-branch tip SHA — optional; present for worktree-isolated workers>",
  "additional_observations": ["<orchestrator-observed evidence — optional>", "..."]
```

(`additional_observations` is documented fully in Task 4; adding the field here avoids editing this block twice.)

(b) In `## Workflow`, insert a new step 0 before "Parse acceptance_criteria":

```
0. **Base-integrity check (when `base_sha` is present).** Run
   `git rev-parse HEAD`; if it does not equal `base_sha`, run
   `git merge-base --is-ancestor <base_sha> HEAD`. If HEAD is neither equal
   to nor a descendant of `base_sha`, STOP and emit
   `{"verdict": "NOT_VERIFIED", "checks": [{"name": "base integrity",
   "status": "SKIP", "evidence_url_or_text": "UNCHECKABLE: base mismatch —
   HEAD <sha> is not a descendant of base_sha <sha>"}]}`. A tree cut from a
   stale base invalidates every downstream check (loop-shared.md §B).
```

(c) In "Bash commands you MAY run", add the line:

```
- `git rev-parse`, `git merge-base --is-ancestor` (read-only)
```

- [ ] **Step 4: Update `audit.md` Step 3**

After the `VerifierInputs` TS block in Step 3, add:

```
`base_sha` and `additional_observations` are deliberately **omitted** from the
audit envelope: audit grades an already-integrated historical tree, so there
is no expected worktree base to assert, and the original run's orchestrator
observations are not reproducible inputs — the audit is a pure function of
(LOOP-RUN.md, tasks-database, current tree).
```

- [ ] **Step 5: Verify green + commit**

Run: `npx vitest run src/api/routes/tasks/__tests__/loop-skill-verifier-wiring.test.ts` → PASS.
Run: `npm test` → green.

```bash
git add skills/agents/tasks-verifier.md skills/tasks/audit.md src/api/routes/tasks/__tests__/loop-skill-verifier-wiring.test.ts
git commit -m "fix(skills): document base_sha check in tasks-verifier; note audit omission"
```

---

### Task 4: Fix verifier test-running contradiction via always-on `additional_observations`

**Files:**
- Modify: `skills/tasks/loop-shared.md` (§B — envelope interface + new paragraph)
- Modify: `skills/agents/tasks-verifier.md` (Bounds + Failure modes)
- Test: `src/api/routes/tasks/__tests__/loop-skill-verifier-wiring.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `loop-skill-verifier-wiring.test.ts`:

```ts
describe('additional_observations always-on (2026-07 quality plan T4)', () => {
  const sharedText = readFileSync(
    resolve(__dirname, '../../../../../skills/tasks/loop-shared.md'),
    'utf8',
  );
  const verifierText = readFileSync(
    resolve(__dirname, '../../../../../skills/agents/tasks-verifier.md'),
    'utf8',
  );

  it('§B envelope interface declares additional_observations', () => {
    expect(sharedText).toMatch(/additional_observations: <string\[\]>/);
  });

  it('§B requires orchestrator Step-5 validation results in observations', () => {
    expect(sharedText).toMatch(/Step-5 validation results/);
  });

  it('verifier cites orchestrator observations for the regression check', () => {
    expect(verifierText).toMatch(/orchestrator-run validation results/i);
  });
});
```

Run: `npx vitest run src/api/routes/tasks/__tests__/loop-skill-verifier-wiring.test.ts -t "additional_observations"` → Expected: FAIL.

- [ ] **Step 2: Extend §B in `loop-shared.md`**

(a) In the `verifierInputs` TS block, after `base_sha: <string>,` add:

```ts
  additional_observations: <string[]>,  // ALWAYS present — see below; [] only if Step 5 was skipped
```

(b) After the "Base-integrity assertion" paragraph, insert:

```
**Always populate `additional_observations` with the orchestrator's Step-5
validation results.** One entry per independently re-run command, quoted from
tool results that already returned (§L): e.g.
`"orchestrator Step 5: npm run build → exit 0"`,
`"orchestrator Step 5: npm test → exit 0, 2493 passed / 0 failed (flake filter: <flags>)"`.
The verifier may CITE these as evidence for its synthetic
"No regressions in pre-existing tests" check instead of re-running the full
suite inside its own 30-call budget. Scope-narrowing SCOPE: entries (below)
are appended to the same array. Do not put anything in this array you did not
observe from a returned tool result.
```

- [ ] **Step 3: Fix the contradiction in `tasks-verifier.md`**

(a) In `## Bounds (hard stop)`, replace the sentence:

```
Don't run `npm test` unless a criterion specifically references a test.
```

with:

```
Don't run `npm test` yourself when `additional_observations` already carries
the orchestrator's test re-run result — cite that entry instead. Run the
suite yourself ONLY when a criterion specifically references a test AND no
orchestrator-run validation results were supplied.
```

(b) In `## Failure modes you MUST catch`, replace the "Collateral damage" bullet with:

```
- **Collateral damage** — criteria satisfied, but the test suite regressed.
  Add a synthetic check `"No regressions in pre-existing tests"`: cite the
  orchestrator-run validation results from `additional_observations` when
  present (PASS on exit 0 / matching pass counts; FAIL quoting the failing
  entry); fall back to running the suite yourself only per the Bounds rule.
```

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run src/api/routes/tasks/__tests__/loop-skill-verifier-wiring.test.ts` → PASS.
Run: `npx vitest run src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts` → PASS.

```bash
git add skills/tasks/loop-shared.md skills/agents/tasks-verifier.md src/api/routes/tasks/__tests__/loop-skill-verifier-wiring.test.ts
git commit -m "fix(skills): always-on additional_observations; resolve verifier test-run contradiction"
```

---

### Task 5: Fix the §A/§L mislabeled cross-references in loop.md

**Files:**
- Modify: `skills/tasks/loop.md` (2 sites)
- Test: `src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `loop-shared-extraction.test.ts`:

```ts
it('loop.md never labels the §L anchor as §A (2026-07 quality plan T5)', () => {
  const text = readFileSync(LOOP_PATH, 'utf8');
  expect(text).not.toMatch(/§A\]\(\.?\/?loop-shared\.md#l-anti-fabrication/);
});
```

Run: `npx vitest run src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts -t "never labels"` → Expected: FAIL.

- [ ] **Step 2: Fix both sites**

In `skills/tasks/loop.md`, change both occurrences (Step 6, line ~326; Important Rules, line ~698) of:

```
[`loop-shared.md` §A](./loop-shared.md#l-anti-fabrication--evidence-integrity-canon)
```

to:

```
[`loop-shared.md` §L](./loop-shared.md#l-anti-fabrication--evidence-integrity-canon)
```

Also run `grep -n "§A](./loop-shared.md#l-" skills/tasks/*.md skills/agents/*.md` and fix any other occurrence the same way.

- [ ] **Step 3: Verify + commit**

Run: `npx vitest run src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts` → PASS. `wc -l skills/tasks/loop.md` → unchanged.

```bash
git add skills/tasks/loop.md src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts
git commit -m "fix(skills): correct mislabeled §A→§L anti-fabrication references in loop.md"
```

---

### Task 6: Verifier self-validation CLI (`validate-evidence`)

Attacks the §G parse-failure patterns at the source: the verifier validates its own JSON against the real zod schema before emitting.

**Files:**
- Create: `src/lib/loop-run/validate-evidence.ts`
- Create: `src/lib/loop-run/__tests__/validate-evidence.test.ts`
- Create: `scripts/validate-evidence.ts`
- Modify: `package.json` (one script entry)
- Modify: `skills/agents/tasks-verifier.md` (allowlist + workflow)
- Modify: `skills/tasks/loop-shared.md` (§G note)

- [ ] **Step 1: Write the failing unit test**

Create `src/lib/loop-run/__tests__/validate-evidence.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { validateEvidence } from '../validate-evidence.js';

describe('validateEvidence', () => {
  it('accepts a minimal valid envelope', () => {
    const r = validateEvidence(
      JSON.stringify({
        verdict: 'PARTIAL',
        checks: [
          {
            name: 'live DB smoke',
            status: 'SKIP',
            evidence_url_or_text: 'UNCHECKABLE: read-only verifier',
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects PARTIAL at the check level with a targeted message', () => {
    const r = validateEvidence(
      JSON.stringify({
        verdict: 'PASS',
        checks: [
          { name: 'x', status: 'PARTIAL', evidence_url_or_text: 'y' },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/checks\.0\.status/);
  });

  it('rejects the wrong per-check field name (criterion)', () => {
    const r = validateEvidence(
      JSON.stringify({
        verdict: 'PASS',
        checks: [{ criterion: 'x', status: 'PASS', evidence_url_or_text: 'y' }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects non-JSON input without throwing', () => {
    const r = validateEvidence('```json\n{"verdict":"PASS"}\n```');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/not parseable as JSON/i);
  });
});
```

Run: `npx vitest run src/lib/loop-run/__tests__/validate-evidence.test.ts` → Expected: FAIL (module not found).

- [ ] **Step 2: Implement the helper**

Create `src/lib/loop-run/validate-evidence.ts`:

```ts
import { VerificationEvidenceSchema } from '../../schemas/task.schema.js';

export interface EvidenceValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateEvidence(raw: string): EvidenceValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [
        `input is not parseable as JSON (${(err as Error).message}); emit ONLY the bare JSON object — no fence, no preamble, no trailing prose`,
      ],
    };
  }
  const result = VerificationEvidenceSchema.safeParse(parsed);
  if (result.success) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    ),
  };
}
```

If the schema's export name differs, check `src/schemas/task.schema.ts` and use the exact exported identifier — do not create a duplicate schema.

- [ ] **Step 3: Verify unit tests pass**

Run: `npx vitest run src/lib/loop-run/__tests__/validate-evidence.test.ts` → Expected: PASS (4 tests). If the third test fails because the schema is not `.strict()` at the check level, replace that assertion with `expect(r.errors.join('\n')).toMatch(/name/);` (missing required `name`) — the intent is "wrong field name is rejected", whichever zod issue shape surfaces it.

- [ ] **Step 4: Add the CLI wrapper + npm script**

Create `scripts/validate-evidence.ts`:

```ts
import { validateEvidence } from '../src/lib/loop-run/validate-evidence.js';

const chunks: Buffer[] = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const result = validateEvidence(Buffer.concat(chunks).toString('utf8'));
  if (result.ok) {
    console.log('OK: parses as VerificationEvidence');
    process.exit(0);
  }
  console.error('INVALID VerificationEvidence:');
  for (const e of result.errors) console.error(`- ${e}`);
  process.exit(1);
});
```

In `package.json` `scripts`, add (match the invocation style of existing `scripts/*` entries — check how e.g. the migrate script runs TS; if the repo runs TS via `tsx`, use `tsx scripts/validate-evidence.ts`; if scripts run from `dist/`, add the file to the build and point at `dist/scripts/validate-evidence.js`):

```json
"validate:evidence": "tsx scripts/validate-evidence.ts"
```

Verify: `echo '{"verdict":"PASS","checks":[]}' | npm run -s validate:evidence` → `OK: parses as VerificationEvidence`, exit 0.
Verify: `echo 'not json' | npm run -s validate:evidence` → INVALID output, exit 1.

- [ ] **Step 5: Wire into the verifier agent**

In `skills/agents/tasks-verifier.md`:

(a) Add to "Bash commands you MAY run":

```
- `npm run -s validate:evidence` — self-validate your OWN output JSON via stdin before emitting (read-only; validates against `VerificationEvidenceSchema`).
```

(b) In `## Workflow`, replace step 5 ("Emit the JSON output...") with:

```
5. **Self-validate, then emit.** Pipe your candidate JSON through
   `npm run -s validate:evidence` (heredoc stdin). On `OK`, emit that exact
   JSON as your final message — no fence, no preamble, no trailing prose. On
   `INVALID`, fix the listed issues and re-validate (at most twice) before
   emitting. If the validator script is unavailable in this repo
   (`missing script`), fall back to the self-check rules above and emit.
```

(c) In `skills/tasks/loop-shared.md` §G, after the intro paragraph add one line:

```
(With the verifier's `npm run -s validate:evidence` self-check in place these
patterns should be rare; the repair protocol below remains the backstop.)
```

- [ ] **Step 6: Full gate + commit**

Run: `npm run build && npm test && npm run lint` → green.

```bash
git add src/lib/loop-run/validate-evidence.ts src/lib/loop-run/__tests__/validate-evidence.test.ts scripts/validate-evidence.ts package.json skills/agents/tasks-verifier.md skills/tasks/loop-shared.md
git commit -m "feat(verifier): self-validation CLI for VerificationEvidence emission"
```

---

### Task 7: Per-AC evidence map in the worker brief

**Files:**
- Modify: `skills/tasks/loop-shared.md` (§A "Reporting back")
- Modify: `skills/tasks/loop.md` (Step 5 item 1 — one sentence)
- Test: `src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `loop-shared-extraction.test.ts`:

```ts
it('§A Reporting back requires a Per-AC evidence map (2026-07 quality plan T7)', () => {
  const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
  expect(text).toMatch(/\*\*Per-AC evidence map\*\*/);
});

it('loop.md Step 5 rejects reports missing the Per-AC evidence map', () => {
  const text = readFileSync(LOOP_PATH, 'utf8');
  expect(text).toMatch(/Per-AC evidence map/);
});
```

Run: `npx vitest run src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts -t "Per-AC"` → Expected: FAIL.

- [ ] **Step 2: Add the block to §A**

In `loop-shared.md` §A, inside the brief template's "## Reporting back" section, after the **Post-edit** block and before "Then the standard fields:", insert:

```
**Per-AC evidence map** — one line per acceptance criterion, in the order the
brief listed them. Each line names the criterion (first ~8 words) and points
at concrete evidence a read-only verifier can re-check:

- AC1 "<first words of criterion>…" → `path/file.ts:123` | `<command> → exit 0, <headline>` | `git <ref>` | NOT MET: <reason> | BLOCKED: <reason>

Every AC MUST appear exactly once. "NOT MET" / "BLOCKED" lines are honest and
expected when applicable — never omit an AC to hide a gap.
```

- [ ] **Step 3: Enforce at Step 5**

In `skills/tasks/loop.md` Step 5, at the end of item 1 (the `git status` check), append the sentence:

```
Also confirm the report contains the §A **Per-AC evidence map** with every AC present; a report missing it (or missing an AC line) is a brief deviation — re-brief per item #5 before any validation runs.
```

- [ ] **Step 4: Verify cap + tests + commit**

Run: `wc -l skills/tasks/loop.md` → ≤ 700. `npx vitest run src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts` → PASS.

```bash
git add skills/tasks/loop-shared.md skills/tasks/loop.md src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts
git commit -m "feat(skills): require per-AC evidence map in worker reports"
```

---

### Task 8: Decompose — `target_files`, AC checkability lint, feasibility gate upstream

**Files:**
- Modify: `src/lib/decompose/schema.ts` (`CandidateTaskSchema`)
- Modify: `src/lib/decompose/__tests__/schema.test.ts`
- Modify: `skills/tasks/decompose.md` (Step 3 planner brief + new Step 3b)
- Modify: `docs/tasks-decompose-design.md` (§3 Step 3 — mirror the contract)
- Test: `src/api/routes/tasks/__tests__/skill-decompose-design.test.ts`

- [ ] **Step 1: Write the failing schema test**

Append to `src/lib/decompose/__tests__/schema.test.ts` (mirror its existing fixture style — read the file first and reuse its valid-candidate fixture, adding fields):

```ts
it('accepts optional target_files (≤ 8 repo-relative paths)', () => {
  const candidate = { ...validCandidate, target_files: ['src/a.ts', 'docs/b.md (new)'] };
  expect(CandidateTaskSchema.safeParse(candidate).success).toBe(true);
});

it('rejects more than 8 target_files', () => {
  const candidate = {
    ...validCandidate,
    target_files: Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`),
  };
  expect(CandidateTaskSchema.safeParse(candidate).success).toBe(false);
});
```

Run: `npx vitest run src/lib/decompose/__tests__/schema.test.ts` → Expected: FAIL.

- [ ] **Step 2: Extend the schema**

In `src/lib/decompose/schema.ts`, add to `CandidateTaskSchema`:

```ts
  /** Repo-relative paths the task is expected to touch; suffix " (new)" for files to be created. Hints for overlap prediction (Step 4b) — not enforced downstream. */
  target_files: z.array(z.string().min(1).max(300)).max(8).optional(),
```

Run the schema tests → PASS. Run `npm run build` → green.

- [ ] **Step 3: Write the failing design-gate test**

Append to `skill-decompose-design.test.ts` (reuse its existing skill-text read helper):

```ts
describe('Step 3 planner grounding + Step 3b AC lint (2026-07 quality plan T8)', () => {
  it('planner brief requires target_files drawn from recon', () => {
    expect(skillText).toMatch(/`target_files`/);
    expect(skillText).toMatch(/present in the recon summary/i);
  });

  it('Step 3b AC checkability lint exists with the evidence classes', () => {
    expect(skillText).toMatch(/## Step 3b — AC checkability lint/);
    expect(skillText).toMatch(/file:line/);
    expect(skillText).toMatch(/hand-replay/);
  });
});
```

Run → Expected: FAIL.

- [ ] **Step 4: Edit `decompose.md`**

(a) In the Step 3 inline planner brief, after the `estimated_minutes` bullet add:

```
> - `target_files` — 1–8 repo-relative paths this task is expected to touch,
>   drawn ONLY from paths present in the recon summary; suffix ` (new)` for
>   files the task creates. Omit only if the task is purely investigative.
```

(b) After Step 3 (before Step 4), insert:

```
## Step 3b — AC checkability lint (orchestrator, no dispatch)

Before the Step-4 independence check, lint every candidate's
`acceptance_criteria` for **worker-checkability**: each AC must be satisfiable
as one of the read-only verifier's evidence classes — a `file:line` existence
or content assertion, an allowlisted command + exit code / headline number, or
a git-history assertion. Two rejection classes:

1. **Human-in-the-loop phrasing** — any AC or description containing the
   `loop-dag.md` §2g indicator phrases (`hand-replay`, `manually inspect`,
   `observe the orchestrator`, `by observing`, `live cross-context`,
   `hand-driven verification`) or equivalent intent.
2. **Unfalsifiable phrasing** — ACs with no observable referent ("works
   correctly", "is robust", "handles errors well") and no named file, command,
   or test.

For each violation, re-prompt the planner ONCE (SendMessage to
`decompose-planner`) to rewrite the offending AC into a checkable form. If a
rewrite is impossible (the criterion genuinely needs a human), DROP the
candidate and record it in the artifact body §5 with marker `(dropped:
unworkable AC)` so the user can hand-author it. This is the §2g feasibility
gate moved upstream — `loop-dag.md` §2g remains the execution-time backstop.

Also verify each candidate's `target_files` entries (minus ` (new)` suffixes)
appear in the recon summary; strip any path that does not and note the strip
in the artifact body §5.
```

(c) Update `docs/tasks-decompose-design.md` §3 Step 3 to mirror (a)+(b) — same field, same lint rules, same bounded re-prompt. The design doc is the source of truth; the skill and doc MUST agree in this commit.

- [ ] **Step 5: Verify + commit**

Run: `npx vitest run src/api/routes/tasks/__tests__/skill-decompose-design.test.ts src/api/routes/tasks/__tests__/skill-decompose-fixtures.test.ts src/lib/decompose/__tests__/schema.test.ts` → PASS. `npm test` → green.

```bash
git add src/lib/decompose/schema.ts src/lib/decompose/__tests__/schema.test.ts skills/tasks/decompose.md docs/tasks-decompose-design.md src/api/routes/tasks/__tests__/skill-decompose-design.test.ts
git commit -m "feat(decompose): target_files grounding + Step 3b AC checkability lint"
```

---

### Task 9: Decompose — Step 4b predicted file-overlap check

**Files:**
- Modify: `skills/tasks/decompose.md` (new Step 4b after Guardrail 3)
- Modify: `docs/tasks-decompose-design.md` (§3 Step 4 — mirror)
- Test: `src/api/routes/tasks/__tests__/skill-decompose-design.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('Step 4b predicted file-overlap check exists (2026-07 quality plan T9)', () => {
  expect(skillText).toMatch(/## Step 4b — Predicted file-overlap check/);
  expect(skillText).toMatch(/target_files/);
  expect(skillText).toMatch(/ORDERED/);
});
```

Run → FAIL.

- [ ] **Step 2: Insert Step 4b into `decompose.md`** (after the Guardrail 3 block, before Step 5)

```
## Step 4b — Predicted file-overlap check (orchestrator, no dispatch)

File collisions between parallel workers are the direct cause of downstream
RISKY/BROKEN integration-audit verdicts. Before the topology decision,
compute the pairwise intersection of the candidates' `target_files` (ignore
` (new)`-suffixed entries with distinct paths; a SHARED new path counts).
For every pair with a non-empty intersection whose Step-4 verdict was
`INDEPENDENT`:

- If the shared file is a **registry-shaped** file (a registrar, barrel
  export, docs/count table — a file whose edits are additive lines), add an
  `ORDERED` edge in either direction (pick the lower `draft_id` first) so the
  executors serialize the touch instead of parallelizing a merge conflict.
- Otherwise, ask the Step-4 independence critic ONE targeted follow-up
  (SendMessage to `decompose-critic-independence`): "drafts <a> and <b> both
  declare `<path>` in target_files — re-verdict this pair given the shared
  file." Apply the returned verdict (`ORDERED` edge, or merge on
  `MUTUALLY_EXCLUSIVE`).

Edges added here feed Step 5's `topology_check` exactly like Step-4 edges and
are recorded in the artifact body §6 with reason `predicted file overlap:
<path>`. This check adds NO new subagent dispatches beyond the bounded
critic follow-up.
```

- [ ] **Step 3: Mirror in `docs/tasks-decompose-design.md`** (§3, alongside Step 4; add "predicted file overlap" to the §6 Dependency Edges reason vocabulary).

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run src/api/routes/tasks/__tests__/skill-decompose-design.test.ts` → PASS. `npm test` → green.

```bash
git add skills/tasks/decompose.md docs/tasks-decompose-design.md src/api/routes/tasks/__tests__/skill-decompose-design.test.ts
git commit -m "feat(decompose): Step 4b predicted file-overlap check feeds topology edges"
```

---

### Task 10: Consume DECOMPOSITION.md in the executors (handoff §T)

**Files:**
- Modify: `skills/tasks/loop-shared.md` (new §T at end of file)
- Modify: `skills/tasks/loop.md` (§2a — one pointer line)
- Modify: `skills/tasks/loop-dag.md` (§2 — one pointer line)
- Test: `src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('loop-shared.md contains §T decomposition artifact reuse (2026-07 quality plan T10)', () => {
  const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
  expect(text).toMatch(/^##\s+§T\.\s+Decomposition artifact reuse/m);
});

it('both executors point at §T', () => {
  expect(readFileSync(LOOP_PATH, 'utf8')).toMatch(/§T/);
  expect(readFileSync(LOOP_DAG_PATH, 'utf8')).toMatch(/§T/);
});
```

(`LOOP_DAG_PATH` exists in this test file; if not, define it beside `LOOP_PATH`.)
Run → FAIL.

- [ ] **Step 2: Add §T to `loop-shared.md`** (append at end of file)

```
## §T. Decomposition artifact reuse (executor-side handoff)

**Called from:** `loop.md` §2a, `loop-dag.md` §2.

If any open task in the target project carries a `decomp-<uuid>` tag, a
`/tasks:decompose` run produced this backlog and its artifact almost
certainly still exists locally. Before doing §2a discovery from scratch:

1. Extract the decomposition id from the tag; glob
   `.planning/decompositions/*-<project_id>.md` and pick the file whose
   frontmatter `decomposition_id` matches (skip silently if none — the
   artifact is per-machine and may be absent).
2. Reuse `## Recon Summary` as the seed for §2a's repo understanding — verify
   it is still current (spot-check 2–3 cited paths still exist) rather than
   re-deriving from zero.
3. When briefing a worker for task `<id>`, locate the matching
   `## Candidates` block (via the artifact's `(draft_id → task_id)` mapping)
   and carry its `description` rationale + `target_files` into the brief's
   "Relevant domain context" and "Required deliverables" sections. The
   planner's context is strictly better than a from-scratch re-derivation.
4. The `## Dependency Edges` reasons (including `predicted file overlap:
   <path>`) tell the loop-dag orchestrator WHICH files motivated
   serialization — quote the reason in both affected workers' briefs as a
   hard constraint ("`<path>` is shared with task #<other>; keep your edit
   additive/minimal there").

The artifact is advisory input — the tasks database remains the source of
truth for status, ACs, and edges. Never treat a stale artifact as overriding
live task state.
```

- [ ] **Step 3: Add the pointer lines**

`loop.md` §2a — after the first paragraph of "### 2a. Read the project's domain spec doc(s)", add one line:

```
**Decomposition handoff:** if open tasks carry a `decomp-<uuid>` tag, first apply [loop-shared.md §T](loop-shared.md#t-decomposition-artifact-reuse-executor-side-handoff) to reuse the decompose run's recon + per-candidate context.
```

`loop-dag.md` §2 — after "Reuse `loop.md` §2a–§2e verbatim…", add:

```
Additionally apply [loop-shared.md §T](loop-shared.md#t-decomposition-artifact-reuse-executor-side-handoff) when open tasks carry a `decomp-<uuid>` tag — the decompose artifact's edge reasons (`predicted file overlap: <path>`) feed §3b worker-brief hard constraints.
```

- [ ] **Step 4: Verify cap + tests + commit**

Run: `wc -l skills/tasks/loop.md` → ≤ 700. `npx vitest run src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts` → PASS. `npm test` → green.

```bash
git add skills/tasks/loop-shared.md skills/tasks/loop.md skills/tasks/loop-dag.md src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts
git commit -m "feat(skills): §T decomposition artifact reuse in both executors"
```

---

### Task 11: loop-dag per-wave post-integration validation gate

**Files:**
- Modify: `skills/tasks/loop-dag.md` (§3f)
- Test: `src/api/routes/tasks/__tests__/loop-dag-skill-design.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('§3f mandates build+test on the integrated tree per wave (2026-07 quality plan T11)', () => {
  const text = readFileSync(LOOP_DAG_PATH, 'utf8');
  expect(text).toMatch(/Post-integration validation \(MANDATORY, per wave\)/);
  expect(text).toMatch(/INTEGRATED tree/);
});
```

Run → FAIL.

- [ ] **Step 2: Insert into `loop-dag.md` §3f** — after the "Reuse the §10b–§10e contract…" bullet list and before "**Empty-overlap suppression**":

```
**Post-integration validation (MANDATORY, per wave).** After every PASS
task's patch has been applied and committed to the integration tree (§3d /
loop-shared.md §Q) and BEFORE the overlap audit's verdict is rolled up, run
the project's `<build>` + `<test>` (with the §2c flake filter) on the
**INTEGRATED tree** — not in any worktree. Worker-side green is NOT
sufficient: worktree runs can silently no-op (e.g. linters that ignore
`.claude/**`), and no worker ever validated the COMBINED wave diff. Compare
failing FQNs against the §2c baseline; any new failure is handled as a §10e
BROKEN integration — bisect the wave's per-task commits
(`git stash`-free: re-run the failing test at each of the wave's commits) to
attribute, flip the offending task(s) back to `in_progress` with an
`integration_concern` note, and re-emit LOOP-RUN.md. Do NOT recompute the
next frontier on a red integrated tree.
```

- [ ] **Step 3: Verify + commit**

Run: `npx vitest run src/api/routes/tasks/__tests__/loop-dag-skill-design.test.ts` → PASS. `npm test` → green.

```bash
git add skills/tasks/loop-dag.md src/api/routes/tasks/__tests__/loop-dag-skill-design.test.ts
git commit -m "feat(loop-dag): mandatory per-wave build+test on the integrated tree"
```

---

### Task 12: Audit — grade-up-to-cap + verdict-drift reporting

**Files:**
- Modify: `src/lib/audit/schema.ts` (`AuditTaskEntry`: two optional fields)
- Modify: `src/lib/audit/__tests__/schema.test.ts`
- Modify: `skills/tasks/audit.md` (cost-cap section, Step 2, Step 6 body)
- Modify: `docs/tasks-audit-design.md` (§3 / §4 / §5 Guardrail 3 — mirror)
- Test: `src/api/routes/tasks/__tests__/skill-audit-design.test.ts`

- [ ] **Step 1: Failing schema test**

Append to `src/lib/audit/__tests__/schema.test.ts` (reuse its valid-entry fixture):

```ts
it('AuditTaskEntry accepts loop_verdict and cost_cap_deferred', () => {
  const entry = {
    ...validEntry,
    loop_verdict: 'PASS',
    cost_cap_deferred: true,
  };
  expect(AuditTaskEntrySchema.safeParse(entry).success).toBe(true);
});
```

Run → FAIL. Then add to `AuditTaskEntrySchema` in `src/lib/audit/schema.ts`:

```ts
  /** The verdict the original loop run recorded for this task (from LOOP-RUN.md ## Tasks Closed). Drift vs `score` is the audit's key signal. */
  loop_verdict: z.enum(['PASS', 'FAIL', 'PARTIAL', 'NOT_VERIFIED']).optional(),
  /** True when the 5 USD cap stopped grading before this task's verifier dispatched. */
  cost_cap_deferred: z.boolean().optional(),
```

Run schema tests → PASS. `npm run build` → green.

- [ ] **Step 2: Failing design-gate test**

Append to `skill-audit-design.test.ts`:

```ts
describe('grade-up-to-cap + verdict drift (2026-07 quality plan T12)', () => {
  it('cost cap grades a prioritized subset instead of zero', () => {
    expect(skillText).toMatch(/grade as many tasks as fit under the cap/i);
    expect(skillText).toMatch(/cost_cap_deferred/);
  });

  it('AUDIT.md carries loop_verdict and a Verdict Drift section', () => {
    expect(skillText).toMatch(/loop_verdict/);
    expect(skillText).toMatch(/## Verdict Drift/);
  });
});
```

Run → FAIL.

- [ ] **Step 3: Edit `audit.md`**

(a) Replace the body of "## 5 USD hard cost-cap guard" (keep the heading and the `estimated_usd = task_count × 0.30 USD` formula) so the over-cap branch reads:

```
**If `estimated_usd > 5 USD`, grade as many tasks as fit under the cap
instead of halting at zero.** Compute `budget_count = floor(5 / 0.30) = 16`.
Prioritize which tasks get a verifier — highest-signal first:

1. Tasks whose LOOP-RUN.md verdict was NOT `PASS` (FAIL / PARTIAL /
   NOT_VERIFIED) — drift here is most likely.
2. Then PASS tasks by descending `file_changes` count (bigger diffs, bigger
   risk).
3. Then the rest by ascending task id.

Dispatch verifiers for the first `budget_count` tasks only. Every remaining
task is scored `PARTIAL` with `cost_cap_deferred: true` and NO verifier
dispatched. Set frontmatter `cost_cap_hit: true`. The integration verdict
roll-up treats deferred tasks as `PARTIAL` (never `COVERED` — ungraded is
not certified).
```

Update the worked example to match: "a 20-task run grades the 16 highest-signal tasks and defers 4 with `cost_cap_deferred: true`."

(b) In Step 2, add one bullet to the per-task fetch list:

```
- `loop_verdict` — the task's verdict from the LOOP-RUN.md `## Tasks Closed`
  row (PASS / FAIL / PARTIAL / NOT_VERIFIED), carried into the AuditTaskEntry.
```

(c) In Step 6 body sections: add `loop_verdict` to the `## Per-Task Audit` column list, and insert a new section between `## Integration Verdict` and `## Cost Breakdown`:

```
3. **`## Verdict Drift`** — one bullet per task whose audit score DISAGREES
   with its loop verdict (e.g. loop said PASS, audit scored MISSING):
   `#<task_id> — loop:<verdict> → audit:<score> — <first failing evidence
   line>`. Sentinel `_No drift: audit agrees with every loop verdict._` when
   empty. Drift rows are the audit's primary output — they are where grade
   inflation or environment skew shows up.
```

(renumber the later body sections accordingly).

(d) Update Guardrail 3's text to the new bounded-subset semantics (the cap still hard-bounds spend at ≤ 5 USD of verifier dispatches; it no longer zeroes the run).

- [ ] **Step 4: Mirror in `docs/tasks-audit-design.md`** — §3 (Steps 2/3/5), §4 (body sections), §5 Guardrail 3. The design doc wins on drift; they must agree in this commit. Check `skill-audit-design.test.ts` for existing assertions pinning the OLD zero-dispatch behaviour (e.g. matching "zero verifiers" / "dispatching zero") and update them to pin the new contract.

- [ ] **Step 5: Verify + commit**

Run: `npx vitest run src/lib/audit/__tests__/schema.test.ts src/api/routes/tasks/__tests__/skill-audit-design.test.ts` → PASS. `npm test` → green.

```bash
git add src/lib/audit/schema.ts src/lib/audit/__tests__/schema.test.ts skills/tasks/audit.md docs/tasks-audit-design.md src/api/routes/tasks/__tests__/skill-audit-design.test.ts
git commit -m "feat(audit): grade-up-to-cap prioritization + verdict-drift section"
```

---

### Task 13: Execution ledger (§S) — model-agnostic step tracking

**Files:**
- Modify: `skills/tasks/loop-shared.md` (new §S, before §T)
- Modify: `skills/tasks/loop.md` (Preflight — one line)
- Modify: `skills/tasks/loop-dag.md` (Preflight — one line)
- Modify: `skills/tasks/decompose.md` (Preflight — one line)
- Modify: `skills/tasks/audit.md` (Preflight — one line)
- Test: `src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('loop-shared.md contains §S execution ledger (2026-07 quality plan T13)', () => {
  const text = readFileSync(LOOP_SHARED_PATH, 'utf8');
  expect(text).toMatch(/^##\s+§S\.\s+Execution ledger/m);
});

it('all four orchestrator skills point at §S', () => {
  for (const rel of [
    'skills/tasks/loop.md',
    'skills/tasks/loop-dag.md',
    'skills/tasks/decompose.md',
    'skills/tasks/audit.md',
  ]) {
    expect(readFileSync(resolve(REPO_ROOT, rel), 'utf8')).toMatch(/§S/);
  }
});
```

Run → FAIL.

- [ ] **Step 2: Add §S to `loop-shared.md`** (insert before §T from Task 10)

```
## §S. Execution ledger (mandatory step tracking)

**Called from:** the Preflight of `loop.md`, `loop-dag.md`, `decompose.md`,
`audit.md`.

Long prose contracts get steps silently skipped — especially by smaller
models. At run start, BEFORE the first MCP call, mirror the invoking skill's
numbered step list into the harness todo list (load the trio per §K, then one
`TaskCreate` per ledger row). Canonical ledgers:

- **loop:** `2a discovery · 2b commands · 2c baseline · 2f topology gate ·
  2g wsjf-health · [per task: 1 pick · 2 claim+read · 3 plan · 4 dispatch ·
  5 verify · 6 commit · 7 verifier · 8 close · 9 emit] · 10·0 §O gate ·
  10 integration audit`
- **loop-dag:** `2f gate · 2g feasibility · 2h wsjf-health · 2a–2e discovery ·
  [per wave: 3a frontier · 3b dispatch · 3c await · 3d verify ·
  3d-post integrated-tree validation · 3e summary · 3f audit] · §O gate ·
  4 final audit · 5f emit · 5g teardown`
- **decompose:** `1 capture+guardrail4 · 2 recon · 3 candidates · 3b AC lint ·
  4 independence · 4b overlap check · 5 topology · 6 coverage · 7 sizing ·
  8a scoring · 8b create · 8c riders · 8d spec audit · 9 emit`
- **audit:** `1 resolve · 2 enumerate · cap guard · 3 dispatch · 4 score ·
  5 rollup · 6 emit`

Flip each row `in_progress` when its step starts and `completed` when its
exit condition is met. A row you cannot honestly flip to `completed` is a
step you may NOT skip — either execute it, or record WHY it is N/A for this
run in the run artifact (gate refusal, empty overlap set, no distributable,
etc.) and flip it then. At emit time, an unfinished ledger row is a defect in
the run — surface it in the artifact rather than deleting the row.
```

- [ ] **Step 3: Add the four Preflight pointer lines**

Add to each skill's Preflight block (loop.md and loop-dag.md after the identity paragraph; decompose.md and audit.md after the MCP-tools paragraph):

```
**Execution ledger:** before the first MCP call, mirror this skill's step list into the harness todo list per [loop-shared.md §S](loop-shared.md#s-execution-ledger-mandatory-step-tracking).
```

- [ ] **Step 4: Verify cap + tests + commit**

Run: `wc -l skills/tasks/loop.md` → ≤ 700 (if over, the Task 1 trim left ~4 lines headroom; if still over, additionally compress loop.md §2f's pre-Wave-11 historical-halt paragraph — but first `grep -rn "pre-Wave-11\|historical text" src/api/routes/tasks/__tests__/` to confirm nothing pins it).
Run: `npx vitest run src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts src/api/routes/tasks/__tests__/skill-decompose-design.test.ts src/api/routes/tasks/__tests__/skill-audit-design.test.ts src/api/routes/tasks/__tests__/loop-dag-skill-design.test.ts` → PASS.
Run: `npm test && npm run lint && npm run build` → green.

```bash
git add skills/tasks/loop-shared.md skills/tasks/loop.md skills/tasks/loop-dag.md skills/tasks/decompose.md skills/tasks/audit.md src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts
git commit -m "feat(skills): §S execution ledger — mandatory step tracking across orchestrators"
```

---

### Task 14: Final sweep — full gate + self-consistency

- [ ] **Step 1: Full quality gate**

Run: `npm run quality` (falls back to `npm run build && npm test && npm run lint` if no such script). Expected: green, zero warnings.

- [ ] **Step 2: Cross-reference sweep**

Run: `grep -n "§[A-T]\]" skills/tasks/*.md skills/agents/*.md | grep -v "loop-shared.md:"` and verify every `§X](loop-shared.md#...)` label matches its anchor letter (the Task 5 class of bug). Fix any mismatch found; commit as `fix(skills): correct §-label/anchor mismatches` if needed.

- [ ] **Step 3: Line-cap + heading audit**

Run: `wc -l skills/tasks/loop.md` (≤ 700) and `npx vitest run src/api/routes/tasks/__tests__/loop-shared-extraction.test.ts`.

- [ ] **Step 4: Push**

```bash
git push
```

If SSH push fails: note it and move on — commit locally, flag push as a manual follow-up (repo convention).

## Explicitly out of scope (documented for the next planning round)

- **Cross-file symbol-level integration analysis** (task A changes a signature in file X, task B adds a caller in file Y — no same-file overlap, so the integration auditor never fires). Task 11's integrated-tree test run is the pragmatic catch; a symbol-graph auditor is a future project.
- **BROKEN-revert git semantics** — §10e flips task *status* but the commits remain on the branch. Worth a follow-on: on BROKEN, materialize a remediation task citing the commits (the §O carve-out shape) so the broken composition is tracked, not just re-queued.
- **`--spec` as a generation input** for decompose (currently post-hoc audit only, by design §1). Revisit only with a design-doc change.
- **Verifier role naming** — audit dispatches the verifier under the `planning` model role while loop uses `validation`; harmless but worth unifying in a future §R revision.
