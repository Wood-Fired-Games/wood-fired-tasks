# Guaranteed Task Sizing — Design

**Date:** 2026-06-10
**Status:** Approved (brainstorm with Stuart, 2026-06-10)
**Motivating incident:** the Tiny Worlds fan-out (projects 38/40, 114 tasks)
was materialized by `/tasks:decompose` runs that skipped the Step-8
`wsjf_submission`, so every task was born sizeless (`wsjf_history` timelines
empty). With no jobSize there is no power category, so the database-default
`ModelPolicy`'s `byCategory` ladders never engaged and every loop worker /
verifier silently inherited the dispatching session's model (Fable 5 — the
most expensive rung — regardless of task size). The model-preference feature
shipped in v2.1.0 was inert on real work.

## Problem

`jobSize` drives `resolve_model`'s power-category routing
(`model-policy.service.ts` → `getJobSize` → `tasks.wsjf_job_size`), but
nothing guarantees a task ever has one:

1. `create_task.wsjf` / `wsjf_submission` are optional. Every surface
   (decompose, `/tasks:log-bug`, CLI, Slack, raw MCP/REST) can mint sizeless
   tasks.
2. The decompose skill's sizing contract (Step 7: `estimated_minutes ≤ 90`;
   Step 8: full `wsjf_submission` per candidate) is **client-side discipline
   with no server-side teeth** — the same failure class as the loop
   coverage-gap: an agent that loads a stale skill, or just skips a step,
   produces silently-degraded data.
3. `rescore_project` cannot backfill: `collectRescoreSet` filters to
   already-scored tasks by design (the server never invents classifications).

## Goals

- Every non-done/non-closed task has a `wsjf_job_size`, always, regardless of
  caller discipline — so `ModelPolicy.byCategory` routing applies to all real
  work.
- The guarantee is **deterministic and server-side**. The server never calls
  an LLM and never fabricates the three Cost-of-Delay components (preserves
  the WSJF core principle and the vendor-neutrality guardrail).
- WSJF *ranking* honesty is preserved: an auto-sized task still counts as
  unscored for prioritization and falls back to `priority` ordering.

## Non-goals

- No full neutral auto-scoring (fabricated value/TC/RO would let keyword
  noise outrank human-set urgent tasks).
- No keyword-prior text inference for sizing (rejected as unreliable; the
  existing `jobSizeBand` keyword bands stay what they are — a clamp on
  LLM-chosen tiers in the classification path, not a sizer).
- No mandatory `estimated_minutes` (would break quick-capture flows).
- No server-side agent dispatch (sizing delegation runs through wft-router,
  which already exists for exactly this shape).

## Design

### 1. Prong A — server-side decompose contract gate (always-on)

`TaskService.createTask` rejects (422-class validation error) any create that
carries a `decomp-*` tag but **no** `wsjf_submission`. Decompose creates are
identifiable today by the `decomp-<uuid>` tag the skill stamps; the error
message instructs the caller to re-run Step 8 (mirrors the
`WFT_STRICT_EVIDENCE` teaching-rejection pattern). No env flag: skipping
Step 8 is a documented-contract violation, not a preference.

This closes the hole that produced the incident: the dominant task factory
can no longer skip sizing, regardless of which skill version the agent
loaded.

### 2. Prong B — deterministic minutes→tier auto-size (size-only)

For non-decompose creates with no WSJF payload, the server computes
`wsjf_job_size` itself from `estimated_minutes` via a pure mapping:

| estimated_minutes | tier |
|---|---|
| ≤ 15 | 1 |
| ≤ 30 | 2 |
| ≤ 60 | 3 |
| ≤ 240 | 5 |
| ≤ 960 | 8 |
| > 960 | 13 |

Stored **size-only**: `wsjf_job_size` set, `wsjf_source.jobSize = 'auto'`,
value/TC/RO stay `NULL`. Consequences (verified against current code):

- `resolve_model` routing engages immediately (`getJobSize` reads the column
  directly; zero resolver changes).
- `componentsOf` still treats the task as unscored (any-null exclusion), so
  WSJF ranking honestly falls back to priority — no fabricated CoD.
- A later full classification via `update_task` overrides cleanly through
  the existing validation gate.

`estimated_minutes` provenance is acknowledged as an upstream bounded
judgment (decompose planner emits [1, 90] post-recon; humans/agents enter it
manually, schema-capped 10080). The chain is one judgment in, deterministic
afterward — the same architecture as the classification path's
`jobSizeTier`-clamped-by-`jobSizeBand`. Misestimates route to adjacent
ladder rungs only; with the current default policy a ~4× misestimate is
needed to cross a model boundary.

### 3. Residual default — tier 3

A create with neither a WSJF payload nor `estimated_minutes` is auto-sized
to **tier 3** (the modal decomposed-leaf tier), `source.jobSize='auto'`.
Every task is guaranteed routable; the `wsjf_health` finding (§6) keeps the
default visible rather than silent.

### 4. Conflict gate — minutes vs tier consistency (create + update)

When a write carries **both** `estimated_minutes` and a **raw `wsjf` payload**
(the manual/pre-computed write path, `WsjfWriteSchema`) bearing a jobSize,
the server rejects iff `minutesToTier(estimated_minutes) ≠ wsjf.jobSize` —
a 422 naming both values. Conflict means **different tier after mapping**,
never different raw numbers (45 vs 60 min both map to tier 3 and must not
error). This is the deterministic implementation of "human set both and they
disagree → error".

The gate deliberately does **not** apply to `wsjf_submission`
classifications: those are already validated by the `jobSizeBand` clamp, and
decompose legitimately pairs `estimated_minutes ≤ 90` (Step 7) with a
band-chosen `jobSizeTier` of 8 (e.g. a refactor-keyword candidate) — a
minutes cross-check there would reject contract-compliant submissions. A
classification is evidence-backed judgment and outranks the minutes prior.

### 5. Backfill — idempotent boot sweep

`backfillJobSizes()` runs at server boot immediately after `runMigrations`
(same `createApp` hook): every task with `wsjf_job_size IS NULL` and status
∉ {done, closed} gets the §2 mapping (or §3 default), `source=auto`, plus an
append-only audit row (existing trigger vocabulary; no enum extension). The
first boot after deploy is the backfill; subsequent boots catch rows written
by older binaries or direct-SQLite writers. Second run writes nothing
(idempotent). One mechanism, deliberately, instead of a one-shot migration
plus a sweep doing the same work twice.

### 6. Surfacing — `wsjf_health` finding

New info-level finding: "N tasks are auto-sized (`source=auto`) awaiting
full classification", listing task ids (capped). Auto sizes are a routing
prior, not a verdict; this keeps them refinable and never silent.

### 7. Update path — bounded recompute

`update_task` recomputes an auto size only when `estimated_minutes` changes
**and** `wsjf_source.jobSize` is still `'auto'`. Classified or manual sizes
are never clobbered by the auto path.

### 8. Agent-delegated sizing — wft-router recipe (docs, not core code)

The human path gains "assign an agent, get a real size": a documented
`triggers.yaml` recipe matching `task.created` where `assignee` is an agent
identity and the stored size is `source=auto`, dispatching an
`agent_session_dispatch` sizing session. The session does recon, emits a
full classification (`update_task` + `wsjf_submission`), passing the §4
conflict gate like any other caller. Quick capture stays instant (the §3
default covers the gap); the server stays LLM-free. Ships as an example
recipe + docs section in the router docs, not as core service code.

## Error handling

- Prong A rejection and §4 conflict rejection are validation-class errors
  with instructive messages (what was missing/conflicting, what to do).
- Boot sweep failures on individual rows log-and-continue (one bad row must
  not block serve); a summary line reports swept/skipped/failed counts.
- All auto writes carry `source.jobSize='auto'` so provenance is queryable.

## Testing

- **Unit:** `minutesToTier` mapping table + boundary values; determinism.
- **Service:** Prong-A reject (decomp tag, no submission); minutes auto-size;
  bare create → tier 3; explicit `wsjf` / `wsjf_submission` paths untouched;
  §4 conflict gate (same-tier passes, cross-tier rejects, create + update);
  §7 recompute rule (auto recomputes, manual/classified never clobbered);
  auto-sized task still priority-fallback in ranking; `resolveModel` routes
  an auto-sized task through `byCategory`.
- **Sweep:** backfills NULL sizes, skips done/closed, idempotent second run,
  audit rows written.
- **E2E (MCP):** bare `create_task` → `resolve_model` returns the ladder
  model (not "inherit"); decompose-tagged create without submission → error.

## Out of scope / future

- Strict-reject mode for bare creates (revisit if tier-3 defaults dominate
  `wsjf_health` findings).
- Inline sizing in the `create-task` skill (the router recipe covers the
  need; add only if async latency proves annoying).
- Any change to `resolve_model`, the policy schema, or the ranking math.
