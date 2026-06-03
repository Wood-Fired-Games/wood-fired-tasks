# Retrospective: the WSJF remote-MCP-parity gap that survived a full pool drain

**Date:** 2026-06-01
**Surfaced during:** dogfood-deploy prep after `/tasks:loop-dag project 30` (WSJF Prioritization) drained its backlog.
**Severity:** capability incomplete in production despite 100% of tasks PASS-verified.

## What the gap was

The WSJF feature added four MCP tools — `wsjf_ranking`, `wsjf_history`, `rescore_project`,
`wsjf_health` — but registered them **only in the stdio MCP server** (`src/mcp/server.ts` →
`src/mcp/tools/wsjf-tools.ts`). Production reaches the MCP through the **remote proxy**
(`wft-mcp` → `dist/mcp/remote/index.js` → `src/mcp/remote/register-tools.ts`), which is a thin
REST client. None of the four tools had a remote proxy, and three had no backing REST endpoint
at all. Net effect: every WSJF task closed PASS, but **no agent could call the new tools in
production**, and the new `loop.md §2g` / `loop-dag.md §2h` / `project-status` / post-rescore
health-surfacing steps that invoke `wood-fired-tasks:wsjf_health` would have silently no-op'd.

Fixed post-hoc in commit `c9494ca` (3 REST endpoints + RestClient methods + 4 remote proxy
tools + tests). This retrospective is about why it was missed in the *first* place.

## How it was missed (root cause chain)

1. **Origin — plan-level omission.** The plan
   (`docs/superpowers/plans/2026-06-01-wsjf-prioritization.md`) §7 "MCP surface" mapped only to
   stdio-tool tasks (1.10, 3.2, 4.1, 5.1). The repo has a *documented* invariant — "any new stdio
   MCP tool needs a REST endpoint + a remote proxy to stay at parity" — but it lived in tribal
   knowledge and scattered **per-tool** parity tests, not in the plan template or any machine
   guard. The plan author had nothing forcing the "remote MCP" cell to be covered, so it wasn't.

2. **Propagation — decompose has no architectural-invariant coverage step.** `/tasks:decompose`
   turns the goal/plan into leaf tasks via one codebase-recon pass aimed at *implementation
   context*, not "which cross-cutting invariants does this change trip." A surface missing from the
   plan stays missing through decomposition.

3. **Concealment — per-task ACs are locally complete.** Each task's acceptance criteria (e.g.
   "wsjf_health registered through registerWsjfTools and returns the findings list") were fully
   satisfiable by the stdio registration alone. The independent `tasks-verifier` correctly PASSed
   each task against *its own* AC. No AC referenced production reachability or remote parity. Result:
   6/6 PASS while the aggregate capability was unreachable — the canonical
   **"green tasks, broken feature."**

4. **No terminal completeness gate.** The loop's done-signal is "0 open tasks." The
   integration-auditor checks *file overlaps*; the verifier checks *per-task ACs*. Nothing checks
   "is this capability reachable end-to-end through the deployment topology." The
   `wsjf-health-surfacing` smoke that *did* ship exercises the tool **in-process**, not through the
   remote path — so it passed while the remote path was empty.

The gap is structural, not a personal miss: every actor in the pipeline behaved correctly against
its local contract. The contracts didn't add up to the whole.

## Prevent / Detect / Correct

### Prevent (planning + decompose)
- **P1 — Surface-coverage matrix in the plan/spec template.** For each capability, fill a matrix of
  surfaces it must reach: `{ stdio MCP, remote MCP, REST, CLI, skills, client-package mirror,
  docs/tool-count, migration/backfill }`. Every non-N/A cell becomes a task. The WSJF plan had
  REST/CLI/skills cells but no remote-MCP cell.
- **P2 — Decompose "invariant rider."** A recon step that detects which surfaces a change touches
  (e.g. "adds an MCP tool") and auto-emits the paired coverage tasks / AC riders (remote proxy +
  parity test) so a missing plan cell cannot silently drop.

### Detect (before the pool drains)
- **D1 — Structural parity invariant test (highest leverage).** Assert
  `toolNames(stdio) ⊆ toolNames(remote)` modulo an explicit, reason-annotated allowlist for
  genuinely local-only tools. The moment task #646 registered `wsjf_health` in stdio, the suite
  would have gone **RED** until a remote proxy existed — converting a silent planning gap into a
  forced, visible task. Today only *per-tool* parity tests exist, which do not fail when a *new*
  tool is added without a counterpart.
- **D2 — Completeness critic.** An end-of-decompose *and* end-of-pool agent that asks "does the task
  set cover every surface the touched invariants require?" Catches what the machine guard can't encode.
- **D3 — Feature-reachability smoke at loop termination.** Before declaring "drained," exercise
  newly-added capabilities through the **real deployment path** (remote MCP), not in-process units.

### Correct (when detected before drain)
- **C1 — Integrity carve-out to "don't create tasks during the loop."** When the parity test or
  completeness critic flags a missing surface, the loop is permitted/required to materialize the
  remediation task and keep draining, rather than silently closing the pool.
- **C2 — Gate the terminal state.** "0 open tasks → done" must additionally require a green invariant
  audit (parity test + mirror parity + reachability smoke). "No open tasks" alone may not declare success.

## Tracked as
Project **#15 (Tasks System Reliability — GSD-grade Rigor for /tasks:loop)** — the structural-parity
test (D1), the decompose surface-matrix + invariant-rider (P1/P2), and the loop terminal
invariant/reachability gate (D3/C2). See those tasks for executable acceptance criteria.
