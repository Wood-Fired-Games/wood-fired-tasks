Owner: Repository maintainers

# Recipe: agent-delegated WSJF sizing

This recipe shows how to wire `wft-router` so that a newly-created task
assigned to an agent-type identity — and carrying an auto-sized job size
(`wsjf_source.jobSize == 'auto'`) — automatically receives a full WSJF
classification from that agent. It composes existing primitives and
introduces **no new handler**.

The sizing guarantee on this branch (`feat/guaranteed-task-sizing`) means
every task born without a WSJF payload gets `wsjf_source.jobSize='auto'`
immediately: model-routing engages, but the three Cost-of-Delay components
(Business Value, Time Criticality, Risk/Opportunity) remain unset. This
recipe closes that gap for agent-assigned tasks by delegating a full
classification back to the assignee as soon as the task is created.

## When to reach for this

The auto-size (tier-3 default or minutes→tier map) is a *routing prior*, not
a WSJF verdict. It is sufficient for `resolve_model` to pick a ladder rung,
but it contributes nothing to economic prioritization. Reach for this recipe
when:

- Your project assigns tasks directly to a named agent identity at create
  time (e.g. `create_task ... assignee=my-agent-worker`).
- You want the agent to immediately classify the task with a full
  `wsjf_submission` so the task can participate in `wsjf_ranking`.
- You prefer *not* to block the create call on the classification
  (instant-capture semantics stay intact).

The OSS-recommended default for chaining work is `create_task_in_project`
(file a follow-up task and let your normal drain process pick it up). Reach
for `agent_session_dispatch` only when the classification must run **inside
an already-running session** that the task system cannot address — and an
HTTP `webhook_post` to a local control endpoint is the wrong shape for your
target.

## Predicate notes — the `source.jobSize` gap

The router predicate language (`where:` block) cannot match on
`wsjf_source.jobSize`: the `source` predicate operator matches
`metadata.source` (`user | workflow`), not the task's WSJF provenance field.
Accordingly the rule fires on **any** `task.created` event whose `assignee`
matches. The sizing session is responsible for calling `get_task` first and
exiting early (idempotently) if `wsjf_source.jobSize` is not `'auto'` — for
example because the creator supplied a full `wsjf_submission` at create time.

The predicate trio this recipe is designed for is therefore stated explicitly:

1. **Event:** `task.created`
2. **Assignee predicate:** the task's `assignee` field equals an agent-type
   identity string (exact string match against `where.assignee`; a
   missing/null assignee fails the operator and the rule does not fire).
3. **`source.jobSize == 'auto'`:** checked at session start via `get_task`,
   not by the router. The rule fires unconditionally on the matching assignee;
   the session self-gates on the provenance flag.

## The sample `triggers.yaml`

This file validates against the wft-router schema as-is. Drop it in your
config path and run `wft-router --validate <path>` to confirm.

```yaml
version: 1

defaults:
  debounce_ms: 0           # task.created is a one-shot; no burst to debounce
  idempotency_window_s: 3600
  max_dispatches_per_minute: 30
  max_retries: 3

rules:
  # When a task is created and assigned to an agent-type identity,
  # dispatch a sizing session so the agent can submit a full WSJF
  # classification (closing the auto-sized job-size-only gap).
  - name: auto-sized-task-needs-full-wsjf
    on: task.created
    where:
      project: your-project-id          # replace with your project slug or id
      assignee: your-agent-identity     # exact string match on task.assignee
    do: agent_session_dispatch
    with:
      adapter: local-command            # your adapter name, resolved via WFT_ROUTER_ADAPTERS_PATH
      target: your-agent-session        # opaque to the router; meaningful to your adapter
      prompt: "{{task.id}}"
```

### What each field does

- `version: 1` — schema version; the only supported value today.
- `defaults` — per-rule knobs every rule inherits unless it overrides them.
  - `debounce_ms: 0` — `task.created` fires once per task; no quiet window
    needed. Defaults vary per installation; set this explicitly so a global
    default does not swallow the signal.
  - `idempotency_window_s` — how long a dispatched event key is remembered,
    so a reconnect/replay does not double-fire the sizing session.
  - `max_dispatches_per_minute` — per-rule rate cap.
  - `max_retries` — attempts before the dispatch is dead-lettered.
- `rules[].name` — a stable, human-readable rule id (appears in logs and is
  half of the idempotency primary key).
- `rules[].on: task.created` — fires on every task-creation event, not on
  subsequent status changes.
- `rules[].where.project` — scope to one project; omit to match across all
  projects the router token can see (broad — use with care).
- `rules[].where.assignee` — the exact string the task's `assignee` field
  must equal. A task created without an assignee, or with a different
  assignee, silently skips this rule.
- `rules[].do: agent_session_dispatch` — invokes a user-supplied adapter
  executable (see adapter contract below).
- `rules[].with.prompt: "{{task.id}}"` — passes the task id to your adapter
  as `prompt=<id>` in argv. The session uses it to call `get_task` and read
  `wsjf_source.jobSize` before deciding whether to proceed.

## What the sizing session should do

The session receives the task id and is responsible for the full WSJF
classification lifecycle. The authoritative tool names are from
[docs/MCP.md](../MCP.md):

1. **Gate on provenance.** Call `get_task` with the task id. Inspect
   `wsjf_source.jobSize`. If it is not `'auto'`, exit without writing —
   the task was already classified or manually sized at create time.

2. **Classify.** Read the task title, description, tags, project charter
   (from `get_project`), and any dependency graph (`get_dependencies`) to
   reason about Business Value, Time Criticality, Risk/Opportunity, and
   Job Size. This is the step that requires judgment; the server never
   performs it.

3. **Submit.** Call `update_task` with a `wsjf_submission` payload
   containing:
   - `classification` — the LLM-emitted classification:
     - `themeName` (string or null)
     - `alignment` (`none | weak | direct | core`)
     - `severity` (`none | tech_debt | security | data_loss | compliance`)
     - `decay` (`flat | slow | fast` or null)
     - `jobSizeTier` (Fibonacci tier: `1 | 2 | 3 | 5 | 8 | 13`)
     - `evidence` — verbatim source spans, one per component:
       `value`, `timeCriticality`, `riskOpportunity`, `jobSize`
   - `features` — deterministic inputs gathered by the session:
     - `deadlineDate` (ISO 8601 or null)
     - `daysUntilDeadline` (number or null)
     - `transitiveDependents` (count)
     - `filesTouched` (number or null)
     - `charterVersion` (number or null)

   The server runs its validation gate against the submission. A
   `jobSizeBand` keyword tag on the task clamps the final `jobSizeTier`
   to a defined range — the session does not need to know the band; the
   server enforces it.

4. **Verify.** Confirm the returned task now carries non-null CoD
   components via `get_task`. Call `wsjf_health` on the project to
   confirm the `auto-sized-pending` finding count decreased.

The `update_task` call is the standard mutation surface, not a
sizing-specific endpoint. Any caller that can reach the MCP server (local or
remote) or the REST API (`PATCH /api/v1/tasks/:id`) can submit a
`wsjf_submission` using the same shape.

## Idempotency and safety

- **Router-level deduplication.** The idempotency primary key is
  `(rule_name, event_id)`. A replayed `task.created` event (SSE reconnect,
  crash recovery) does not re-invoke the adapter if the row already reached
  `SUCCEEDED`.
- **Session-level self-gate.** The `get_task` check in step 1 ensures the
  session never overwrites a manual or classified size. If the sizing session
  crashes after submitting but before the router records `SUCCEEDED`, a
  restart re-fires the adapter; the session's `get_task` probe will see the
  already-submitted classification and exit cleanly.
- **No Cost-of-Delay components are ever fabricated by the server.** The
  auto-sized `wsjf_job_size` value set at create time is a deterministic
  prior, not a CoD score. The session's `wsjf_submission` is the only path
  to full classification; `rescore_project` does not backfill auto-sized
  tasks (it only rescores already-scored ones).
- **`wsjf_health` visibility.** Until the session submits, the task appears
  in the `auto-sized-pending` finding of `wsjf_health`. This is intentional:
  auto sizes are a routing prior, kept visible and refinable, never silent.

## Adapter contract (summary)

For the normative adapter contract see
[persistent-agent-sessions.md](./persistent-agent-sessions.md) and
[event-router-design.md](../event-router-design.md). Key points for this
recipe:

- The task id arrives as `prompt=<id>` in argv (the `with.prompt` value
  rendered and passed as one `key=value` argv entry).
- The full event JSON (the `task.created` payload including all task fields)
  arrives on **stdin** — the adapter can read it directly rather than calling
  `get_task` for the initial data, then re-check `wsjf_source.jobSize` from
  the live API before submitting to avoid a race with a concurrent update.
- Exit `0` on success; non-zero triggers retry per `max_retries`.
- The adapter runs with a scrubbed environment (`PATH`, `HOME`, `LANG`, `TZ`,
  plus any `env:` block and `token_env` the rule declares). The router's
  `WFT_API_KEY` is **not** inherited; pass a dedicated write-scoped token via
  `token_env` if your adapter needs to call the API.

## Validating before you deploy

```sh
wft-router --validate path/to/triggers.yaml
```

It prints `triggers.yaml validation OK.` and exits `0` on success, or a
list of `  - <path>: <message>` lines and exits `78` on a schema or
templating violation. Validate in CI so a malformed rule never ships.

## See also

- [persistent-agent-sessions.md](./persistent-agent-sessions.md) — the
  sibling recipe: drive a long-lived session with the full adapter contract,
  session-id round-trip, and restart semantics.
- [claude-routines.md](./claude-routines.md) — dispatch a routine on task
  close; covers `webhook_post` as an HTTP alternative.
- [event-router-design.md](../event-router-design.md) — design of record:
  predicate language, handler table, templating rules, at-least-once
  protocol.
- [MCP.md](../MCP.md) — authoritative tool names and input schemas,
  including `update_task` (`wsjf_submission` field), `get_task`,
  `wsjf_health`, and `wsjf_ranking`.
