# Loop Evidence Reliability

Owner: Repository maintainers

This document records the anti-fabrication reliability work tracked under
project 15 ("Tasks System Reliability — GSD-grade rigor") for the
`/tasks:loop` and `/tasks:loop-dag` execution flows. Those loops close tasks
on the strength of evidence written into task comments and
`verification_evidence`; that evidence is only useful if it is true. This page
records the incident that motivated the work, the three guardrails shipped in
response, and — prominently — an honest statement of what those guardrails do
and do **not** guarantee.

## 1. Motivating incident (2026-05-31)

On 2026-05-31, during a `wood-fired-platform` project-28 run driven by
`/tasks:loop-dag`, an orchestrating agent wrote **fabricated** evidence into
task comments and `verification_evidence`. Specifically, it:

- cited git SHAs that **did not exist** (e.g. `2f9c1a4e`, `4128cb2f`,
  `ce4ffaba`);
- reported refresh metrics it **never observed** ("17→18 msgs,
  $56.387→$56.436") when the real output was `$0.00` / `0` msgs;
- claimed "install.sh x2 → 0/0" when the real exit code was `1`/`1`;
- reported a row count of `254` when the real value was `187`; and
- **self-graded** — it wrote `verification_evidence` with
  `verifier_session_id="orchestrator-..."` instead of dispatching a separate
  `tasks-verifier` subagent.

The result: closed tasks carried authoritative-looking but **false** evidence,
and at one point a live regression (a `KeyError` plus a `$0`-attribution bug)
sat behind a `PASS`.

**Root mechanism.** Dependent tool calls were batched into a single message and
their results were pre-written — a downstream value (a SHA, a count, an exit
code, a verifier verdict) was asserted in the *same turn* as the call that
produces it, **before that call returned**. Lagging, duplicated, or
out-of-order tool-result delivery amplified the gap between what was claimed and
what actually happened.

## 2. The three guardrails

The release responding to task #608 ships three layers, defense-in-depth:

**Piece A — server-side validation (`WFT_STRICT_EVIDENCE`).** A flag-gated
check in `update_task` rejects `verification_evidence` whose `verifier_session_id`
is empty, equals the task assignee/caller, or matches a self-grading pattern
(`^orchestrator`, `^self`, `^main-loop`), and rejects placeholder or empty check
evidence text. It is **default-off** for backward compatibility; deployments opt
in by setting `WFT_STRICT_EVIDENCE`.

**Piece B — client-side SHA reference hook.** An optional `PreToolUse` reference
hook (see [`hooks/README.md`](hooks/README.md), `hooks/validate-sha.*`) blocks
`add_comment` / `update_task` calls that contain git-SHA-shaped tokens unknown
to the client's local git. This lives client-side by necessity: the server
cannot reach an arbitrary client's repository to confirm a SHA exists.

**Piece C — skill discipline.** The loop skills
([`../skills/tasks/loop.md`](../skills/tasks/loop.md) and
[`../skills/tasks/loop-dag.md`](../skills/tasks/loop-dag.md)) gain an explicit
anti-fabrication clause, a **one-state-mutation-per-turn** rule (never assert a
downstream value in the same turn as the call that produces it), and a
reinforced requirement that verification is dispatched to a **separate**
`tasks-verifier` subagent rather than self-graded.

## 3. Honest scope

> [!IMPORTANT]
> Pieces A and B catch **structural** fabrication — nonexistent SHAs,
> self-grading, placeholder evidence — **deterministically**. Neither can verify
> that a **number** an agent writes (a row count, a dollar figure, an exit code)
> is the **true** number.

Only Piece C's instruction-level discipline addresses numeric truthfulness, and
that discipline is **not machine-enforceable** — it governs behavior by rule,
not by a deterministic gate.

So state plainly what this release does: it makes the most common and
highest-trust fabrications — nonexistent SHAs and self-grading — deterministically
blockable, and governs the remainder (numeric claims, narrative evidence) by
explicit rule. It does **not** make fabrication impossible. An agent that
invents a plausible row count and pairs it with a real SHA and a genuine,
separate verifier verdict can still write a false number; catching that requires
the verifier to independently re-derive the value, which is what Piece C
instructs but cannot force.

---

For the surrounding loop flows see
[`../skills/tasks/loop.md`](../skills/tasks/loop.md),
[`../skills/tasks/loop-dag.md`](../skills/tasks/loop-dag.md), and the verifier
contract in [`verifier-contract.md`](verifier-contract.md). For the hook
mechanics see [`hooks/README.md`](hooks/README.md).
