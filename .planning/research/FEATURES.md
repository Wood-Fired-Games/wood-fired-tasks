# Feature Research: Slack Integration

**Domain:** Slack slash commands, bot notifications, per-channel subscriptions for task tracking
**Researched:** 2026-02-17
**Confidence:** HIGH (Slack official docs verified; patterns confirmed across multiple authoritative sources)

---

## Context: What Already Exists

This is a SUBSEQUENT MILESTONE. The following are already built and must not be re-planned:

- **24 CLI commands** covering the full task/project lifecycle
- **REST API** (Fastify 5.x) with full CRUD for tasks, projects, comments, dependencies
- **EventBus** (Node.js EventEmitter, typed) emitting 8 event types:
  - `task.created`, `task.updated`, `task.deleted`, `task.status_changed`, `task.claimed`
  - `project.created`, `project.updated`, `project.deleted`
- **Task fields**: id, title, description, status (6 values), priority (4 values), project_id, assignee, created_by, due_date, tags, version, claimed_at
- **Service layer**: TaskService, ProjectService, CommentService, DependencyService, ClaimReleaseService

The Slack integration is purely an **additional interface** to these existing capabilities.

---

## Slack Platform Mechanics (Required Understanding)

### Slash Command Request/Response Flow

1. User types `/bug list` in a Slack channel
2. Slack sends HTTP POST to your app's request URL within 3 seconds (or socket message in Socket Mode)
3. App **must ack within 3 seconds** — return HTTP 200 (empty or with immediate response body)
4. For slow operations: ack immediately (empty 200), then use `response_url` webhook to send follow-up
5. Commands receive: `command`, `text`, `user_id`, `channel_id`, `response_url`, `trigger_id`, `team_id`

**Critical constraint**: The `text` field is the entire string after the command as a single parameter. Subcommand routing (e.g., `/bug list`, `/bug create`) must be parsed by the app.

### Response Visibility
- **Ephemeral** (default): Only visible to the invoking user. Use for confirmations, query results, errors.
- **In-channel**: Visible to everyone. Use sparingly — only for team-relevant announcements.
- **Modals**: Pop-up dialog for multi-field input (triggered via `trigger_id`).

### Request Signing (Security)
All Slack HTTP requests include `X-Slack-Request-Timestamp` and `X-Slack-Signature` headers. Verification:
1. Reject if timestamp is more than 5 minutes old (replay attack prevention)
2. Compute HMAC-SHA256 of `v0:{timestamp}:{raw_body}` using signing secret
3. Compare to `X-Slack-Signature` using constant-time comparison

### Socket Mode vs HTTP Mode
For a LAN-only service (no public internet endpoint):
- **Socket Mode is the right choice** — connects via WebSocket to Slack, no need for public HTTPS endpoint
- Bolt.js handles Socket Mode natively with `@slack/bolt` + `@slack/socket-mode`
- HTTP mode requires a publicly accessible URL (ngrok tunnel for dev, reverse proxy for prod)

### User Identity
- Slash commands provide `user_id` (e.g., `U012AB3CD`) — this is the Slack user's stable identifier
- Display name retrieved via `users.info` API → `profile.display_name` field
- **Slack recommends using user_id as primary key**, not display_name (display_name is mutable)
- For `created_by`/`assignee` fields in tasks: store display_name as a human-readable string (acceptable for a single-workspace custom app where user names are known and stable)
- User mention format in mrkdwn: `<@U012AB3CD>` (renders as clickable @mention)

### Block Kit for Formatting
Blocks compose notifications and slash command responses:
- **Header block**: Large title text (plain_text only)
- **Section block**: Primary content area with optional fields grid; supports mrkdwn
- **Divider block**: Visual separator
- **Context block**: Small supplementary text (timestamps, IDs, etc.)
- **Actions block**: Buttons and interactive elements

mrkdwn user mention: `<@USERID>`, bold: `*text*`, italic: `_text_`, link: `<url|text>`

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features a Slack bot for task tracking must have. Missing these = bot feels broken or half-built.

| Feature | Why Expected | Complexity | Existing Hook |
|---------|--------------|------------|---------------|
| **Slash command: list tasks** | Core discovery — "show me what's open" | LOW | `GET /api/v1/tasks` |
| **Slash command: create task** | Core creation path in Slack | MEDIUM | `POST /api/v1/tasks` |
| **Slash command: show task** | Look up a task by ID | LOW | `GET /api/v1/tasks/:id` |
| **Slash command: update task status** | Most frequent mutation — status changes | MEDIUM | `PATCH /api/v1/tasks/:id` |
| **Slash command: claim task** | Assign yourself to a task | LOW | `POST /api/v1/tasks/:id/claim` |
| **Slack user as assignee/creator** | Identity from Slack — no manual name entry | MEDIUM | `users.info` API → display_name |
| **Ephemeral responses for queries** | Query results visible only to requester | LOW | `respond({ response_type: 'ephemeral' })` |
| **Bot notification: task created** | Teams want to know when work is added | LOW | EventBus `task.created` |
| **Bot notification: task status changed** | Progress visibility is the main value | LOW | EventBus `task.status_changed` |
| **Bot notification: task claimed** | Assignee visibility prevents conflicts | LOW | EventBus `task.claimed` |
| **Per-channel subscription: enable/disable** | Channels have different concerns (not all want all noise) | MEDIUM | New `slack_subscriptions` table |
| **Request signature verification** | Security baseline — prevent spoofed requests | MEDIUM | HMAC-SHA256 middleware |
| **Help command** | All task bots need discoverability | LOW | Static Block Kit response |
| **Slash command: ack + deferred response** | 3-second limit requires async pattern for slow queries | MEDIUM | `ack()` then `respond()` via response_url |
| **Block Kit formatting for task cards** | Plain text responses look unpolished; users expect rich cards | MEDIUM | Block Kit section/header/context blocks |
| **Error responses (ephemeral, actionable)** | Users need feedback when commands fail | LOW | Ephemeral error messages |

### Differentiators (Competitive Advantage)

Features beyond baseline that add meaningful value for this specific use case (small team, LAN-hosted, agentic workflow).

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Slash command: filter list** | `/bug list --status open --project 2` — same power as CLI | MEDIUM | Parse text as sub-arguments; reuse existing filter logic |
| **Per-channel subscription: event type filter** | Channel #backend gets only backend project events; #urgent gets only high/urgent priority | MEDIUM | Additional columns on `slack_subscriptions` table |
| **Slash command: comment on task** | Add context without leaving Slack | LOW | `POST /api/v1/tasks/:id/comments` |
| **@mention assignee in notifications** | `<@U123>` in task claimed/assigned notifications — Slack notifies them directly | LOW | Requires user_id→slack_id mapping |
| **Slash command: assign task to another user** | Delegate work without CLI | LOW | `PATCH /api/v1/tasks/:id` with assignee |
| **Bot notification: task updated** | Configurable — teams can opt-in to change stream | LOW | EventBus `task.updated` |
| **Subscribe command in-channel** | `/bug subscribe` to configure current channel without admin UI | MEDIUM | Writes to `slack_subscriptions` table |
| **Unsubscribe command** | `/bug unsubscribe` to remove channel from notifications | LOW | Deletes from `slack_subscriptions` table |
| **Slash command: project list** | Discover project IDs from Slack (needed for filtering) | LOW | `GET /api/v1/projects` |
| **Notification: include task URL** | Link back to task detail in notification card | LOW | Format task ID as `<http://host/tasks/123|#123>` |
| **Priority emoji indicators** | `🔴 urgent`, `🟠 high`, `🟡 medium`, `🟢 low` in Block Kit cards | LOW | Static mapping, visual at-a-glance priority |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem like natural asks but should be explicitly avoided.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **One slash command per operation** | "Clean API" — `/bug-list`, `/bug-create`, etc. | Slack app configuration overhead; each command must be registered in Slack app manifest; harder to install; namespace pollution | Single `/bug` command with subcommand routing in text (`/bug list`, `/bug create`) |
| **In-channel responses for queries** | "Everyone should see task lists" | Creates channel noise for every lookup; ephemeral queries are the Slack UX standard | Ephemeral for query results; in-channel only for explicit team announcements |
| **Notification for every task.updated event** | "Full visibility" | High-frequency noise; `task.updated` fires on every field change including minor ones | Subscribe to specific event types per channel; default to status changes only |
| **Interactive buttons on every notification** | "Quickly claim/close from notification" | Slack interactive components require handler infrastructure, callback IDs, state management; significant additional complexity | Phase 1: informational notifications; interactive buttons are Phase 2+ |
| **Modals for task creation** | "Better UX than text commands" | Modal form requires `trigger_id`, separate view submission handler, state management; complex for 24 operations | Simple text command with named args: `/bug create --title "Fix login" --project 1` |
| **Real-time notification for all 8 event types by default** | "Maximum visibility" | Notification fatigue destroys bot adoption; teams mute bots that spam | Default subscribe to 3 events (created, status_changed, claimed); let teams opt-in to others |
| **Storing Slack user tokens** | "User-level permissions for each action" | Multi-token management is complex; single workspace custom app only needs bot token | Bot token only; single workspace installation; user identity from slash command payload |
| **Slack as source of truth for tasks** | "Create in Slack, sync to system" | Bidirectional sync creates conflicts; Slack is a notification surface, not a database | Slack calls REST API; system is always authoritative |
| **Channel-level slash command permissions** | "Only admins can create tasks from Slack" | Adds ACL complexity; overkill for internal custom app | Trust all workspace members; Slack workspace membership is already the permission boundary |

---

## Feature Dependencies

```
[Socket Mode / HTTP Endpoint]
    └──required by──> ALL slash command handlers
    └──required by──> ALL notification delivery
    └──required by──> Request signature verification

[Request Signature Verification]
    └──required by──> All slash command endpoints (security baseline)

[Slack user → display_name resolution]
    └──requires──> users.info Slack API call
    └──required by──> Slash command: create task (created_by field)
    └──required by──> Slash command: claim task (assignee field)
    └──required by──> @mention assignee in notifications

[slack_subscriptions table]
    └──required by──> Per-channel event subscription
    └──required by──> Subscribe/unsubscribe commands
    └──required by──> Bot notification routing

[EventBus subscription]
    └──requires──> slack_subscriptions table (to know which channels)
    └──requires──> Slack bot token (to post messages)
    └──required by──> All bot notifications

[Slash command: list tasks]
    └──requires──> Socket Mode / HTTP Endpoint
    └──requires──> Ack + deferred response pattern (list may exceed 3s)
    └──requires──> Block Kit task card formatter

[Slash command: create task]
    └──requires──> Socket Mode / HTTP Endpoint
    └──requires──> Slack user → display_name resolution

[Slash command: claim task]
    └──requires──> Socket Mode / HTTP Endpoint
    └──requires──> Slack user → display_name resolution

[Block Kit task card formatter]
    └──enhances──> All slash command responses
    └──enhances──> All bot notifications
    └──no external deps (pure formatting logic)

[Subscribe/unsubscribe commands]
    └──requires──> slack_subscriptions table
    └──requires──> Socket Mode / HTTP Endpoint
```

### Dependency Notes

- **Socket Mode vs HTTP first decision**: All features depend on this. Socket Mode eliminates ngrok/public-URL complexity for LAN deployment. Commit to Socket Mode early.
- **`slack_subscriptions` table is the configuration backbone**: Notifications without it would post to a hardcoded channel. Per-channel configuration requires this table before notification features can ship.
- **EventBus already exists**: The existing `eventBus` singleton in `src/events/event-bus.ts` is the integration point for notifications. The Slack bot subscribes to event types and fans out to subscribed channels.
- **Deferred response pattern must be implemented first**: The `ack()` + `respond()` split is required for any operation that may exceed 3 seconds (list queries with filters, create with validation). Implement this pattern once as a utility.
- **Block Kit formatter is a cross-cutting concern**: Build it early; all features benefit from consistent task card formatting.

---

## MVP Definition

### Launch With (v1.5 Slack MVP)

Minimum viable Slack interface — proves the integration works end-to-end.

- [ ] **Socket Mode setup + request verification** — Foundational; without this nothing else works
- [ ] **`/bug help`** — Discoverability; tells users what commands exist
- [ ] **`/bug list`** — Most-used query; validates read path end-to-end
- [ ] **`/bug show <id>`** — Task lookup by ID; validates Block Kit formatting
- [ ] **`/bug create --title "..." --project <id>`** — Core write path; validates Slack user identity flow
- [ ] **`/bug claim <id>`** — Self-assign; validates claim protocol works from Slack
- [ ] **`/bug update <id> --status <status>`** — Status change; validates update path
- [ ] **Block Kit task card formatter** — Shared formatting; needed by list, show, notifications
- [ ] **Bot notification: task.created** — Validates outbound notification pipeline
- [ ] **Bot notification: task.status_changed** — Most valuable notification type
- [ ] **`slack_subscriptions` table** — Required for notification routing
- [ ] **`/bug subscribe` and `/bug unsubscribe`** — Channel admin commands; required to configure notifications

### Add After Validation (v1.5.x)

- [ ] **`/bug list --status <s> --project <p>`** — Full filter support; add once basic list works
- [ ] **`/bug comment add <id> <text>`** — Add comments from Slack
- [ ] **`/bug assign <id> @user`** — Assign to another user (requires user ID from @mention parsing)
- [ ] **`/bug projects`** — List projects so users know which IDs exist
- [ ] **Bot notification: task.claimed** — Add once task.created/status_changed proven
- [ ] **Per-channel event type filter** — Fine-grained subscription control
- [ ] **Priority emoji indicators** — Visual polish on Block Kit cards
- [ ] **@mention assignee in notifications** — Requires user_id↔display_name cache

### Future Consideration (v2+)

- [ ] **Interactive buttons on notifications** — Claim/close from notification; requires interactive component infrastructure
- [ ] **Modal-based task creation** — Better UX for multi-field creation; high complexity
- [ ] **Scheduled digests** — Daily summary of open tasks per channel
- [ ] **Due date reminder notifications** — Proactive alerts for approaching deadlines
- [ ] **Search command** — `/bug search "login fix"` — full-text search from Slack

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Socket Mode + request verification | HIGH | MEDIUM | P1 |
| `/bug help` | HIGH | LOW | P1 |
| `/bug list` | HIGH | LOW | P1 |
| `/bug show <id>` | HIGH | LOW | P1 |
| `/bug create` | HIGH | MEDIUM | P1 |
| `/bug claim <id>` | HIGH | LOW | P1 |
| `/bug update <id>` | HIGH | LOW | P1 |
| Block Kit task card formatter | HIGH | MEDIUM | P1 |
| `slack_subscriptions` table | HIGH | LOW | P1 |
| `/bug subscribe` / `/bug unsubscribe` | HIGH | LOW | P1 |
| Bot notification: task.created | HIGH | LOW | P1 |
| Bot notification: task.status_changed | HIGH | LOW | P1 |
| `/bug list` with filters | MEDIUM | MEDIUM | P2 |
| `/bug comment add` | MEDIUM | LOW | P2 |
| Bot notification: task.claimed | MEDIUM | LOW | P2 |
| Per-channel event type filter | MEDIUM | MEDIUM | P2 |
| Priority emoji indicators | LOW | LOW | P2 |
| @mention assignee in notifications | MEDIUM | MEDIUM | P2 |
| `/bug assign <id> @user` | MEDIUM | MEDIUM | P2 |
| `/bug projects` | LOW | LOW | P2 |
| Interactive notification buttons | HIGH | HIGH | P3 |
| Modal task creation | MEDIUM | HIGH | P3 |
| Scheduled digests | LOW | HIGH | P3 |

**Priority key:**
- P1: Required for launch — core Slack interface functional
- P2: High value, add once core is proven stable
- P3: Future — requires architectural additions not in scope for v1.5

---

## New Data Model Requirements

The only new persistent data needed for Slack integration is channel subscription configuration.

### `slack_subscriptions` table

```sql
CREATE TABLE slack_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,          -- Slack channel ID (C-prefixed)
  channel_name TEXT,                  -- For display purposes only (mutable, not a key)
  event_types TEXT NOT NULL,          -- JSON array: ["task.created","task.status_changed"]
  project_ids TEXT,                   -- JSON array of project IDs to filter, NULL = all projects
  min_priority TEXT,                  -- Minimum priority threshold: low|medium|high|urgent (NULL = all)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(channel_id)                  -- One subscription record per channel
);
```

No changes needed to existing `tasks`, `projects`, `comments`, or `task_dependencies` tables.

### Optional: `slack_users` cache table

For mapping Slack `user_id` to `display_name` without calling the API on every command:

```sql
CREATE TABLE slack_users (
  slack_user_id TEXT PRIMARY KEY,    -- Slack user ID (U-prefixed)
  display_name TEXT NOT NULL,
  cached_at TEXT DEFAULT (datetime('now'))
);
```

This is optional for MVP (can call `users.info` on each command) but reduces Slack API calls for active users.

---

## EventBus Integration Pattern

The Slack notification layer subscribes to the existing eventBus. No changes to EventBus or services.

```typescript
// New: src/slack/notifications.ts
import { eventBus } from '../events/event-bus.js';
import { SlackNotifier } from './notifier.js';

export function registerSlackNotifications(notifier: SlackNotifier) {
  // Subscribe to events the notifier cares about
  eventBus.subscribe('task.created', (event) => {
    notifier.notifyChannels('task.created', event);
  });

  eventBus.subscribe('task.status_changed', (event) => {
    notifier.notifyChannels('task.status_changed', event);
  });

  eventBus.subscribe('task.claimed', (event) => {
    notifier.notifyChannels('task.claimed', event);
  });
}
```

The `SlackNotifier.notifyChannels()` method:
1. Queries `slack_subscriptions` for channels subscribed to this event type
2. Applies project_id and priority filters if configured
3. Calls `chat.postMessage` for each matching channel with Block Kit card

---

## Competitor Feature Analysis

| Feature | Jira for Slack | Linear (native) | GitHub for Slack | Our Approach |
|---------|----------------|-----------------|------------------|--------------|
| Command style | `/jira` + subcommands | Native shortcuts | `/github` + subcommands | `/bug` + subcommands |
| Channel subscribe | `/jira connect` per channel | Per-channel notifications | `/github subscribe` | `/bug subscribe` |
| Event types | issue.created, updated, commented | issue, PR, cycle events | PR, issue, push events | task.created, status_changed, claimed |
| Create from Slack | Modal form | Modal | Issue form | Text command (modal is P3) |
| Assignee mentions | @mention in card | @mention in DM | @mention in card | @mention with `<@USERID>` mrkdwn |
| Filtering | By project, issue type, priority | By team, label | By repo, label | By project_id, min_priority |
| Auth model | OAuth per user | OAuth per workspace | OAuth per org | Bot token, single workspace |

**Key differentiator for Wood Fired Bugs:** This is an internal custom app with direct EventBus access. Jira/Linear integrations poll external APIs or use webhooks; ours subscribes directly to the in-process EventBus with zero latency and no polling overhead. Notifications fire at the moment of change.

---

## Sources

**Slack Official Documentation:**
- [Implementing slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/) — Request flow, 3-second limit, response types
- [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/) — HMAC-SHA256 signing, 5-minute replay window
- [Formatting message text](https://docs.slack.dev/messaging/formatting-message-text/) — mrkdwn syntax, user mentions `<@USERID>`, links
- [Block Kit blocks reference](https://docs.slack.dev/reference/block-kit/blocks/) — Available block types
- [Comparing HTTP & Socket Mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/) — Mode selection rationale
- [users.info method](https://docs.slack.dev/reference/methods/users.info/) — Display name retrieval
- [Slack changelog: farewell to usernames](https://docs.slack.dev/changelog/2017-09-the-one-about-usernames/) — Use user_id not display_name as key
- [Interaction guidelines](https://api.slack.com/start/planning/guidelines) — Ephemeral vs in-channel, modal use cases

**Bolt.js:**
- [@slack/bolt on npm](https://www.npmjs.com/package/@slack/bolt) — Version 4.6.0, TypeScript support, slash command patterns
- [bolt-js GitHub](https://github.com/slackapi/bolt-js) — Socket Mode, ack+respond pattern

**Real-world Integration Patterns:**
- [Jira for Slack channel notifications](https://support.atlassian.com/jira-software-cloud/docs/use-jira-cloud-for-slack/) — Channel subscribe model
- [Slack UX challenges (Cloverpop)](https://www.cloverpop.com/blog/six-ux-challenges-when-building-slack-apps-and-how-we-fixed-them) — Anti-pattern validation
- [Interaction guidelines for Slack apps](https://api.slack.com/start/planning/guidelines) — Official UX guidance

---
*Feature research for: Wood Fired Bugs — Slack Integration (v1.5)*
*Researched: 2026-02-17*
*Confidence: HIGH — Core Slack mechanics verified against official Slack Developer Docs; @slack/bolt version confirmed from npm/GitHub; EventBus integration assessed from direct codebase inspection*
