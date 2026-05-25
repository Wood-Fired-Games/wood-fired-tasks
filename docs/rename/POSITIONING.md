# Positioning — why "tasks" not "bugs" (#294)

The rationale for the rename, and the narrative to thread through docs and
skills during the Phase B sweep.

## The mismatch

The name `wood-fired-bugs` says "bug tracker." The system is not a bug tracker —
it is a **task orchestration backend for autonomous agents**. The codebase
already votes for this:

- The CLI binary is `tasks`, not `bugs`.
- The user-facing skills are `skills/tasks/*` (`pick-up`, `loop`, `loop-dag`,
  `project-status`, `my-work`, …) — a work-execution vocabulary.
- The MCP surface is `create_task`, `claim_task`, `add_dependency`,
  `get_subtasks`, `completion_report` — task lifecycle + DAG dependencies, not
  defect triage.
- The flagship workflows (`loop`, `loop-dag`) are autonomous backlog drains and
  wave-by-wave parallel executors over a task DAG.

"Bugs" undersells it and misleads first-time open-source visitors about scope.

## The positioning

> **wood-fired-tasks** is a task orchestration backend for autonomous coding
> agents: a tracker with first-class dependencies, subtasks, and claim/lifecycle
> semantics, plus the loops that let one or many agents drain a backlog
> hands-off. Bug reports are *one kind* of task it holds — not the point.

Anchor phrases for docs/skills copy:
- "task orchestration for agents"
- "dependency-aware backlog the agents drain themselves"
- "DAG-topology parallel execution" (the `loop-dag` story)

## Scope guidance for the Phase B doc sweep

When the [AUDIT.md](AUDIT.md) sweep rewrites prose, don't just `s/bugs/tasks/`.
Re-frame:

- Replace "bug tracker" / "issue tracker" framing with "task tracker /
  orchestration backend."
- Keep genuine bug-reporting features described as such (the `log-bug` skill
  stays — it's a task *type*, not the product identity).
- Lead docs with the orchestration/loops story; mention bug tracking as a use
  case, not the headline.
- `CHANGELOG.md` is renamed too — nothing was ever public, so there's no old
  name worth preserving in history.

## Non-goals

- Not a rewrite of features — naming and framing only.
- Not deprecating bug-report workflows — they remain a supported task type.
