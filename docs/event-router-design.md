Owner: Repository maintainers

# Event-Driven Automation (`wft-router`) Design Spec

> **Companion artifacts:** none yet. This document is the design-of-record
> for the *event-router* layer that turns `task.status_changed` events into
> declarative side-effects. The runtime, config schema, and action handlers
> described here have not been built yet — see Status.

## Status

**DRAFT, post-review-cycle** (2026-05-28). No code shipped. This document
incorporates feedback from three parallel reviews: a codebase-fit review
against the existing event/SSE/dependency primitives, a security/operations
review of the threat model and at-least-once semantics, and an external
vendor-neutrality review (codex). Where this spec and any future
implementation drift, the design doc wins until explicitly superseded.

## Why this exists

wood-fired-tasks already ships the primitives an event-driven automation
layer needs:

- **An internal `EventBus`** (`src/events/event-bus.ts`). Two real
  subscribers exist today (`SSEManager` broadcast in `src/api/server.ts`
  and `SlackNotifier` in `src/slack/notifier.ts`); the dependency-cascade
  driver (`src/services/workflow-engine.ts`) is a bypass subscriber that
  runs synchronously on emit. The bus is explicitly designed to host more
  external subscribers — `wft-router` would be the third long-lived one.
- **An authenticated SSE stream** at `GET /api/v1/events`
  (`src/api/routes/events.ts:78` parses the `event_types` filter; line
  149 reads `last-event-id`; `src/events/sse-manager.ts:62–67` enforces
  per-key/per-IP/global connection caps and `replayEvents` provides
  resume on reconnect).
- **A `task.status_changed` event** (`src/events/types.ts`) emitted on
  every transition routed through `TaskService.updateTask`
  (`src/services/task.service.ts:281`), **including** the workflow-driven
  `blocked → open` auto-unblock fired by the dependency engine
  (`src/services/workflow-engine.ts:270`). The runtime payload extends
  `EventPayload<Task & { tags }>` with two extra fields (`metadata.from`
  and `metadata.to`) emitted from `task.service.ts:287–291` — the router
  will see them and the predicate schema accepts them.
- A separate **`task.claimed`** event (`task.service.ts:361–400`) is the
  only signal for atomic claim transitions (`open → in_progress`). Rules
  that need to fire on claim subscribe to `task.claimed`; `task.status_changed`
  does NOT fire for claim. The full status set is `open | in_progress |
  done | closed | blocked | backlogged` (`src/types/task.ts:2`).

What's missing is a **declarative bridge** from those events to actions
the user actually wants: kick a CI run, file a task in a downstream
project, ping a chat channel, run a shell command, dispatch a `/tasks:loop`
to an agent. Today the only way to act on a task event is to write a
custom SSE subscriber from scratch.

This spec describes **`wft-router`**: a standalone subscriber daemon
configured by a `triggers.yaml` file, with **pluggable action handlers**
ranked by universality so an OSS user with no special infrastructure
gets a useful default path on day one, while a power user with persistent
agent sessions gets the same primitive aimed at their local topology.

The implementation template for "subscribe to bus, look up rules,
fan-out to handlers" already exists in-repo: `src/slack/notifier.ts:47–95`
iterates `TASK_EVENT_TYPES`, subscribes per type, looks up matching
subscriptions in a `better-sqlite3` repository, and dispatches via
`Promise.allSettled` with per-handler error isolation. `wft-router`
mirrors that shape for external (SSE-driven) consumers.

### Concrete motivating scenario

A cross-project bug chain that today requires manual hand-offs:

1. An agent in `project-brogue` discovers a bug requiring an epic in
   `wood-fired-engine`.
2. When the engine epic closes, `wood-fired-platform` needs to bump the
   engine version and redeploy.
3. When the platform redeploy closes, `project-brogue` should resume
   draining its backlog.

The causal chain is naturally expressed as cross-project task
**dependencies**, which wood-fired-tasks already supports. The missing
piece is the **side-effect of "the next step just became actionable"** —
emitting a signal that some agent / workflow / human should pick the
work up. `wft-router` provides exactly that signal as a configurable
side-effect of `task.status_changed`.

The same shape applies to dozens of bread-and-butter automations: notify
when a task is stuck, auto-assign on label, fan out CI on PR-merged,
mirror task events into a metrics pipeline. The design is intentionally
not specific to the brogue/engine/platform chain.

## Contract

```yaml
name: wft-router
binary: bin/wft-router (Node, ships from this repo)
inputs:
  --config <path>          # default: platform app-config dir (see below)
  --endpoint <url>         # default: $WFT_API_URL or http://localhost:3000
  --token <env-var-name>   # default: WFT_API_KEY (PAT or legacy key — see Auth)
  --validate               # parse + schema-check config; exit 0/2 without connecting
  --dry-run                # connect + log matches; never dispatch any handler
  --once                   # process the current event buffer then exit
  --metrics-port <n>       # disabled by default; binds 127.0.0.1 unless --metrics-bind
  --metrics-bind <addr>    # default: 127.0.0.1 (no public bind by default)
  --rebuild-idempotency    # rebuild a corrupt idempotency store; requires
                           # --confirm-redispatch to acknowledge the redispatch risk
  --replay --since <ts>    # post-v1 follow-on; not in v1
outputs:
  - structured logs (pino JSON) on stdout — matches repo logger convention
  - <state-dir>/cursor                (Last-Event-Id, persisted post-success)
  - <state-dir>/dispatch.log          (one row per dispatched action)
  - <state-dir>/idempotency.sqlite    (better-sqlite3, WAL mode)
exit codes (match repo convention — sysexits.h-style):
  0   clean shutdown (SIGTERM / SIGINT)
  78  config invalid (EX_CONFIG — same as the existing server; src/config/env.ts)
  3   auth failed at startup (401/403 on initial /events handshake)
  4   endpoint unreachable after backoff exhausted (>=15 min)
  5   idempotency store corrupted; rerun with --rebuild-idempotency
```

**Platform-neutral default paths.** Defaults follow the host's app-data
conventions, resolved at startup:

| Platform        | Config dir                              | State dir                              |
|-----------------|-----------------------------------------|----------------------------------------|
| Linux / BSD     | `$XDG_CONFIG_HOME/wft-router` (fallback `~/.config/wft-router`) | `$XDG_STATE_HOME/wft-router` (fallback `~/.local/state/wft-router`) |
| macOS           | `~/Library/Application Support/wft-router` | `~/Library/Application Support/wft-router/state` |
| Windows         | `%APPDATA%\wft-router`                  | `%LOCALAPPDATA%\wft-router\state`      |

All paths are overridable by `--config` / env vars (`WFT_ROUTER_CONFIG`,
`WFT_ROUTER_STATE_DIR`). No path on any platform is hard-coded as
normative.

The daemon is **stateless apart from the resume cursor + idempotency
store**. Restarting it with the same config + state directory yields the
same behaviour. The token configured via `--token` (default `WFT_API_KEY`)
must have read access to the targeted projects' events stream; **no
write permissions are needed by the daemon itself** — write actions
(e.g. `create_task_in_project`) use a *separate* token configured per
rule (`token_env:` field), so a least-privilege deployment can scope the
subscriber tightly.

### Auth wire format

`WFT_API_KEY` is read at startup; the auth-header rule matches the
existing repo convention (`src/mcp/remote/rest-client.ts:80–84`):

- If the value begins with `wft_pat_`, send `Authorization: Bearer <value>`.
- Otherwise send `X-API-Key: <value>` (legacy-key compatibility).

PATs are minted via the existing `/me/tokens` flow or `tasks db mint-token`.

## Trigger config schema

```yaml
# triggers.yaml — v1
version: 1
defaults:                  # applied to every rule unless overridden
  debounce_ms: 1500
  idempotency_window_s: 3600
  max_dispatches_per_minute: 60
  max_retries: 3

rules:
  - name: engine-epic-closed-kicks-platform
    on: task.status_changed
    where:                  # structured AND-predicate; no eval, no shell
      project: wood-fired-engine
      status: closed
      tags_contains_all: [epic, bug-fix]
    do: create_task_in_project
    with:
      project: wood-fired-platform
      title: "Bump engine to v{{task.metadata.released_version}} and redeploy"
      body: "Auto-filed by wft-router on engine epic {{task.id}} closing."
      depends_on_external: { project: wood-fired-engine, task_id: "{{task.id}}" }
      labels: [auto-filed, redeploy]
      token_env: WFT_API_KEY_PLATFORM_WRITER
```

Schema validation reuses `ALLOWED_EVENT_TYPES` and `isAllowedEventType`
from `src/events/types.ts` (zod `z.enum(ALLOWED_EVENT_TYPES)`). Unknown
top-level keys, unknown handler names, unknown predicate operators, and
unknown event types are validation errors at startup → exit 78.

### Predicate language

Filters are a **closed set of operators**, evaluated as a deep AND. There
is no `eval`, no string interpolation in predicates, and no user-supplied
host-language code.

| Operator                | Type                                  | Semantic                                          |
|-------------------------|---------------------------------------|---------------------------------------------------|
| `project`               | string \| number                      | Match by project slug or numeric id               |
| `status`                | one of `open\|in_progress\|done\|closed\|blocked\|backlogged` | Match `task.status` exactly |
| `status_in`             | array of the above                    | Any of                                            |
| `from_status`           | as above                              | Match `metadata.from` (only present on `task.status_changed`) |
| `to_status`             | as above                              | Match `metadata.to` (only present on `task.status_changed`)   |
| `tags_contains_all`     | string[]                              | Every tag must be present                         |
| `tags_contains_any`     | string[]                              | At least one tag must be present                  |
| `task_id`               | number                                | Match a specific task                             |
| `parent_id`             | number                                | Match by parent task                              |
| `assignee`              | non-empty string                      | Match the task's assignee exactly; a missing/null assignee on the event fails the operator |
| `source`                | `user \| workflow`                    | `metadata.source` — useful for dependency-unblock-only rules |
| `eventType`             | one of `ALLOWED_EVENT_TYPES`          | Redundant with `on:` but allowed for explicitness |

`metadata.actor` is declared in the type but is **not populated by the
emit path today** (`task.service.ts` passes `metadata: { source }` only).
A v1 router will not expose an `actor` predicate; a follow-on task can
thread `actor` through the auth principal and add the operator without a
schema break.

### Templating

Action `with:` blocks accept `{{task.<jsonpath>}}` substitutions resolved
against the event payload at dispatch time. Substitution rules — these are
the security boundary for every handler other than `shell_exec` / adapter:

1. **Substitution position.** Substitutions MUST appear at bare JSON
   value positions in the rendered template (i.e. the YAML author writes
   `title: {{task.title}}`, not `title: "prefix-{{task.title}}-suffix"`).
   The validator rejects templates where `{{...}}` appears inside a
   quoted YAML string at parse time. Concatenation is achieved by
   composing the JSON value upstream, not by string-splicing in the
   template.
2. **Encoding.** Values are JSON-encoded before substitution, so a `"`
   in a task title cannot escape its containing string.
3. **Length cap.** Substituted values exceeding 4 KiB are truncated to
   `<head>…<tail>` (2 KiB + 2 KiB), with a WARN logged. The cap
   prevents a 1 MB task body from becoming a 1 MB webhook payload.
4. **Chat-handler control characters.** Handlers that render to Slack
   / Discord / similar chat surfaces MUST strip the chat-specific
   broadcast prefixes (`<!`, `<@`, `<#`) from substituted values so a
   malicious task title can't `@channel`-ping an org.
5. **Null on miss.** If a JSONPath misses, the substitution is the
   literal string `null` and a WARN is logged.
6. **Sensitive-key redaction (logs).** When a rule's `with:` includes
   keys matching `(?i)token|secret|password|api[_-]?key|authorization|
   cookie`, those values are redacted to `***` in both stdout logs and
   the persisted dispatch.log. The redaction is on key name, not value
   content.

A malicious task title is treated as a **trust-elevation vector** into
any handler with a templated string field; the wood-fired-tasks instance
is the trust root for task content.

## Action handlers — the pluggable layer

This is the vendor-neutrality story. Three universal handlers ship in
the core; everything provider-specific is either a recipe using one of
the three or an external adapter the user supplies.

### Core handlers (v1)

| Handler                  | External dependency                  | Use                                                  |
|--------------------------|--------------------------------------|------------------------------------------------------|
| `create_task_in_project` | nothing beyond wood-fired-tasks      | **Recommended OSS default.** Files a task in the target project; whatever process picks tasks up there (human, `/tasks:loop`, cron, another agent) drives the chain. Zero new infrastructure required. |
| `webhook_post`           | an HTTP endpoint                     | Universal HTTP fan-out. The primitive for Slack/Discord/Zapier/n8n/IFTTT, GitHub `repository_dispatch`, GitLab pipeline triggers, Forgejo/Gitea/Bitbucket webhooks, Jenkins/Buildkite/CircleCI hooks, and any custom CI or HTTP receiver. Body and headers are templated under the rules above. |
| `shell_exec`             | any executable on `PATH`             | Escape hatch. Receives event JSON on stdin. Templating is **not** applied to `command`, `argv`, `cwd`, or `env:` keys/values — the payload reaches the script only via stdin, never via argv interpolation. |
| `agent_session_dispatch` | a user-supplied adapter executable   | Extension mechanism (see below). Strictly opt-in; the repo ships zero blessed adapters. |

That's it. No provider name appears in any handler identifier. Any
recipe a user might reach for ("kick GitHub Actions", "post to Slack",
"trigger my GitLab pipeline", "invoke a claude.ai routine", "ping
Discord") is a one-line `webhook_post` rule documented in the recipes
section, not a separate handler.

### Vendor-specific recipes (documentation only — not core handlers)

These are example rules using the three core handlers. Each lives in
`docs/automation-recipes/*.md`, none is a handler name.

- **GitHub `repository_dispatch`** — `webhook_post` to
  `https://api.github.com/repos/{owner}/{repo}/dispatches` with a Bearer
  PAT.
- **GitLab pipeline trigger** — `webhook_post` to
  `https://gitlab.example/api/v4/projects/{id}/trigger/pipeline`.
- **Forgejo / Gitea / Bitbucket webhooks** — `webhook_post` to the
  provider-specific URL.
- **Slack / Discord / Teams** — `webhook_post` to the channel webhook
  URL.
- **claude.ai routine invocation** — `webhook_post` to the
  RemoteTrigger endpoint (the same API a Claude Code routine uses to
  schedule itself); strictly an example, not blessed in core.
- **CI / Jenkins / Buildkite / CircleCI** — `webhook_post` against the
  provider's hook URL.

Two recipes get a dedicated walkthrough page in
`docs/automation-recipes/` because they involve more than a single HTTP
call: **`claude-routines.md`** (firing a claude.ai routine via
`webhook_post` to the RemoteTrigger API) and
**`persistent-agent-sessions.md`** (writing a `local-command` adapter
for any persistent local-agent topology — tmux send-keys, an HTTP
control endpoint, Windows Named Pipes, an ssh control socket, etc.).
Neither page introduces a new core handler; both compose the existing
`webhook_post` / `agent_session_dispatch` primitives.

### `agent_session_dispatch` — extension contract

For users whose dispatch target *isn't* HTTP-shaped (e.g. a persistent
local agent session addressable by some user-defined channel, an
`ssh`/`kubectl exec` push, a Windows scheduled task trigger), the
`agent_session_dispatch` handler invokes a user-supplied **adapter
executable**.

```yaml
do: agent_session_dispatch
with:
  adapter: local-command         # or: ssh-channel, container-exec, anything the user names
  target: wood-fired-platform    # opaque to the router; meaningful to the adapter
  prompt: "engine epic {{task.id}} closed — bump dependency and redeploy"
```

**Adapter contract:**

- **Discovery.** `adapter:` must match `^[a-z][a-z0-9_-]*$`; the router
  resolves it by `basename` against `$WFT_ROUTER_ADAPTERS_PATH` entries
  (default: empty — adapters must be explicitly opted in). Symlinks
  escaping the adapters dir are refused at load time. Each adapters-path
  entry must be a directory owned by the router user with mode ≤ 0755.
- **Input.** The event JSON arrives on stdin (no command-substitution
  into argv). The `with:` block's keys-and-rendered-values are passed
  as additional argv entries in the form `key=value`, one entry per key.
  `with:` key names must match `^[a-z][a-z0-9_]*$`. Authors are free to
  define arbitrary keys here — `target=`, `channel=`, `prompt=`,
  `session=`, anything matching the regex — to thread addressing,
  channel identity, and command payload through to the adapter. The
  router does not interpret these names; the adapter does. This is the
  user-facing extensibility lever — the contract is deliberately loose
  about what the adapter accepts.
- **Output.** Exit 0 = success; non-zero = failure (surfaces on the
  handler-error metric and triggers retry per `max_retries`).
- **Env policy.** The router invokes adapters with a **scrubbed
  environment**: only `PATH`, `HOME`, `LANG`, `TZ`, the rule's own
  `token_env` (passed through), and any `env:` block the rule explicitly
  declares. `WFT_API_KEY` and every other `*_token_env` referenced
  elsewhere in `triggers.yaml` are **removed** from the child env. This
  enforces least-privilege per rule even when shell handlers are in use.
- **Adapter responsibilities (documented requirements).** Adapters MUST
  NOT `eval` argv; MUST treat argv values as untrusted strings; MUST
  NOT expand env-vars from event content; SHOULD validate length and
  charset before using values in shell commands.

The repo ships **zero adapters by default**. The
`examples/adapters/` directory contains two cross-platform reference
adapters in the project's existing TypeScript runtime
(`stdin-logger.ts`, `webhook-bridge.ts`) plus thin POSIX (`.sh`) and
Windows (`.ps1`) peers demonstrating the contract — none are
provider-specific.

## Architecture

```
┌─────────────────────────┐    SSE (Bearer/X-API-Key, Last-Event-Id resume)
│   wood-fired-tasks API  │────────────────────────────────────────┐
│  /api/v1/events         │                                        │
│  EventBus + SSEManager  │                                        ▼
└─────────────────────────┘                          ┌──────────────────────────┐
                                                     │       wft-router         │
                                                     │  (this design — new)     │
                                                     │                          │
                                                     │  1. SSE client + resume  │
                                                     │  2. Config loader (zod)  │
                                                     │  3. Predicate evaluator  │
                                                     │  4. Debounce + idempot.  │
                                                     │  5. Rate limiter         │
                                                     │  6. Action dispatcher    │
                                                     │     (PENDING → DONE)     │
                                                     └────────────┬─────────────┘
                                                                  │
                       ┌──────────────────────────────────────────┼──────────────────────────┐
                       │                                          │                          │
                       ▼                                          ▼                          ▼
       create_task_in_project                       webhook_post                 agent_session_dispatch
       (recommended OSS default)                    (universal HTTP fan-out)     (user-supplied adapter)
                       │                                          │                          │
                       └─→ back into wood-fired-tasks             └─→ any HTTP receiver      └─→ stdin: event JSON
                           (the new task is itself a                  (CI, chat, dashboards,    argv: with-pairs
                            potential event source)                    other repos, providers)  scrubbed env
```

## Operational properties

### At-least-once dispatch protocol

Dispatch is a three-state machine persisted to `dispatch.log` (one row
per `(rule_name, event_id)`):

1. **`PENDING`** — written before the handler is invoked; includes the
   event id, rule, rendered `with:`, and start timestamp.
2. **`SUCCEEDED`** | **`FAILED`** | **`PERMANENTLY_FAILED`** — written
   after the handler returns. `FAILED` is retried up to `max_retries`
   (exponential backoff); `PERMANENTLY_FAILED` is terminal.

`fsync` is called between writing `PENDING` and invoking the handler,
and again before the cursor advances past a `SUCCEEDED`/`PERMANENTLY_
FAILED` row.

**Crash reconciliation.** On startup, every `PENDING` row within
`idempotency_window_s` is re-fired (at-least-once); rows older than the
window are abandoned with a WARN. The idempotency layer is consulted
first; if a *different* row for the same idempotency key has reached
`SUCCEEDED`, the `PENDING` row is closed as `SUPERSEDED` without
re-firing.

### Idempotency

Primary key: `(rule_name, event_id)`. Suppresses SSE re-delivery of the
same event after reconnect / replay.

Secondary key (defense in depth): `(rule_name, task_id, to_status,
emitted_at_minute)`. Coalesces re-delivery without a stable `event_id`
without collapsing legitimate `closed → reopened → closed` cycles that
straddle a minute boundary. Users who want "fire-once-per-task-ever"
semantics increase `idempotency_window_s` and lean on the primary key.

### Debounce

Per-rule `debounce_ms` collapses rapid status flaps. Debounce keys on
`(rule_name, task_id)` (so two flapping tasks under one rule don't
clobber each other). **The last event in the window is dispatched**
(matches user intent — "the latest status is the truth"); earlier
events in the window are merged into a single dispatch row with
`coalesced_count: N` in the log.

### Resume + cursor

`Last-Event-Id` header on reconnect. Cursor advances **per rule**:
`cursor = min(per-rule successful-event-id)` across rules. A handler
that's down indefinitely transitions its rule's events to
`PERMANENTLY_FAILED` after `max_retries`, unblocking the cursor for
that rule and emitting a `wft_router_permanently_failed_total`
Prometheus counter. Without per-rule cursors, a single misconfigured
rule would DoS the entire event pipeline.

Resume is **best-effort and bounded by the SSE server's retention
window** (the existing `/api/v1/events` event buffer; see
`src/events/sse-manager.ts`). If the server responds with HTTP 410 or
a documented gap signal on reconnect, the router logs `WARN
cursor_gap=...` and resumes from the head of the stream; operators
backfill via the post-v1 `wft-router replay --since <ts>` subcommand.

### Backoff + reachability

Exponential with jitter, max 60 s. Daemon exits 4 if the endpoint is
unreachable for 15 min so an orchestrator (systemd / Docker / Windows
Service Manager / launchd) can restart it.

### Rate limiting (outbound)

Per-rule `max_dispatches_per_minute` (default 60). When the limit trips,
surplus events are queued (bounded; default 1000 deep); over-queue
drops with a WARN and a `wft_router_rate_limit_dropped_total` counter.
`create_task_in_project` against the same wood-fired-tasks instance is
exempt because the server is the trust root for its own backpressure.

### Storage durability

The idempotency store is `better-sqlite3` opened with
`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL`. Synchronous
`better-sqlite3` matches the repo convention
(`src/db/database.ts`, `src/slack/repositories/`) and avoids async
surprises inside the EventBus handler tick.

On startup, a `SQLITE_CORRUPT` exit-5 with a clear message:
`run \`wft-router --rebuild-idempotency --confirm-redispatch\` to
acknowledge the burst-redispatch risk`. The router MUST NOT silently
rebuild an empty store, which would burst-redispatch the entire
backlog.

### Graceful shutdown

- SIGTERM / SIGINT: stop reading new SSE events immediately; allow
  in-flight dispatches up to `shutdown_grace_s` (default 30 s).
  Cursor advances only for events whose dispatches reach `SUCCEEDED` or
  `PERMANENTLY_FAILED`; the rest stay `PENDING` for the next restart.
- After grace: SIGTERM to handler subprocesses; after
  `subprocess_grace_s` (default 5 s), SIGKILL.
- A second SIGTERM during shutdown: immediate exit. Cursor not advanced.
  All in-flight rows stay `PENDING`.

### Observability

- Logs: pino JSON on stdout (matches the rest of the codebase,
  `src/api/server.ts:99`). `LOG_LEVEL` env var honoured.
- Metrics: optional Prometheus endpoint via `--metrics-port` (disabled
  by default). Binds `127.0.0.1` unless `--metrics-bind 0.0.0.0` is
  explicitly set; no built-in auth (the operator's reverse proxy owns
  that). Counters (all carry the `wft_router_` prefix in the exposition
  output, e.g. `wft_router_dispatched_total`): `events_received_total`,
  `events_received_by_kind_total` (labelled `{kind}` ∈ mappable / control /
  unmappable — control = server keep-alive pings, which prove the socket
  is alive but NOT that delivery works), `matched_rules_total`,
  `dispatched_total` (labelled `{handler,status}`), `handler_errors_total`
  (labelled `{handler}`), `rate_limit_dropped_total` (labelled `{rule}`),
  `permanently_failed_total` (labelled `{rule}`). Gauges:
  `wft_router_last_real_event_age_seconds` (seconds since the last
  MAPPABLE domain event; alert on it to catch a deaf-but-pinging stream)
  and `process_start_time_seconds` (standard Prometheus process-start
  convention, so operators can tell a fresh process's small counters from
  stale history). Opt-in self-heal: `--stale-resubscribe-after <s>` (or
  `WFT_ROUTER_STALE_RESUBSCRIBE_AFTER`) re-opens the SSE subscription —
  resume id preserved — when no real event arrived for `<s>` seconds
  while control pings kept flowing; 0/absent = disabled.
  Histograms (handler latency, debounce coalescing) are DEFERRED — the
  series above are what the `/metrics` endpoint currently exposes.

### Config validation

`triggers.yaml` is validated against a zod schema at startup (matches
`src/config/env.ts`). Any unknown top-level key, unknown handler,
unknown predicate operator, unknown event type, malformed token name,
or templating-in-quoted-string violation → exit 78 before connecting.
`--validate` runs the same path and exits without connecting (useful
in a dotfiles CI).

## Threat surface

What the router adds to the host's attack surface:

- **Network listeners.** None by default. `--metrics-port`, if enabled,
  binds `127.0.0.1` unless explicitly bound elsewhere.
- **Outbound connections.** SSE to `--endpoint` only; handlers add
  their own (each `webhook_post` URL, each `create_task_in_project`
  endpoint). TLS posture:
  - `--endpoint` scheme `https://` — certificate validation mandatory.
    No `--insecure` flag in v1.
  - `--endpoint` scheme `http://` — must resolve to loopback or
    RFC1918; otherwise refuse to start (exit 78). The PAT travels in
    `Authorization` on every reconnect; HTTP-with-PAT to a routable
    host is credential exposure.
  - **`http://` loopback/private guard is literal-host-only (no DNS
    resolution).** `assertEndpointAllowed` (shared by `webhook_post` and
    the SSE endpoint check) classifies the target by matching the literal
    host string in the URL — it does NOT resolve DNS. Three boundaries
    follow, intentional for v1:
    1. The `http://` → loopback/private decision is made on the literal
       URL host only. A public hostname that *resolves* to a private or
       loopback IP is not detected, and DNS-rebinding (TOCTOU on the
       resolved address) is **out of scope for v1**.
    2. `https://` egress to any routable host is **allowed by design** —
       the router is a webhook *sender*, and TLS removes the
       plaintext-credential-exposure concern that the `http://` guard
       exists to prevent.
    3. The guard's purpose is met: no PAT or handler token is ever sent in
       cleartext over `http://` to a routable host. It is not, and does not
       claim to be, a general SSRF egress firewall. Operators who need
       egress restriction should enforce it at the network layer. (If a
       resolve-and-recheck step is ever wanted, track it as a separate
       follow-on; it is deliberately not in v1.)
- **Subprocess env.** `shell_exec` and `agent_session_dispatch` child
  processes receive a *scrubbed* environment (PATH/HOME/LANG/TZ + the
  rule's own `token_env` + explicit `env:` block only). `WFT_API_KEY`
  and other rules' `token_env` values are stripped. This is the
  enforcement that backs the "least privilege per rule" claim.
- **On-disk state.** State directory is created with mode `0700`;
  `dispatch.log`, `cursor`, and `idempotency.sqlite` are mode `0600`.
  Rotation is the operator's responsibility (a `logrotate` example
  ships in `examples/deploy/`).
- **`triggers.yaml` trust posture.** Same footing as a systemd unit or
  a CI workflow file. Anyone who can edit it can run any handler with
  any handler-scoped token. The spec does not attempt to sandbox the
  config — it documents the requirement that the file be protected by
  filesystem permissions (mode `0600`, owned by the router user).

## Security model

The threat surface above + the templating rules in the schema section
above are the operational shape. Stated as a small set of guarantees:

- **No in-process eval.** Predicates are a closed operator set; templating
  is JSON-encoded string replacement; no user-supplied host-language code
  ever runs inside the router. Subprocess execution is opt-in per rule
  (`shell_exec`, `agent_session_dispatch`) and isolated by env scrubbing.
- **Per-rule token scoping is enforced, not aspirational.** The router's
  own PAT only needs `events:read` against the targeted projects. Each
  handler reads its own `token_env`. Subprocess handlers receive a
  scrubbed env so they cannot reach tokens from other rules.
- **`triggers.yaml` is security-sensitive trust input.** Documented
  explicitly: edit access is equivalent to ability to run any handler
  with any wired token. File mode `0600` enforced at startup.
- **Plaintext-PAT-over-the-internet is impossible.** TLS posture above
  enforces this at startup, not at runtime.
- **Allowlist parity with the existing surface.** The router's zod schema
  uses `z.enum(ALLOWED_EVENT_TYPES)` from `src/events/types.ts`. New
  event types added to the system flow into the router with a single
  edit.

## Deployment shapes

The canonical deployment is a **plain Node process** — anything that can
run Node 22 can host the router. Documented peer shapes (none privileged
over the others):

1. **Plain Node process** — `wft-router --config …`. Canonical; works on
   any OS with Node.
2. **OCI container** (`packages/wft-router/Containerfile`; see
   `examples/deploy/` for the build command + operator assets) — built with
   `docker build` / `podman build` / `buildah`; runs on any OCI runtime.
3. **systemd unit**
   (`packages/wft-router/host-manifests/systemd/wft-router.service`) —
   Linux hosts with systemd.
4. **launchd plist**
   (`packages/wft-router/host-manifests/launchd/com.wood-fired-games.wft-router.plist`)
   — macOS.
5. **Windows Service**
   (`packages/wft-router/host-manifests/windows/README.md`) — Windows. The
   README covers nssm-based service registration (preferred for a console
   app) and an `sc.exe` alternative.
6. **Run-once** (`wft-router --once`) — useful for CI smoke tests and
   replaying a backlog window after downtime.

None of these is presented as the "right" choice; the doc orders them
by progressively-more-OS-specific.

## Adoption paths

### OSS default (zero special infrastructure)

A user with wood-fired-tasks and *nothing else* can wire a working
cross-project chain with one config file and no new processes beyond
the router:

```yaml
rules:
  - name: server-bug-closed-kicks-client
    on: task.status_changed
    where: { project: my-server, status: closed, tags_contains_all: [api-change] }
    do: create_task_in_project
    with:
      project: my-client
      title: "Adopt {{task.title}}"
      depends_on_external: { project: my-server, task_id: "{{task.id}}" }
```

The "my-client" project's normal task-pickup workflow — whatever it is
— takes over from there.

### CI / webhook-native

`webhook_post` is the canonical CI primitive. Peer examples (alphabetical):

```yaml
# Buildkite
- name: closed-task-triggers-buildkite
  on: task.status_changed
  where: { project: web, status: closed, tags_contains_all: [pr-merged] }
  do: webhook_post
  with:
    url: https://api.buildkite.com/v2/organizations/{org}/pipelines/{p}/builds
    headers: { authorization: "Bearer {{env.BUILDKITE_TOKEN}}" }
    body: { commit: "{{task.metadata.commit}}", branch: main }

# GitHub repository_dispatch
- name: closed-task-triggers-gh-deploy
  on: task.status_changed
  where: { project: web, status: closed, tags_contains_all: [pr-merged] }
  do: webhook_post
  with:
    url: https://api.github.com/repos/my-org/web/dispatches
    headers: { authorization: "Bearer {{env.GH_DISPATCH_TOKEN}}" }
    body: { event_type: deploy-staging }

# GitLab pipeline
- name: closed-task-triggers-gitlab-pipeline
  on: task.status_changed
  where: { project: api, status: closed, tags_contains_all: [release] }
  do: webhook_post
  with:
    url: https://gitlab.example/api/v4/projects/42/trigger/pipeline
    body: { token: "{{env.GITLAB_TRIGGER_TOKEN}}", ref: main }

# Jenkins
- name: closed-task-triggers-jenkins
  ...
```

### Local agent topology (any persistent-session setup)

A `triggers.yaml` colocated with the user's dotfiles uses
`agent_session_dispatch` with a user-named adapter. The router has no
opinion about what an "agent session" is or how to address it — that's
the adapter's job.

```yaml
rules:
  - name: engine-epic-closed-kicks-platform-agent
    on: task.status_changed
    where: { project: wood-fired-engine, status: closed, tags_contains_all: [epic] }
    do: agent_session_dispatch
    with:
      adapter: local-command       # user's adapter, named however the user likes
      target: wood-fired-platform
      prompt: "engine epic {{task.id}} closed — bump and redeploy"
```

Real-world adapters users can write:

- A POSIX `local-command.sh` that translates `target=` into a tmux
  send-keys against a named session (Linux/macOS).
- A `local-command.ts` that POSTs to a local agent's HTTP control
  endpoint (cross-platform).
- A `local-command.ps1` that delivers via Windows Named Pipes or a
  service IPC (Windows).
- An `ssh-channel.sh` that pushes through an SSH control socket.
- A `kubectl-exec.sh` that pipes into a pod's stdin.

None of these is the "right" adapter; each is an example of the
contract.

## Vendor-neutral guardrails (contract)

This section is the explicit anti-lock-in contract. Violations of any
of (1)–(10) are blocking review comments on any PR touching this design.

1. **No handler in the default install requires a specific AI vendor,
   CI provider, chat platform, or operating system.** Core handlers are
   `create_task_in_project`, `webhook_post`, `shell_exec`, and
   `agent_session_dispatch`. None names a provider.
2. **No AI / CI / chat provider has a named handler.** Provider hooks
   are recipes using `webhook_post`, documented in
   `docs/automation-recipes/`. Adding a named handler for any provider
   is a vendor-neutrality regression.
3. **The config language is YAML, not a programming language.** No
   host-language coupling; a Python or Go reimplementation of the
   router consumes the same `triggers.yaml` byte-for-byte.
4. **The transport is plain SSE over HTTP(S) with a Bearer/X-API-Key
   header.** No SDK, no vendor client library, no gRPC. `curl` + a
   tiny event parser is a conforming implementation.
5. **The repo ships zero blessed adapters.** The `examples/adapters/`
   directory contains a cross-platform TypeScript reference plus
   POSIX/Windows peers, all demonstrating the contract; none speaks to
   a specific provider.
6. **Documentation order matters.** Every adoption / recipe section
   leads with the OSS-recommended path (`create_task_in_project` or
   `webhook_post`); provider-specific recipes appear as alphabetical
   peers, never as a "primary" example.
7. **Platform-neutral defaults.** Paths resolve to XDG on Linux/BSD,
   Application Support on macOS, and AppData on Windows. No
   `/usr/local`, no `~/.config`, no `%APPDATA%` is hard-coded as
   normative — all are platform-conditional.
8. **Adapter examples are cross-platform first.** The reference
   adapters in `examples/adapters/` are in the project's existing
   TypeScript runtime. Platform-specific peers (`.sh`, `.ps1`) are
   provided as equals, not as the "real" examples with TypeScript as
   a fallback.
9. **No naming bias.** Adapter examples, target identifiers, and config
   placeholders use vendor-neutral names (`local-command`,
   `user-defined`, `ssh-channel`, `container-exec`). `tmux`, `claude`,
   `codex`, `aider`, `gh`, etc. do not appear in core examples.
10. **Scheduling is out of scope without naming alternatives.** The
    out-of-scope section names a category ("external schedulers"), not
    specific tools (no cron / launchd / Claude routine name-checks in
    normative text).

## Out of scope (v1)

- **In-server triggers table.** Storing rules in the DB and firing
  them in-process as an EventBus subscriber. Tempting but couples the
  feature to the server; v1 keeps the router external so OSS users
  adopt without a server upgrade and so the config schema stabilises
  in the wild first.
- **A web UI for editing triggers.** v1 is YAML files on disk.
- **Scheduled rules.** Out of scope. Users wire scheduling via any
  external scheduler available on their platform.
- **Fan-in / correlation** (rule fires only after N independent events).
  v1 is one-event-in / one-action-out. Documented as a future
  extension.
- **Native task-mirroring across wood-fired-tasks instances**.
  Achievable with `create_task_in_project` against a remote endpoint,
  but cross-instance auth/correlation is out of v1.
- **`metadata.actor` predicate** until the emit path actually populates
  it (parallel task).

## Open questions (block before code lands)

1. **Where does `wft-router` live in the repo?** Options:
   `bin/wft-router.ts` as a sibling to the existing CLI, or
   `packages/wft-router/` as a sub-package. Defer to maintainer
   preference; the spec is identical.
2. **Does the OSS default ship the router or just document it?**
   ~~Recommend: ship a single `npm i -g @wood-fired-games/wft-router`
   package + an OCI image; do NOT bundle into the main server image.~~
   **RESOLVED (v1.15, opposite of the original recommendation):** the
   standalone `@wood-fired-games/wft-router` package was never published (its
   npm scope did not exist), so the router shipped to no one. It is now
   **bundled into the `wood-fired-tasks` package** as a second `wft-router`
   bin — installing `wood-fired-tasks` puts it on PATH. The OCI image remains
   available separately.
3. **Versioning of the config schema.** `version: 1` is in the schema;
   we commit to a minor version increment for additive fields and a
   major for breaking changes. Document the policy in `docs/RELEASE.md`.
4. **`metadata.actor` parallel task.** Wiring the auth principal
   through `TaskService.updateTask` and `claimTask` so the `actor`
   predicate becomes useful. Should this block router v1 or land in
   parallel?

## Verification fixtures (sketch)

For each of the following, the spec's behaviour should be cross-checked
before the implementation merges:

- **fix-1 / smoke**: a fake SSE server emits one `task.status_changed`
  matching one rule; the router dispatches once and persists the cursor.
- **fix-2 / pending-reconcile**: the router is killed between
  `PENDING` and handler invoke; on restart the rule re-fires exactly
  once. Killed between handler return and cursor advance: idempotency
  primary key suppresses re-fire on the next replay.
- **fix-3 / debounce**: three rapid `status_changed` events in
  `debounce_ms` collapse to one dispatch; the *last* event's payload is
  the one delivered; `coalesced_count: 3` is logged.
- **fix-4 / idempotency**: a duplicate event (same `event_id`) within
  the window does not re-dispatch; a legitimate `closed → reopened →
  closed` cycle that straddles `emitted_at_minute` *does* re-dispatch
  (i.e. the secondary coalescer doesn't collapse legitimate retransitions).
- **fix-5 / env-scrubbing**: a `shell_exec` rule is fired with one
  `token_env` set; the child process sees its own token but NOT any
  other rule's `*_token_env`, NOT `WFT_API_KEY`.
- **fix-6 / templating-safety**: a task title containing `"`, `<!channel>`,
  control bytes, and a 10 KB payload is rendered into (a)
  `create_task_in_project.title`, (b) `webhook_post.body`, (c)
  `slack_post_message.text`. The first preserves the bytes safely; the
  second JSON-escapes; the third strips `<!`; all three truncate at
  4 KiB. Templates with `{{...}}` inside YAML quoted strings fail
  validation.
- **fix-7 / TLS-posture**: a non-loopback `http://` endpoint refuses
  to start (exit 78); a misconfigured TLS cert refuses to connect (no
  `--insecure` fallback in v1).
- **fix-8 / rate-limit**: 200 events match one rule within 1 s;
  dispatches are throttled to `max_dispatches_per_minute`; surplus
  drops emit a counter and WARN.
- **fix-9 / secret-redaction**: a rule with `headers: { authorization:
  "Bearer xyz" }` shows `***` in stdout and `dispatch.log`.
- **fix-10 / platform-neutral-paths**: the spec's path table resolves
  correctly on Linux, macOS, and Windows; `WFT_ROUTER_CONFIG` overrides
  on all three.
- **fix-11 / vendor-neutrality**: a `triggers.yaml` using only the
  three core handlers (`create_task_in_project`, `webhook_post`,
  `shell_exec`) parses, dispatches, and round-trips end-to-end. The
  daemon binary has no string containing the names of any AI vendor,
  CI provider, or chat product in its core handler code paths
  (recipe docs may contain them; code may not).
- **fix-12 / adapter-contract**: a reference cross-platform adapter
  receives the expected stdin JSON shape, the expected argv pairs
  (including the addressing primitive `target=…` surviving intact —
  it's the field that carries channel/session identity to the adapter),
  and a scrubbed env (no `WFT_API_KEY`, no foreign `*_token_env`).
  Non-zero adapter exits surface as `handler_errors_total` without
  crashing the router.
- **fix-13 / stuck-handler**: one rule's handler is down indefinitely;
  the cursor still advances for all other rules. After `max_retries`
  the dead rule's row reaches `PERMANENTLY_FAILED` and its cursor
  unblocks.

## Follow-ons (post-v1)

- In-server triggers as an EventBus subscriber (the "v2" option) —
  fold the router into the API process for users who want a single
  binary. The config schema stays identical.
- A `wft-router replay --since <ts>` subcommand for backfills.
- A `triggers` MCP tool (list / create / delete / dry-run) so an agent
  can manage the user's automations conversationally. Implemented as
  a separate MCP server speaking the same `triggers.yaml` schema, so
  any MCP-aware agent client uses it; not Claude-specific.
- `metadata.actor` predicate, after the emit path is wired through.
