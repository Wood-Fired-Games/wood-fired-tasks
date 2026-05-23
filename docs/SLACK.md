# Slack Integration

Wood Fired Bugs ships an **optional** Slack integration that exposes the
task tracker inside a Slack workspace through:

1. A `/tasks` slash command (read, create, update, claim, subscribe, etc.).
2. A notifier that posts Block Kit messages to subscribed channels when
   task events fire on the internal EventBus.

The service runs perfectly without Slack — the three Slack environment
variables are validated as a group, so set **all three or none**.

## Architecture at a glance

```
            ┌──────────────┐
            │   Slack API  │
            └──────┬───────┘
                   │  WebSocket (Socket Mode) or HTTP (Events API)
                   ▼
           ┌───────────────┐         subscribe          ┌─────────────────┐
           │ @slack/bolt   │ ─────────────────────────► │  SlackChannel    │
           │   App         │                            │  Subscription    │
           └──────┬────────┘                            │  Repository      │
                  │                                     │  (SQLite)        │
       ┌──────────┴──────────┐                          └────────▲────────┘
       │ /tasks slash command│                                   │
       │ (tasks-command.ts)  │                                   │ findSubscribedChannels
       └──────────┬──────────┘                                   │
                  │ TaskService / ProjectService etc.            │
                  ▼                                              │
           ┌───────────────┐    eventBus.emit()    ┌─────────────┴───────┐
           │ Service Layer │ ────────────────────► │  SlackNotifier      │
           └───────────────┘                       │  (notifier.ts)      │
                                                   └─────────────────────┘
                                                              │
                                                              ▼
                                                       chat.postMessage
```

- **Slash command path** lives in
  [`src/slack/commands/tasks-command.ts`](../src/slack/commands/tasks-command.ts)
  and registers a single `/tasks` handler with `@slack/bolt`. The handler
  dispatches on the first positional token (`list`, `show`, `create`, …).
- **Notifier** lives in [`src/slack/notifier.ts`](../src/slack/notifier.ts)
  and subscribes to a fixed set of task event types on the internal
  EventBus. It looks up which channels asked for which `project_id × event_type`
  pair in the `slack_channel_subscriptions` table and posts a Block Kit
  message to each.
- **Channel subscriptions** are persisted in the SQLite database (migration
  006). The model is intentionally simple: `(channel_id, project_id, event_type)`
  with a UNIQUE constraint and a hard cap of 100 subscription rows per
  channel (`MAX_SUBSCRIPTIONS_PER_CHANNEL`) to prevent abuse.

## Required environment variables

All three must be set together; the Zod schema in
[`src/config/env.ts`](../src/config/env.ts) rejects partial configuration.

| Variable | Token type | Where to find it |
|----------|------------|------------------|
| `SLACK_BOT_TOKEN` | `xoxb-…` | "OAuth & Permissions" → "Bot User OAuth Token" |
| `SLACK_APP_TOKEN` | `xapp-…` | "Basic Information" → "App-Level Tokens" (scope: `connections:write`) — only needed for Socket Mode |
| `SLACK_SIGNING_SECRET` | hex string | "Basic Information" → "App Credentials" → "Signing Secret" |

Treat all three as production-grade secrets — see the "Secrets" section in
[`SETUP.md`](SETUP.md). Rotating any of them requires a server restart.

## Registering the Slack app

A canonical app manifest is checked in at
[`slack-app-manifest.yml`](../slack-app-manifest.yml). To install:

1. Visit <https://api.slack.com/apps?new_app=1> and choose
   **"From an app manifest"**.
2. Pick the target workspace.
3. Paste the contents of `slack-app-manifest.yml`.
4. Click **Create**.
5. Install the app to the workspace and copy the three tokens above into
   `.env` (or your secret manager).
6. Restart the server: `npm run dev` locally, or `pm2 restart
   wood-fired-bugs` / `systemctl restart …` in production.

### What the manifest grants

| Field | Value | Why |
|-------|-------|-----|
| Bot scope `chat:write` | post in channels the bot is in | notifier `chat.postMessage` |
| Bot scope `chat:write.public` | post in public channels without joining | notifier fallback |
| Bot scope `commands` | register `/tasks` slash command | slash command handler |
| Bot scope `channels:read` | list public channels | channel resolution |
| Bot scope `users:read` | map Slack user IDs → identities | per-message author resolution (`user-identity.ts`) |
| `socket_mode_enabled: true` | use Socket Mode (WebSocket) | no public HTTP endpoint needed; works behind NAT |
| `slash_commands: /tasks` | single command surface | dispatched in `tasks-command.ts` |

[NOTE] Socket Mode means the Slack app dials out to Slack over a
WebSocket; the server does **not** need to expose an HTTP endpoint to the
public Internet. This is the recommended deployment for self-hosted
installs. Set `socket_mode_enabled: false` only if you have a stable
public URL and prefer HTTP delivery.

## Slash command reference

Bare `/tasks` (or `/tasks help`) prints the help block. All responses are
**ephemeral** — only the user who invoked the command sees them.

### Task commands

| Command | Description |
|---------|-------------|
| `/tasks list [--project N] [--status open\|in_progress\|done\|closed\|blocked\|backlogged] [--assignee X]` | List tasks with filters. |
| `/tasks show <id>` | Show full task detail (status, priority, assignee, comments). |
| `/tasks create <title> [--project N] [--priority …] [--assignee …]` | Create a new task. |
| `/tasks update <id> [--title …] [--status …] [--priority …] [--assignee …]` | Update task fields. |
| `/tasks delete <id>` | Delete a task. |
| `/tasks claim <id>` | Atomically claim an unassigned task. Uses the same optimistic-locking path as the REST API. |

### Project / dependency / comment / subtask commands

| Command | Description |
|---------|-------------|
| `/tasks project-list` | List all projects. |
| `/tasks project-show <id>` | Project detail. |
| `/tasks project-create <name>` | Create a project. |
| `/tasks project-update <id> …` | Update project fields. |
| `/tasks project-delete <id>` | Delete a project (cascades). |
| `/tasks dep-add <taskId> <blocksTaskId>` | Add dependency. |
| `/tasks dep-list <taskId>` | List dependencies. |
| `/tasks dep-remove <taskId> <blocksTaskId>` | Remove dependency. |
| `/tasks comment-add <taskId> <content>` | Add a comment. |
| `/tasks comment-list <taskId>` | List comments. |
| `/tasks comment-delete <commentId>` | Delete a comment. |
| `/tasks subtask-create <parentId> <title>` | Create a subtask. |
| `/tasks subtask-list <parentId>` | List subtasks. |

### Notification subscription commands

| Command | Description |
|---------|-------------|
| `/tasks subscribe --project <id> [--events evt1,evt2,…]` | Subscribe the current channel to events for a project. Defaults to all task event types. |
| `/tasks unsubscribe [--project <id>]` | Unsubscribe the current channel from a project, or from all projects if `--project` is omitted. |

Subscriptions are stored per channel. Each `(channel × project × event_type)`
triple is unique. The hard cap is **100 rows per channel** (see
`MAX_SUBSCRIPTIONS_PER_CHANNEL` in `tasks-command.ts`) to prevent careless
or hostile users from filling the table.

### CLI-only commands

A handful of operational commands (`backup`, `doctor`, `stats`, `db-check`,
`completions`) only make sense at the host shell. The Slack handler
recognises them and responds with a friendly "this is a CLI-only command,
run `tasks <subcommand>` on the server" message rather than failing.

## Identity mapping (Slack user → local user)

Every `/tasks` slash command carries the invoking Slack user's id
(`event.user_id`, format `U…`). As of v1.6 the handler maps that Slack
id to a local `users` row via `UserRepository.findBySlackUserId`, and
the resolved local user is stamped onto every write the command
performs (`created_by_user_id`, `assignee_user_id`, etc.) — the same
audit fields the REST and MCP surfaces populate.

### How a Slack user gets bound

There is no automatic Slack-side bootstrap. A local `users` row gets
its `slack_user_id` column populated by an operator action — typically
by editing the user row through the `/me` web UI (admin view) or by a
one-off SQL update against the SQLite database.

```sql
-- Bind an existing local user (resolved by email) to a Slack id.
UPDATE users
   SET slack_user_id = 'U01ALICE'
 WHERE email = 'alice@example.com';
```

After this update, the next `/tasks` command from `U01ALICE` resolves
to the bound `users` row and every write is attributed to that user.

### `slack-bot` fallback

If `findBySlackUserId` returns no match — the Slack user has never
been bound to a local user — the handler does **not** fail. It falls
back to the seeded `slack-bot` service-account row and attributes the
write to that bot, exactly mirroring the `mcp-bot` fallback on the MCP
surface.

The fallback emits a `warn`-level pino log line so operators can
detect unbound Slack users:

```json
{
  "level": 40,
  "event": "slack_user_unmapped",
  "slack_user_id": "U01UNKNOWN",
  "fallback": "slack-bot"
}
```

**Operator action when you see this log:** decide whether the Slack
user should be a real local user (provision them via the web UI or
direct DB update as shown above) or whether the fallback is intentional
(e.g. a shared workspace bot). Repeated `slack_user_unmapped` lines for
the same `slack_user_id` indicate a missing binding.

[NOTE] The `slack-bot` row is seeded unconditionally on first boot
alongside `mcp-bot`. Both are real `users` rows with `is_service=1`
so foreign-key constraints from the identity columns always resolve,
even before any operator binds a real user.

## Notifier behaviour

The `SlackNotifier` ([`src/slack/notifier.ts`](../src/slack/notifier.ts))
subscribes to these EventBus event types at startup:

- `task.created`
- `task.updated`
- `task.status_changed`
- `task.claimed`
- `task.deleted`

For each event:

1. Look up subscribed channels for `(event.data.project_id, eventType)` in
   `slack_channel_subscriptions`. No matches → no-op.
2. Resolve the project name via `ProjectService` (best-effort; falls back
   to `Project #<id>` on error).
3. Format a Block Kit message via `formatTaskNotification`.
4. Post to every subscribed channel **independently** with
   `Promise.allSettled`. One channel failing does not stop the others.
5. Retry transient Slack errors up to 2 times with exponential backoff
   (500 ms, 1000 ms).
6. **Permanent errors** are not retried — these are
   `not_in_channel`, `channel_not_found`, `invalid_auth`, `token_revoked`.
   They are logged at error level (`SlackNotifier: failed to post notification`)
   so operators can detect a misconfigured channel or revoked token.

### Why the notifier never breaks task mutations

The EventBus handler registered by the notifier is **synchronous on the
outside, async on the inside** — it explicitly attaches `.catch()` so an
unhandled rejection in Slack delivery cannot bubble up into the task
service or crash the process. This matters because the EventBus wraps
handlers in `try/catch`, but that only catches synchronous throws; an
async handler whose promise rejected would otherwise slip through.

## Error handling at the slash command boundary

Every `/tasks …` handler runs inside a top-level `try/catch` that maps
service errors to ephemeral Block Kit replies (`src/services/errors.ts`):

| Error | Slack response |
|-------|----------------|
| `NotFoundError` | `:x: <message>` |
| `ValidationError` | `:x: <message>` plus per-field detail lines |
| `BusinessError` | `:x: <message>` |
| Any other `Error` | `:x: <message>` (generic) |

The handler always `ack()`s within 3 seconds (Slack's hard requirement);
all work after `ack()` uses the 30-minute `response_url` window via
`respond()`. This means even a slow database call cannot cause Slack to
mark the command as failed.

## Local development

Slack code is gated on the env vars being present, so local development
without Slack is supported by simply leaving them unset. To test the full
integration locally:

1. Install the app to a test workspace via the manifest.
2. Put the three tokens in `.env`.
3. `npm run dev` — the Bolt app connects via Socket Mode on startup; no
   tunnel or public URL needed.
4. In any channel where the bot is a member, run `/tasks help`.

## See also

- [`SETUP.md`](SETUP.md) — full setup guide, including the environment
  variable table.
- [`API.md`](API.md) — the REST API that the Slack commands ultimately
  exercise through the shared service layer.
- [`../slack-app-manifest.yml`](../slack-app-manifest.yml) — canonical
  Slack app manifest.
- [`../src/slack/`](../src/slack/) — source code (commands, notifier,
  formatters, channel-subscription repository).
