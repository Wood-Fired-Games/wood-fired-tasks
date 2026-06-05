# Usage Patterns

Owner: Repository maintainers
Status: Operator playbook. Illustrative, not contract. See
[docs/AGENT_CONTEXT.md](AGENT_CONTEXT.md) for the contract and
[docs/WORKFLOWS.md](WORKFLOWS.md) for the build/test command sheet.

## Mission

This is the **operator-facing** companion to [docs/WORKFLOWS.md](WORKFLOWS.md).
Where `WORKFLOWS.md` lists the build/test/lint commands, this file shows the
*shapes* of real day-to-day work: how a goal becomes a plan, a plan becomes a
decomposed project, and a project gets drained by an autonomous loop — wrapped
in the git, review, and context-hygiene rituals that keep long runs safe.

Every example below is **illustrative**. Project numbers, plan paths, and task
IDs are placeholders — substitute your own. The point is the *sequence*, not
the literal arguments.

The single meta-shape that all of these specialize:

> **plan → decompose into a dedicated project → loop/loop-dag to drain →
> surface-and-file new work → commit at a clean boundary → clear context →
> repeat** — wrapped in branch/PR hygiene, with a single-threaded
> live-verified fallback when trust in the autonomous run drops.

The building blocks are the `/tasks:*` skills. See
[NAVIGATION.md](NAVIGATION.md) for the file map and
[skills/tasks/](../skills/tasks/) for each skill's contract:

| Skill | Role in the lifecycle |
| ----- | --------------------- |
| `/tasks:new-project` | Charter interview (skippable) — captures the value charter for WSJF scoring. |
| `/tasks:decompose` | Turns a plan/goal into 8–25 leaf tasks (FLAT) or a dependency DAG. Plans only; never executes. |
| `/tasks:loop` | Sequential autonomous drain of an open backlog (FLAT topology). |
| `/tasks:loop-dag` | Wave-by-wave parallel drain across the dependency frontier (DAG topology). |
| `/tasks:audit` | Post-run grading of closed tasks against acceptance criteria. |
| `/tasks:project-status` | Snapshot of counts by status before you launch. |

---

## 1. Plan → decompose → loop-dag (the canonical DAG flow)

The flagship pattern. You don't hand-write tasks — you produce a **plan**, let
`/tasks:decompose` turn it into a project, then drain it with
`/tasks:loop-dag`.

Illustrative sequence (a "100% coverage for module X" effort):

```text
# 1. Brainstorm the plan interactively (superpowers), pinning constraints up front
use the brainstorming skill to plan 100% test coverage for the core module,
  with mutation testing as the phase-exit gate and a representative end-to-end use

# 2. You author the final plan file — it is the decompose input
#    (lands at e.g. docs/superpowers/plans/2026-06-05-core-100pct-coverage.md)

# 3. Decompose the plan into a NEW project dedicated to this effort
/tasks:decompose docs/superpowers/plans/2026-06-05-core-100pct-coverage.md

# 4. Drain it
/tasks:loop-dag 42
```

**Key moves:**

- Brainstorm and refine constraints *before* writing the plan; the plan file is
  the contract `/tasks:decompose` consumes.
- Put the work on a **fresh project dedicated to this effort** — keeps WSJF
  scoring, the decomposition matrix, and the loop run scoped and legible.
- Let `/tasks:decompose` pick FLAT vs DAG; it runs a topology check. For
  independent leaf work it emits FLAT (use `/tasks:loop`); for prerequisite
  chains it emits a DAG (use `/tasks:loop-dag`).

## 2. Drain a big project across many context clears

A large project is not one sitting. Re-issue the same loop command after each
context clear, and always clear at a **committed, clean boundary**.

```text
/tasks:loop-dag project 42 --max-tasks=0     # session A: unbounded drain
# ...land verified work, then:
push the committed work so we can continue   # clean boundary reached
# --- clear context ---
/tasks:loop-dag project 42                   # session B: pick up where it stopped
# --- clear context ---
/tasks:loop-dag project 42                   # session C ...
# when the backlog drains:
fix any bugs the run surfaced
push and tag
```

**Discipline that makes this safe:**

- The clear always happens *after* a commit/push, never mid-edit. The loop's
  state lives in the task backlog, so a fresh context resumes cleanly.
- `--max-tasks=0` means "drain everything"; omit it (or set a number) to bound a
  single session.

## 3. Pause, steer, and re-decompose mid-run

Launch unbounded, but interrupt to make scope decisions — then inject
newly-discovered work into the **same** project by re-running `/tasks:decompose`.

```text
/tasks:loop-dag project 42 --max-tasks=0

# Interrupt to hold dispatch while you decide scope:
pause — land verified work and hold further dispatch

# Make the scope call, then GROW the project with more tasks:
/tasks:decompose   # add the newly-identified orphan-coverage tasks to project 42

# Resume, or clean up and clear:
clean up the in-flight item, then clear context
```

`/tasks:decompose` is idempotent enough to **extend** an existing project, not
just seed a new one — use it to add the work a run exposed.

## 4. Execute → surface → file → loop again (the capture loop)

After a run, immediately ask what new work it exposed, file those as tasks, and
loop again. The backlog is self-feeding.

```text
/tasks:loop project 33
# then:
what issues did this run surface that should be tracked as tasks?
file the top friction fixes as tasks
/tasks:loop project 33     # drain the newly-filed work
```

**Standing rule for filed tasks:** every task description must carry **enough
context that a fresh agent can get straight to work** — treat task descriptions
as agent briefs, not personal reminders. A filed task that only makes sense to
the person who filed it is a defect.

## 5. Scoped loops (a subset, not the whole backlog)

Target specific task IDs, a wave, or a max-count instead of draining everything.

```text
/tasks:loop project 15 tackle tasks 346 through 352
/tasks:loop project 15 tasks 329, 331, 332, 333
/tasks:loop project 15 wave 4 and wave 5
/tasks:loop 14 --max-tasks 8
```

Use this when you want to land a coherent slice, review it, and stop — rather
than committing to a full unbounded drain.

## 6. Branch → loop → PR → independent review → merge → cleanup

Wrap autonomous loops in git hygiene. Run the loop on a throwaway or feature
branch, then have a **separate** agent review the result before merge.

```text
# isolate the run on its own branch
create a branch named claude/coverage-run and run /tasks:loop on project 12 there
open a PR
use an independent agent to review the PR    # fresh eyes, not the loop's own context
merge it
delete the local and remote branch
```

Variant for a feature being introduced by the loop:

```text
create a feature branch to introduce the event router, then /tasks:loop project 19
```

The independent review matters: the agent that *wrote* the work is the worst
judge of whether it is correct. A fresh context reviewing the diff catches what
the author's context normalized.

## 7. Status check before launching

```text
/tasks:project-status
/tasks:loop project 31
```

A quick `/tasks:project-status` before a loop confirms the frontier is what you
expect (no surprise blocked tasks, no half-open wave) and gives you a baseline
count to verify the drain against afterward.

## 8. Single-threaded, live-verified fallback when the loop misbehaves

When a parallel loop produces unverified or fabricated work, drop to **one task
at a time with explicit live verification** — then file the *meta*-fix as a task
for the tasks system itself.

```text
/tasks:loop-dag project 28
# ... a result looks fabricated, so stop trusting the parallel run:
fix task 580 directly now — single-threaded and live-verified
continue with 584 now — single-threaded and live-verified

# diagnose the class of failure, not just the instance:
pause — why are these fabrications occurring, and how could the environment
  be configured to prevent them?

# turn the lesson into durable guardrails everyone benefits from:
add the prevention to the repo
create a task for the wood-fired-tasks maintainers with full context
reopen task 582 with a comment explaining why
```

This is the origin story of the `WFT_STRICT_EVIDENCE` evidence gate — see
[RELIABILITY.md](RELIABILITY.md). The pattern: **when trust drops, slow down,
verify live, and fix the environment, not just the symptom.**

## 9. New project, interview skipped, seeded with a brief

When you already know the shape of the work, skip the charter interview and
seed tasks directly.

```text
create a new project named "Network Communication" and skip the interview;
  add a task for the Windows machine to install the MCP server, with full
  step-by-step context in the description

create a new project, then define tasks that are either independent or wired
  with explicit dependency chains
```

Skipping the interview forfeits charter-derived WSJF business-value scoring —
fine for a tightly-scoped, self-evident backlog; reach for `/tasks:new-project`
when prioritization across competing work matters.

## 10. Dogfood a skill with friction tracking on first use

The first time you run a skill, treat the run as a test of the skill too: track
and fix friction as you go.

```text
/tasks:loop-dag project 15 — first time using this skill, so track and address
  any friction points or bugs encountered while using it
then: address all the friction points found
```

Filing the friction as tasks (pattern 4) turns first-use pain into a durable
backlog of skill improvements instead of one-off annoyance.

## 11. Closing tasks from a read-only context (the CLI escape hatch)

From a read-only MCP session (e.g. a desktop client) where acceptance criteria
can't be satisfied from the agent context, close the task via the **CLI**
instead.

```text
how do I close this task using the CLI?
write the evidence to task 727, then give me the exact CLI command to apply it
```

The CLI (`tasks` / `npm run cli -- ...`) is the always-available write path when
the agent surface is read-only. Full reference: [CLI.md](CLI.md).

---

## Putting it together

A typical full lifecycle, end to end:

```text
1. Brainstorm + author a plan file              (superpowers / brainstorming)
2. /tasks:decompose <plan.md>   → new project   (FLAT or DAG, auto-chosen)
3. /tasks:project-status        → sanity check the frontier
4. /tasks:loop[-dag] <project>  → drain, on a branch
5. surface new work → file as tasks → drain again   (capture loop)
6. commit at a clean boundary → open PR → independent review → merge → cleanup
7. /tasks:audit <project>       → grade the closed work
```

If trust in any autonomous wave drops, fall back to pattern 8
(single-threaded, live-verified) for the affected tasks, fix the environment,
then resume the loop.

See also:

- [WORKFLOWS.md](WORKFLOWS.md) — the build/test/lint/migrate command sheet.
- [NAVIGATION.md](NAVIGATION.md) — "if you want to do X, read these files."
- [RELIABILITY.md](RELIABILITY.md) — loop anti-fabrication guardrails
  (`WFT_STRICT_EVIDENCE`, the SHA hook, skill discipline).
- [CLI.md](CLI.md) — the `tasks` CLI, including close-from-read-only.
