# Recipe: drive a persistent agent session
Owner: Repository maintainers

This recipe shows how to keep a **long-lived agent session** in the loop —
feeding it follow-up work whenever a task changes state — using only the
vendor-neutral `agent_session_dispatch` core handler shipped by
`wft-router`. It composes existing primitives; it introduces **no new
handler**.

A "persistent agent session" here is any process that outlives a single
dispatch and is addressable by a stable identifier: a terminal multiplexer
pane, an HTTP control endpoint, a named pipe, an `ssh`/`container-exec`
target, a scheduled-task trigger. The router stays ignorant of which one
you run. It resolves your `adapter:` name to an executable and invokes it;
**your adapter** does the provider-specific delivery and prints back a
session identifier.

This is the sibling page to
[claude-routines.md](./claude-routines.md) — read that first if you want the
broader "dispatch a routine on task close" framing. This page zooms in on
the three things that matter for a *persistent* target: the **session-id
round-trip**, **restart semantics**, and **idempotency-store
interactions**.

## When to reach for this

The OSS-recommended default for chaining work is `create_task_in_project`:
file a follow-up task and let whatever already drains your backlog pick it
up. Reach for `agent_session_dispatch` only when the follow-up must run
**inside an already-running session** that the task system cannot address —
and an HTTP `webhook_post` is the wrong shape for the target.

## The sample `triggers.yaml`

This file validates against the wft-router schema as-is. Drop it in your
config path and run `wft-router --validate <path>` to confirm.

```yaml
version: 1

defaults:
  debounce_ms: 1500
  idempotency_window_s: 3600
  max_dispatches_per_minute: 30
  max_retries: 3

rules:
  # Push a closed task into a persistent agent session via your adapter.
  - name: closed-task-feeds-session
    on: task.status_changed
    where:
      project: your-project-id
      to_status: closed
      tags_contains_all: [session]
    do: agent_session_dispatch
    with:
      adapter: local-command
      target: your-session
      prompt: "{{task.title}}"

  # A long-running task entering progress wakes the same session, keyed on a
  # different channel so your channel map can route it independently.
  - name: in-progress-task-wakes-session
    on: task.status_changed
    where:
      project: your-project-id
      to_status: in_progress
      tags_contains_any: [session, watch]
    do: agent_session_dispatch
    with:
      adapter: local-command
      target: your-session
      channel: your-channel-map
      prompt: "{{task.id}}"
```

### What each field does

- `version: 1` — schema version; the only supported value today.
- `defaults` — per-rule knobs every rule inherits unless it overrides them.
  - `debounce_ms` — quiet window before a matched event dispatches, so a
    burst of edits collapses into one fire.
  - `idempotency_window_s` — how long a dispatched event key is remembered,
    so a reconnect/replay does not double-fire (see below).
  - `max_dispatches_per_minute` — per-rule rate cap.
  - `max_retries` — attempts before the dispatch is dead-lettered.
- `rules[].name` — a stable, human-readable rule id (appears in logs and is
  half of the idempotency primary key).
- `rules[].on` — the event type to match (`task.status_changed` here).
- `rules[].where` — the predicate block. `to_status` matches the
  destination status; `tags_contains_all` / `tags_contains_any` gate on
  task labels so only session-tagged tasks fire.
- `rules[].do` — the handler name (`agent_session_dispatch`).
- `rules[].with` — the handler payload. `adapter:` is mandatory; every other
  key (`target`, `channel`, `prompt`, …) is yours to invent — the router
  passes each through to your adapter as one `key=value` argv element.

## How the adapter is invoked

`adapter:` must match `^[a-z][a-z0-9_-]*$`. The router resolves it by
`basename` against the directories listed in `WFT_ROUTER_ADAPTERS_PATH`
(empty by default — adapters are strictly opt-in). A symlink whose target
escapes your adapter directory is refused at load time; each adapter
directory must be a directory owned by the router user and is skipped if it
is group/world-writable.

- **Input.** The event JSON arrives on **stdin** — never spliced into argv.
  Every rendered `with:` key other than `adapter` is passed as one argv
  entry shaped `key=value` (key names must match `^[a-z][a-z0-9_]*$`). Each
  pair is a *single* argv element, so a malicious rendered value cannot
  inject extra argv entries — that is the injection boundary.
- **Env policy.** Adapters run with a **scrubbed environment**: only `PATH`,
  `HOME`, `USER`, `LANG`, `TZ`, the rule's own `token_env` (if declared),
  and any `env:` block the rule explicitly sets. Every other secret-bearing
  env var referenced elsewhere in `triggers.yaml` is removed — least
  privilege per rule.
- **Adapter responsibilities.** Adapters MUST NOT `eval` argv; MUST treat
  every argv value as an untrusted string; MUST NOT expand env vars from
  event content; SHOULD validate length and charset before using a value.
  A malicious task title is a trust-elevation vector — the upstream project
  is the trust root for task content.

## Session-id round-trip

This is the part unique to persistent targets. After your adapter delivers
the prompt to its session, it MAY print a **session identifier** on stdout.
The handler captures it — first line, trimmed, capped at 512 chars — and
surfaces it two ways: in the dispatch handler's optional `sessionId` outcome
field, and in the (redacted) structured success log line
(`agent_session_dispatch_succeeded`).

The session id is only known **after** the adapter exits — but the
idempotency row is claimed **before** the adapter is spawned. So the id does
not change the claimed row. The round-trip *is* the existing
`claim → complete` lifecycle: the `(rule_name, event_id)` row transitions
`PENDING → SUCCEEDED`, and the captured session id rides alongside that
terminal outcome. The session id is adapter-emitted and therefore untrusted;
it is redacted before it reaches the log.

Practically: print one line — your session's stable handle — as the first
thing your adapter writes on a successful delivery, then exit `0`. Anything
after the first newline is ignored for the session-id capture.

## Restart semantics

`wft-router` is meant to run under an orchestrator (systemd, a container
runtime, a service manager, launchd) that restarts it. The dispatch state
machine is persisted to a local SQLite idempotency store
(`journal_mode=WAL`, `synchronous=NORMAL`), so a restart does **not** lose
in-flight dispatch state.

On startup the router runs crash reconciliation:

- Every `PENDING` row still **within** `idempotency_window_s` is re-fired —
  this is the at-least-once guarantee. If your adapter crashed mid-delivery,
  the dispatch replays after restart.
- Every `PENDING` row **older** than the window is abandoned (marked
  terminal) with a WARN — it will *not* replay.
- Rows already in a terminal state (`SUCCEEDED` / `FAILED` /
  `PERMANENTLY_FAILED`) are **not** re-fired.

The practical consequence for a persistent session: design your adapter to
be **idempotent on replay**. A restart that happens between "adapter
delivered the prompt" and "router wrote `SUCCEEDED`" will re-invoke the
adapter with the same event. Make a duplicate prompt to the same session
harmless (e.g. key on `task.id`, or no-op if the session already saw it).

## Idempotency-store interactions

The store dedups dispatches so an SSE reconnect or replay never double-fires
a session.

- **Primary key:** `(rule_name, event_id)`. Suppresses redelivery of the
  same event. The handler `claim()`s this key before spawning your adapter;
  if a terminal row already exists the dispatch is **suppressed** (no
  adapter invocation), and if a `PENDING` row exists another worker owns it.
- **Secondary key (defense in depth):** `(rule_name, task_id, to_status,
  emitted_at_minute)`. Coalesces redelivery when the upstream event lacks a
  stable `event_id`, *without* collapsing a legitimate
  `closed → reopened → closed` cycle that straddles a minute boundary.
- **Window tuning.** Want fire-**once-per-task-ever** for a session? Raise
  `idempotency_window_s` and lean on the primary key. Want a routine that
  can re-fire each time a task re-enters a status? Keep the window short.
- **Failure → retry.** A non-zero adapter exit marks the row `FAILED` and is
  retried up to `max_retries` (exponential backoff); exhausted retries
  become `PERMANENTLY_FAILED` and unblock the per-rule cursor. A
  bad-adapter-name, missing adapter, or bad `with:` key is a terminal config
  error (`PERMANENTLY_FAILED`, non-retryable).

## Validating before you deploy

```sh
wft-router --validate path/to/triggers.yaml
```

It prints `triggers.yaml validation OK.` and exits `0` on success, or a
list of `  - <path>: <message>` lines and exits `78` on a schema or
templating violation. Validate in CI so a malformed rule never ships.

## See also

- [claude-routines.md](./claude-routines.md) — the sibling recipe: dispatch
  a routine on task close, with the full adapter discovery/charset contract
  and the `shell_exec` alternative.
- [event-router-design.md](../event-router-design.md) — the design of
  record: handler table, predicate language, templating rules, the
  at-least-once dispatch protocol, and the full `agent_session_dispatch`
  extension contract.
- [MCP.md](../MCP.md) (`wait_for_unblock` tool) — the single-turn,
  in-process counterpart: if the agent can hold one MCP connection open for
  the wait (sub-30-minute, no failover) rather than going away and being
  re-spawned, block inside one call instead of wiring a dispatch rule here.
