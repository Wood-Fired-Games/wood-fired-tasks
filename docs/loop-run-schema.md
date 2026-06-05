# LOOP-RUN.md Artifact Contract

> **Status:** v1 (introduced by wood-fired-tasks task #313, milestone v1.7 work).
> **Companion files:** [`loop-run-schema.json`](./loop-run-schema.json) (Ajv-validatable JSON
> schema for the frontmatter) and a reference example at
> [`loop-run-reference-example.md`](./loop-run-reference-example.md). The reference
> lives under `docs/` (a tracked path) even though live runs land under
> `.planning/loops/` — see §2 for the runtime convention.

## 1. Purpose & Scope

`LOOP-RUN.md` is the **per-run audit trail** for the `tasks:loop` /
`tasks:bug-smash` autonomous backlog drainer. Each invocation of the loop —
where an orchestrating session picks the next-highest-priority open task,
dispatches a subagent to fix it, re-verifies independently, closes the task,
commits, pushes, and repeats — emits exactly one `LOOP-RUN.md` summarizing the
entire run.

The artifact is a single durable markdown record of *what happened* on a
discrete unit of automated work, with enough structure to support
cost-attribution joins, replay, and downstream review.

**LOOP-RUN.md is:**

- A *post-hoc* run summary covering verdicts, cost, and integration-risk hints.
- Linkable to the orchestrator's session ID and each subagent's session ID so
  cost / tokens can be joined against `agent_transactions_v`.
- The replay manifest for re-grading a run (which tasks, which commits, which
  acceptance criteria).

**LOOP-RUN.md is NOT:**

- A full transcript of the orchestrator or subagent turns (those live in the
  Claude Code session DB; this file *points* at them).
- A code-review artifact (PR review notes belong on the PR; this file may
  surface integration concerns but does not replace human review).
- A bug-database substitute — task lifecycle stays in wood-fired-tasks; the
  loop file is an immutable audit complement to that mutable state.

## 2. File Location Convention

```
.planning/loops/<UTC-timestamp>-<project_id>[-<slug>].md
```

- **Directory:** Always `.planning/loops/`. Created on first emission. Lives
  under `.planning/` so review tooling that scans `.planning/**/*.md` picks
  it up alongside any other planning artifacts the user keeps there.
- **Timestamp:** ISO-8601 UTC with colons replaced by `-` for filesystem
  safety (`:` is reserved on Windows / NTFS, awkward in shell globs). The
  emitter MUST use the *start* time of the run.
  - Canonical format: `YYYY-MM-DDTHH-MM-SSZ`
  - Example: `2026-05-23T20-20-13Z`
- **project_id:** The wood-fired-tasks numeric project id the loop drained.
- **slug (optional):** Append `-<slug>` when the file is a reference / synthetic
  example, e.g. `-reference`, `-replay`, `-dry-run`. Live runs SHOULD omit it.

A reference (synthetic) example is published at
[`docs/loop-run-reference-example.md`](./loop-run-reference-example.md). It is
intentionally NOT under `.planning/loops/` because `.planning/` is gitignored —
runtime artifacts stay per-machine, but the reference must be tracked alongside
the schema doc.

## 3. Frontmatter Schema

All keys are **required** unless marked optional. The frontmatter is YAML,
delimited by `---` lines, and MUST appear first in the file.

| Field | Type | Format / Units | Description | Example |
|---|---|---|---|---|
| `run_id` | string | UUIDv4 | Stable identifier minted by the orchestrator at run start; used to dedupe re-emissions. | `4ae2b18c-9c2f-4f7d-9b2c-1d5d8e3a55a0` |
| `project_id` | integer | ≥ 1 | wood-fired-tasks project drained by this run. | `12` |
| `started_at` | string | RFC 3339 / ISO-8601 date-time, UTC | Orchestrator start time. | `2026-05-22T17:50:00Z` |
| `ended_at` | string | RFC 3339 / ISO-8601 date-time, UTC | Orchestrator end time (last commit pushed). | `2026-05-22T22:18:43Z` |
| `wall_seconds` | integer | ≥ 0, seconds | `ended_at - started_at` rounded down. Stored explicitly so consumers don't re-parse timestamps. | `16123` |
| `orchestrator_session_id` | string | Claude Code session id | The *orchestrating* session — joins to `agent_transactions_v.session_id`. | `84ae52df-3d10-4a8e-9b88-7c33e4d0a112` |
| `total_tokens` | integer \| null | ≥ 0 or null | **Best-effort / approximate**, nullable (`null` when unmeasured). A roll-up of the available subagent `<usage>` blocks, NOT authoritative — orchestrator-session tokens are typically uncaptured at emit time. Present-but-nullable: emit `null`, never omit. | `4812334` |
| `total_usd` | number \| null | ≥ 0 or null, USD | **Best-effort / approximate**, nullable (`null` when unmeasured). A roll-up of the available subagent `<usage>` blocks (cache-discounted), NOT authoritative — orchestrator-session cost is typically uncaptured at emit time. Present-but-nullable: emit `null`, never omit. | `7.42` |
| `subagents_dispatched` | integer | ≥ 0 | Count of distinct subagent sessions spawned. | `15` |
| `tasks_attempted` | integer | ≥ 0 | Tasks picked up during the run (closed + failed + partial + not_verified). | `15` |
| `tasks_passed` | integer | ≥ 0 | Subset with verdict `PASS`. | `12` |
| `tasks_failed` | integer | ≥ 0 | Subset with verdict `FAIL`. | `1` |
| `tasks_partial` | integer | ≥ 0 | Subset with verdict `PARTIAL`. | `1` |
| `tasks_not_verified` | integer | ≥ 0 | Subset with verdict `NOT_VERIFIED`. | `1` |
| `gate_decision` | string (optional) | `allowed` \| `auto_ordered` \| `overridden` \| `blocked` | Wave 4.2 (#319) + Wave 11. Outcome of the §2f topology pre-flight gate in `skills/tasks/loop.md`. `allowed` when `topology=FLAT`; `auto_ordered` when `topology=DAG` and the loop auto-computed a Kahn-based topological execution order (Wave 11 default); `overridden` when `topology=DAG` and the invocation included `--i-know-what-im-doing` (skip auto-sort, use flat ordering); `blocked` when `topology=DAG_CYCLIC` (which cannot be overridden), or for the pre-Wave-11 DAG-without-override halt. Optional for backward compatibility with pre-#319 emissions. | `auto_ordered` |

Invariant (checked by the validator and re-checked by replay):
`tasks_attempted == tasks_passed + tasks_failed + tasks_partial + tasks_not_verified`.

### 3.1 Why these fields? (rationale)

- **`run_id`** — emitter idempotency. Re-running the formatter on the same run
  MUST produce the same `run_id` (and the same file path).
- **`orchestrator_session_id`** — required join key for cost attribution.
  `agent_transactions_v` is keyed by session, so without this the per-run cost
  can't be reconciled against analytics.
- **`wall_seconds`** stored alongside `started_at` / `ended_at` so dashboards
  don't need a date library to render run duration.
- **`tasks_*` breakdown** mirrors the verdict vocabulary in §5 — the
  counts MUST match the verdict cells in the `## Tasks Closed` table.
- **`total_tokens` / `total_usd`** are denormalized roll-ups; the granular
  breakdown is in the `## Cost Breakdown` section so consumers don't have to
  parse the markdown table to get headline cost. They are **best-effort and MAY
  be `null` when unmeasured** — orchestrator-session tokens/USD are typically
  not captured at emit time and subagent `<usage>` blocks are only loosely
  summed, so the artifact does not assert exactness. The authoritative cost
  figure is the post-run `agent_transactions_v` cross-check (joined on the
  session ids), NOT this artifact.

## 4. Body Section Contracts

Sections MUST appear in this order. Empty sections are allowed (e.g. a run
with no failures still emits an empty `## Verifier Findings`) — they are
explicit "we checked, nothing here" markers, not omissions.

### 4.1 `## Tasks Closed`

A markdown table, one row per attempted task, columns *in this order*:

| Column | Type | Notes |
|---|---|---|
| `task_id` | integer | wood-fired-tasks task id (e.g. `293`) |
| `title` | string | Truncate to ≤ 100 chars with `…` if needed |
| `verdict` | enum | `PASS` \| `FAIL` \| `PARTIAL` \| `NOT_VERIFIED` |
| `evidence_link` | string | Relative path or URL to commit, PR, or test artifact |
| `subagent_session_id` | string | Joinable to `agent_transactions_v.session_id` |
| `commit_shas` | string | Space-separated short SHAs; `—` if no commits landed |

Example row:

```
| 293 | Add aria-live to streaming chat region | PASS | [12a4b6c](../commits/12a4b6c) | 8f1d2e3a-… | 12a4b6c |
```

### 4.2 `## Verifier Findings`

One *block* per task with verdict `FAIL` or `PARTIAL`. Block shape:

```markdown
### Task <task_id> — <verdict>

**Acceptance criteria:** <one-line restatement>

**What the subagent claimed:** <one-line summary>

**What the independent verifier observed:** <one or more bullets with evidence
links — failing test names, log snippets, missing files, etc.>

**Disposition:** <kept open / re-opened / converted to follow-up #NNN>
```

If there are no FAIL or PARTIAL verdicts, the section body MUST be the literal
sentinel paragraph `_No findings: all attempted tasks verified clean._` so
absence-of-evidence is distinguishable from absence-of-section.

### 4.3 `## Integration Concerns`

Auto-detected hazards. Emit one bullet whenever **≥ 2 closed tasks touched the
same source file**. Each bullet:

```
- `<path/to/file>` — touched by tasks #A, #B; commits <shaA> <shaB>; advisory
  reviewer: confirm changes compose cleanly (no logical merge conflict).
```

If no overlaps, body is the sentinel `_No integration concerns auto-detected._`.

Scope rules:

- Only consider files in committed diffs (not staged-but-unpushed work).
- File matching is path-exact after `git diff --name-only` per commit.
- Generated / lockfiles (`package-lock.json`, `*.lock`, `dist/**`) MUST be
  excluded.

### 4.4 `## Cost Breakdown`

A markdown table with one row per *participant* (orchestrator + each subagent
collapsed by model) and a `TOTAL` row. Columns:

| Column | Type | Notes |
|---|---|---|
| `participant` | string | `orchestrator` or `subagent:<task_id>` |
| `model` | string | Concrete model id used (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`) |
| `input_tokens` | integer | Non-cache input |
| `cache_create_tokens` | integer | Cache writes |
| `cache_read_tokens` | integer | Cache hits |
| `output_tokens` | integer | Completion tokens |
| `usd` | number | Discounted cost in USD |

Totals row: sum each numeric column. Reconciliation is conditional on the
frontmatter fields being measured (they are best-effort and MAY be `null`):
when `total_usd` is non-null, the TOTAL row `usd` sum SHOULD reconcile to it to
±$0.005; when `total_tokens` is non-null, the TOTAL row token sum SHOULD
reconcile to it. When either frontmatter field is `null`, the Cost Breakdown
TOTAL row is the best available signal for that figure (no reconciliation
target exists).

### 4.5 `## Wave Summary` (`/tasks:loop-dag` only — Wave 4.3 / task #341)

Emitted ONLY by `/tasks:loop-dag` (the DAG executor sibling of `/tasks:loop`).
`/tasks:loop` MUST NOT emit this section. A markdown table, one row per
dispatched wave in `wave_index` ascending order:

| Column | Type | Notes |
|---|---|---|
| `wave_index` | integer ≥ 1 | 1-based wave counter; increments per `/tasks:loop-dag` §3a frontier recomputation |
| `task_ids` | string | Comma-separated task ids dispatched in this wave (ascending) |
| `started_at` | RFC 3339 UTC | Captured immediately before `/tasks:loop-dag` §3b parallel dispatch |
| `ended_at` | RFC 3339 UTC | Captured immediately after the last verifier in §3d returned |
| `wall_seconds` | integer ≥ 0 | `floor((ended_at − started_at).total_seconds())` |
| `verdicts` | string | Comma-separated `task_id:verdict` pairs |

The section is the on-disk audit surface of `/tasks:loop-dag` §3e
`wave_summary` state — it is what makes a DAG run replayable wave-by-wave
instead of as a flat task list. If `/tasks:loop-dag` was refused at the §2f
gate (FLAT or DAG_CYCLIC topology), the section body is the sentinel
paragraph `_No waves dispatched — gate refused at §2f._`.

Companion section: `/tasks:loop-dag` ALSO emits a `## Stalled Tasks`
section when its §3a stall-check fires (open tasks remain but the frontier
is empty because of a FAIL/PARTIAL/NOT_VERIFIED upstream). See
`skills/tasks/loop-dag.md` §5d for the bullet shape.

`LoopRunFrontmatterSchema` is **NOT extended** by Wave 4.3 — the wave
summary is a body-section-only extension, mirroring the Wave 3.2 / #317
decision that integration-audit failure conveys via a body section
(`## Integration Failure`) rather than a new frontmatter field.

### 4.6 `## Replay Instructions`

Exact shell commands a maintainer can run to re-grade this run. At minimum:

```bash
# 1. Check out the commits emitted by this run
git fetch origin && git log --oneline <first_sha>^..<last_sha>

# 2. Re-run the verification gates this loop trusted
npm run build && npm test && npm run lint

# 3. Re-validate this LOOP-RUN.md frontmatter against the schema
node -e "..." # or: npx ajv validate -s docs/loop-run-schema.json -d <frontmatter.json>
```

The block MUST be a fenced ```bash code block so it copy-pastes cleanly.

## 5. Verdict Vocabulary

Exactly four values are legal in the `verdict` column and in
`## Verifier Findings` headers.

| Verdict | Meaning |
|---|---|
| `PASS` | All declared acceptance criteria met. Independent verifier confirmed via tests / build / runtime checks the loop has access to. Task is closed in wood-fired-tasks. |
| `FAIL` | At least one acceptance criterion verifiably broken (failing test, build red, missing required artifact). Task is kept open or re-opened. |
| `PARTIAL` | *Some* acceptance criteria met but not all. The work is real and may have landed in commits, but the task does **not** meet the bar to close. Use this when a fix addresses the headline issue but leaves a follow-up gap (e.g. test added but coverage regression on an adjacent path). |
| `NOT_VERIFIED` | Could not be self-canaried in this run. Distinct from `PARTIAL`: the subagent's work *may* be correct, but the verification surface isn't reachable from the loop (e.g. a runtime canary requires a prod deploy, an external service is down, a Slack integration test needs a real workspace). Task SHOULD be kept open pending out-of-band verification. |

The boundary that matters:

- `PARTIAL` ⇒ "we checked and it's incomplete."
- `NOT_VERIFIED` ⇒ "we couldn't check from here."

## 6. Validation

The frontmatter is validated by `docs/loop-run-schema.json` (JSON Schema
2020-12). Use the existing Ajv 8 dependency (already in `node_modules` via
fastify's transitive deps) — do not add a new top-level dependency.

A minimal validation snippet (works with the project's installed Ajv 8):

```js
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync('docs/loop-run-schema.json', 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const md = readFileSync(process.argv[2], 'utf8');
const fm = md.match(/^---\n([\s\S]*?)\n---/);
if (!fm) throw new Error('no frontmatter');
const data = parseYaml(fm[1]);
if (!validate(data)) {
  console.error(validate.errors);
  process.exit(1);
}
console.log('ok');
```

A maintainer can run that snippet against the reference example to confirm the
contract holds end-to-end.
