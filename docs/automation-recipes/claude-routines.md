# Recipe: dispatch a routine on task close
Owner: Repository maintainers

This recipe shows how to wire a **routine** — a multi-step follow-up that
runs whenever a task reaches a terminal state — using only the
vendor-neutral core handlers shipped by `wft-router`. It composes the
existing primitives; it does **not** introduce a new handler.

You will use two of the four core handlers:

- [`agent_session_dispatch`](../event-router-design.md) — hands the event
  off to a user-supplied **adapter executable** that knows how to address
  your persistent agent session. The router stays ignorant of what a
  "session" is or how to reach it.
- [`shell_exec`](../event-router-design.md) — an escape hatch that runs any
  executable on `PATH`, feeding it the event JSON on stdin.

Neither handler names a provider. Substitute your own project id, session
target, and adapter throughout — the placeholders below (`your-project-id`,
`your-session`, `local-command`) are illustrative only.

## When to reach for this

The OSS-recommended default for chaining work is `create_task_in_project`:
file a follow-up task and let whatever already drains your backlog (a
person, a loop runner, a cron job, another agent) pick it up. Zero new
infrastructure.

Reach for `agent_session_dispatch` / `shell_exec` only when the follow-up
must run **outside** the task system — a long-lived agent session, a local
build runner, an `ssh`/`kubectl exec` push, a scheduled-task trigger — and
an HTTP `webhook_post` is the wrong shape for the target.

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
  # Hand the closed task off to a persistent agent session via your adapter.
  - name: closed-task-dispatches-routine
    on: task.status_changed
    where:
      project: your-project-id
      to_status: closed
      tags_contains_all: [routine]
    do: agent_session_dispatch
    with:
      adapter: local-command
      target: your-session
      prompt: "{{task.title}}"

  # Same trigger, alternative wiring: run a local routine script that reads
  # the full event JSON from stdin. Nothing here is templated into argv.
  - name: closed-task-runs-routine-script
    on: task.status_changed
    where:
      project: your-project-id
      to_status: closed
      tags_contains_any: [routine, batch]
    do: shell_exec
    with:
      command: run-routine
      cwd: /srv/routines
      env:
        ROUTINE_MODE: dispatch
```

### What each field does

- `version: 1` — schema version; the only supported value today.
- `defaults` — per-rule knobs every rule inherits unless it overrides them.
  - `debounce_ms` — quiet window before a matched event dispatches, so a
    burst of edits collapses into one fire.
  - `idempotency_window_s` — how long a dispatched event key is remembered,
    so a reconnect/replay does not double-fire.
  - `max_dispatches_per_minute` — per-rule rate cap.
  - `max_retries` — attempts before the dispatch is dead-lettered.
- `rules[].name` — a stable, human-readable rule id (appears in logs).
- `rules[].on` — the event type to match (`task.status_changed` here).
- `rules[].where` — the predicate block. `to_status` matches the
  destination status on a status-change event; `tags_contains_all` /
  `tags_contains_any` gate on task labels so only routine-tagged tasks fire.
- `rules[].do` — the handler name.
- `rules[].with` — the handler payload (open per-handler shape).

## How the `agent_session_dispatch` adapter is invoked

`agent_session_dispatch` is the extension point for non-HTTP targets. The
router resolves your `adapter:` name to an executable and invokes it; the
adapter does the provider-specific delivery.

**Adapter contract** (see
[event-router-design.md](../event-router-design.md) for the normative
text):

- **Discovery.** `adapter:` must match `^[a-z][a-z0-9_-]*$`. The router
  resolves it by `basename` against the directories listed in
  `WFT_ROUTER_ADAPTERS_PATH` (empty by default — adapters are strictly
  opt-in). Symlinks escaping your adapter directory are refused at load
  time. Each adapter directory must be owned by the router user with mode
  `≤ 0755`.
- **Input.** The event JSON arrives on **stdin** — never spliced into
  argv. Every `with:` key (other than `adapter`) is passed as one
  additional argv entry shaped `key=value`. Key names must match
  `^[a-z][a-z0-9_]*$`. You are free to invent keys (`target=`, `session=`,
  `prompt=`, `channel=`, …) to thread addressing and payload through; the
  router does not interpret them — your adapter does.
- **Output.** Exit `0` means success; any non-zero exit is a failure that
  surfaces on the handler-error metric and triggers a retry per
  `max_retries`.
- **Env policy.** Adapters run with a **scrubbed environment**: only
  `PATH`, `HOME`, `LANG`, `TZ`, the rule's own `token_env` (if declared),
  and any `env:` block the rule explicitly sets. Every other secret-bearing
  env var referenced elsewhere in `triggers.yaml` is removed from the child
  environment — least privilege per rule.
- **Adapter responsibilities.** Adapters MUST NOT `eval` argv; MUST treat
  every argv value as an untrusted string; MUST NOT expand env vars from
  event content; SHOULD validate length and charset before using a value in
  a shell command. A malicious task title is a trust-elevation vector — the
  wood-fired-tasks instance is the trust root for task content.

For a full walkthrough of writing an adapter (POSIX, cross-platform, and
Windows variants), see the reference adapters under your `examples/adapters/`
directory.

## How `shell_exec` differs

`shell_exec` runs a named executable on `PATH` directly — no adapter
indirection. The event JSON arrives on stdin exactly as it does for an
adapter. Critically, **templating is not applied** to `command`, `argv`,
`cwd`, or `env:` keys/values: the payload only ever reaches your script via
stdin, never through argv interpolation. Parse stdin in your script; do not
expect substituted values on the command line.

Use `shell_exec` when the target is a plain local command and you do not
need the adapter discovery/charset machinery. Use `agent_session_dispatch`
when you want the router to resolve a named, opt-in adapter and pass the
`with:` keys through as `key=value` argv entries.

## Validating before you deploy

```sh
wft-router --validate path/to/triggers.yaml
```

It prints `triggers.yaml validation OK.` and exits `0` on success, or a
list of `  - <path>: <message>` lines and exits `78` on a schema or
templating violation. Validate in CI so a malformed rule never ships.

## See also

- [event-router-design.md](../event-router-design.md) — the design of
  record: handler table, predicate language, templating rules, and the full
  `agent_session_dispatch` extension contract.
