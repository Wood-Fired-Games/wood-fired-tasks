# Phase 26: Notification Pipeline - Research

**Researched:** 2026-02-17
**Domain:** Slack EventBus subscriber, channel subscription repository, slash command extensions
**Confidence:** HIGH

## Summary

Phase 26 connects the existing EventBus to Slack channels via a new `SlackNotifier` class that subscribes to task events, queries a `SlackChannelRepository` for matching channel subscriptions, and posts Block Kit notifications using `chat.postMessage`. The slash command router (`tasks-command.ts`) gains `subscribe` and `unsubscribe` subcommands to manage per-channel subscriptions stored in the existing `slack_channel_subscriptions` table (migration 006, already deployed from Phase 23).

All building blocks exist: the EventBus with typed pub/sub, the SSEManager as a reference subscriber, the `formatTaskNotification()` formatter, the Bolt `App` instance with `client.chat.postMessage`, and the subscription table with indexes. The work is primarily integration wiring -- a new repository class, a new notifier class, two new command handlers, and startup wiring in `server.ts`.

**Primary recommendation:** Build three components in order: (1) SlackChannelRepository for subscription CRUD, (2) SlackNotifier as EventBus subscriber with per-channel fire-and-forget posting and retry, (3) subscribe/unsubscribe command handlers wired into the existing router switch statement.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| NTFY-01 | Bot posts task event notifications to subscribed Slack channels | SlackNotifier subscribes to EventBus events, queries SlackChannelRepository for matching channels, calls `client.chat.postMessage()` per channel |
| NTFY-02 | `/tasks subscribe` configures per-channel subscriptions with project and event type filters | New `handleSubscribe` handler in tasks-command.ts; uses SlackChannelRepository.subscribe() to INSERT rows; responds ephemerally |
| NTFY-03 | `/tasks unsubscribe` removes channel subscriptions | New `handleUnsubscribe` handler in tasks-command.ts; uses SlackChannelRepository.unsubscribe() to DELETE rows; responds ephemerally |
| NTFY-05 | Notification formatting includes task title, status change, assignee, and project | Enhance `formatTaskNotification()` to accept optional projectName parameter; SlackNotifier resolves project name via ProjectService before formatting |
</phase_requirements>

## Standard Stack

### Core (already installed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@slack/bolt` | 4.x | Bolt App wrapping WebClient | Already in use; provides `app.client.chat.postMessage()` |
| `@slack/web-api` | 7.x (bundled) | WebClient for API calls | Bundled inside `@slack/bolt`; used directly via `app.client` |
| `@slack/types` | 2.x (bundled) | TypeScript types for Block Kit | Already imported in formatters for `KnownBlock`, `SectionBlock` |
| `better-sqlite3` | current | SQLite access | All repositories use this; subscription repo follows same pattern |

### Supporting (already installed)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | current | Test runner | Unit tests for repository, notifier, command handlers |
| `pino` | current | Logging | SlackNotifier logs errors via Fastify's logger instance |

### No New Dependencies

This phase requires zero new npm packages. Everything is built on existing infrastructure.

## Architecture Patterns

### Recommended Project Structure

```
src/
  slack/
    notifier.ts                    # NEW: EventBus subscriber -> chat.postMessage
    repositories/
      channel-subscription.repository.ts  # NEW: CRUD for slack_channel_subscriptions
    commands/
      tasks-command.ts             # MODIFIED: add subscribe/unsubscribe cases to switch
    task-formatter.ts              # MODIFIED: add project name to notification format
    __tests__/
      notifier.test.ts             # NEW
      channel-subscription.repository.test.ts  # NEW
  api/
    server.ts                      # MODIFIED: wire SlackNotifier into startup
```

### Pattern 1: EventBus Subscriber (follow SSEManager pattern)

**What:** SlackNotifier subscribes to specific EventBus event types at startup, unsubscribes at shutdown.
**When to use:** Any component that reacts to domain events.
**Reference:** `src/api/server.ts` lines 118-125 (SSEManager wiring).

```typescript
// Source: src/api/server.ts (existing SSEManager pattern)
eventBus.subscribe('task.created', (event) => sseManager.broadcast(event));
eventBus.subscribe('task.updated', (event) => sseManager.broadcast(event));
// ... one subscription per event type
```

**SlackNotifier follows the same pattern but with async work:**

```typescript
// CRITICAL: EventBus handlers are synchronous (EventEmitter.emit is sync).
// The handler must NOT await async work inline -- fire and forget, catch internally.
eventBus.subscribe('task.created', (event) => {
  this.notifyChannels('task.created', event).catch((err) =>
    this.logger.error({ err }, 'SlackNotifier: failed to notify channels')
  );
});
```

### Pattern 2: Repository with Prepared Statements (follow CommentRepository)

**What:** Repository class wraps `better-sqlite3` prepared statements for the `slack_channel_subscriptions` table.
**When to use:** All database access in this codebase.
**Reference:** `src/repositories/comment.repository.ts` -- constructor prepares statements, methods execute them.

```typescript
// Source: src/repositories/comment.repository.ts pattern
export class SlackChannelSubscriptionRepository {
  private findByProjectAndEventStmt: Database.Statement;
  private insertStmt: Database.Statement;
  private deleteByChannelStmt: Database.Statement;
  // ...

  constructor(private db: Database.Database) {
    this.findByProjectAndEventStmt = db.prepare(`
      SELECT channel_id FROM slack_channel_subscriptions
      WHERE project_id = ? AND event_type = ?
    `);
    // ...
  }
}
```

### Pattern 3: Command Handler in Switch Router (follow existing subcommand pattern)

**What:** Add `case 'subscribe':` and `case 'unsubscribe':` to the switch in `registerTasksCommand`.
**When to use:** Any new slash subcommand.
**Reference:** `src/slack/commands/tasks-command.ts` lines 774-878.

```typescript
// Inside the existing switch (subcommand) block:
case 'subscribe':
  await handleSubscribe(respond, subscriptionRepo, command, args);
  break;
case 'unsubscribe':
  await handleUnsubscribe(respond, subscriptionRepo, command, args);
  break;
```

### Anti-Patterns to Avoid

- **Async EventBus handler blocking dispatch:** The EventBus handler wrapper in `event-bus.ts` catches thrown errors but does NOT await async return values. If the handler is `async`, it returns a Promise that EventBus ignores. This is correct behavior -- do NOT make the EventBus await Slack HTTP calls. Handle all async work with `.catch()` internally.

- **Notifying channels sequentially and failing on first error:** Use `Promise.allSettled()` or per-channel try/catch to ensure one channel's failure does not prevent other channels from receiving notifications.

- **Querying subscriptions inside the EventBus synchronous path:** The `findByProjectAndEvent` query is synchronous (better-sqlite3 is sync), so it IS safe to call inline. However, the `chat.postMessage` call is async and must be fire-and-forget.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Posting messages to Slack | Custom HTTP client | `app.client.chat.postMessage()` | Handles auth, rate limiting, retries internally |
| Block Kit message formatting | Manual JSON construction | `formatTaskNotification()` from `task-formatter.ts` | Already tested and verified (14 unit tests) |
| EventBus pub/sub | Custom event system | Existing `eventBus` singleton | Type-safe, error-isolated, already wired to services |
| Subscription persistence | In-memory map | `slack_channel_subscriptions` SQLite table | Already migrated with indexes; survives restarts |

**Key insight:** The entire notification pipeline is integration of existing components. The only genuinely new code is the repository class, the notifier class, and two command handlers.

## Common Pitfalls

### Pitfall 1: Bot Not In Channel (not_in_channel error)

**What goes wrong:** `chat.postMessage` returns `not_in_channel` error because the bot was never invited to the target channel.
**Why it happens:** `chat:write` scope alone requires the bot to be a channel member. Public channels need either bot membership or `chat:write.public` scope.
**How to avoid:** Ensure the Slack app has `chat:write.public` OAuth scope for public channels. For private channels, catch the `not_in_channel` error and log a clear message suggesting `/invite @bot-name`. Do not silently swallow this error.
**Warning signs:** Subscription exists in SQLite but no messages appear in the channel; `not_in_channel` in server logs.

### Pitfall 2: Async Handler Swallowing Errors Silently

**What goes wrong:** The EventBus subscriber returns an async function. The EventBus calls it synchronously, the Promise rejects, and Node.js emits an unhandled rejection. Or worse: the EventBus try/catch catches the synchronous part but misses the async rejection.
**Why it happens:** EventBus wraps handlers in `try { handler(payload) } catch`. If handler returns a Promise, the catch does NOT catch async rejections.
**How to avoid:** The handler registered with EventBus must be synchronous. It calls the async method and chains `.catch()` to handle errors. Never register an `async` function directly with `eventBus.subscribe()`.
**Warning signs:** `UnhandledPromiseRejection` warnings in logs; notifications fail with no error logged by EventBus.

### Pitfall 3: Notification Blocking Other EventBus Subscribers

**What goes wrong:** If the notifier handler runs synchronous database queries that are slow, it blocks SSEManager and WorkflowEngine from processing the same event.
**Why it happens:** EventEmitter dispatches handlers synchronously in registration order.
**How to avoid:** The `better-sqlite3` subscription query uses indexed columns (`project_id`, `event_type`) and returns in microseconds. This is not a real concern for this codebase. The async `chat.postMessage` calls are fire-and-forget and do not block.
**Warning signs:** SSE event delivery latency increases when Slack notifications are enabled.

### Pitfall 4: Missing Project Name in Notification

**What goes wrong:** NTFY-05 requires "project name" in notifications, but the current `formatTaskNotification()` only has access to `task.project_id` (a number). Notifications show "Project #3" instead of "Project: Wood Fired Bugs".
**Why it happens:** The `TaskEvent` payload contains the full task object which has `project_id` but not the project name.
**How to avoid:** The SlackNotifier must resolve `project_id` to a project name before formatting. Use `ProjectService.getProject(id)` or `ProjectRepository.findById(id)` to look up the name. Pass it as an additional parameter to an enhanced `formatTaskNotification()`.
**Warning signs:** Notification messages show numeric project ID instead of human-readable project name.

### Pitfall 5: Subscribe Command Without Project Validation

**What goes wrong:** User runs `/tasks subscribe --project 999` but project 999 does not exist. A subscription row is inserted in SQLite. When events fire, the subscription matches nothing (no tasks have `project_id=999`), or worse, a project with ID 999 is created later and starts receiving unexpected notifications.
**Why it happens:** The subscribe handler inserts into the subscriptions table without validating that the project exists.
**How to avoid:** Validate `project_id` against `ProjectService.getProject()` before inserting the subscription. Return an error if the project does not exist.
**Warning signs:** Subscriptions exist for non-existent projects; foreign key constraint violation if the DB enforces FK constraints.

## Code Examples

### 1. Existing EventBus Wiring Pattern (from server.ts)

```typescript
// Source: src/api/server.ts lines 118-125
// Wire EventBus to SSEManager - subscribe to each event type explicitly
eventBus.subscribe('task.created', (event) => sseManager.broadcast(event));
eventBus.subscribe('task.updated', (event) => sseManager.broadcast(event));
eventBus.subscribe('task.deleted', (event) => sseManager.broadcast(event));
eventBus.subscribe('task.status_changed', (event) => sseManager.broadcast(event));
eventBus.subscribe('task.claimed', (event) => sseManager.broadcast(event));
```

### 2. Existing formatTaskNotification Output

```typescript
// Source: src/slack/task-formatter.ts lines 166-187
// Input: TaskEvent with eventType, data (Task & {tags}), metadata
// Output: KnownBlock[] with single SectionBlock containing:
//   *Task created* by actor
//   emoji *#id title*
//   priority_indicator . assignee
//   `/tasks show id`

// Example output text:
// "*Task created* by stuart\n:white_circle: *#42 Fix login bug*\n:orange_circle: high . @alice\n`/tasks show 42`"
```

### 3. Subscription Table Schema (already deployed)

```sql
-- Source: src/db/migrations/006-slack-channel-subscriptions.ts
CREATE TABLE slack_channel_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,           -- Slack channel ID e.g. 'C01ABC123'
  project_id INTEGER NOT NULL         -- References projects(id) ON DELETE CASCADE
    REFERENCES projects(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,           -- Single event type per row: 'task.created', 'task.status_changed', etc.
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel_id, project_id, event_type)
);

-- Indexes (all three created in same migration):
-- idx_slack_subs_channel_id ON (channel_id)
-- idx_slack_subs_project_id ON (project_id)
-- idx_slack_subs_event_type ON (event_type)
```

**Key design:** One row per (channel, project, event_type) triple. NOT a JSON array of event types. To subscribe a channel to multiple event types for one project, insert multiple rows. This matches the UNIQUE constraint and avoids JSON querying complexity.

### 4. Existing Repository Pattern (from CommentRepository)

```typescript
// Source: src/repositories/comment.repository.ts
export class CommentRepository implements ICommentRepository {
  private insertStmt: Database.Statement;
  private findByTaskIdStmt: Database.Statement;
  // ...

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO task_comments (task_id, author, content, created_at)
      VALUES (@task_id, @author, @content, @created_at)
    `);
    this.findByTaskIdStmt = db.prepare(
      'SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC'
    );
  }

  create(dto: CreateCommentDTO): Comment {
    const info = this.insertStmt.run({ ... });
    return this.findById(info.lastInsertRowid as number)!;
  }
}
```

### 5. Existing Command Handler Pattern with parseArgs

```typescript
// Source: src/slack/commands/tasks-command.ts
// Subscribe handler should follow this pattern:
async function handleSubscribe(
  respond: RespondFn,
  repo: SlackChannelSubscriptionRepository,
  projectService: ProjectService,
  command: SlashCommand,
  args: string[]
): Promise<void> {
  const { flags } = parseArgs(args);
  // Parse --project and --events flags
  // Validate project exists via projectService.getProject()
  // Insert subscription rows via repo.subscribe()
  // Respond ephemerally with confirmation
}
```

### 6. chat.postMessage Usage

```typescript
// Source: Slack Web API via Bolt App
// The app.client is a WebClient instance available when Slack is enabled
await app.client.chat.postMessage({
  channel: 'C01ABC123',    // Slack channel ID (not name)
  text: 'Task created: Fix login bug',  // Fallback for push notifications
  blocks: formatTaskNotification(event), // Block Kit blocks
});
```

### 7. SlackNotifier Design (recommended implementation)

```typescript
// Recommended: src/slack/notifier.ts
import type { WebClient } from '@slack/web-api';
import type { Logger } from 'pino';
import { eventBus } from '../events/event-bus.js';
import type { TaskEvent } from '../events/types.js';
import type { SlackChannelSubscriptionRepository } from './repositories/channel-subscription.repository.js';
import type { ProjectService } from '../services/project.service.js';
import { formatTaskNotification } from './task-formatter.js';

export class SlackNotifier {
  private unsubscribes: Array<() => void> = [];

  constructor(
    private readonly client: WebClient,
    private readonly subscriptionRepo: SlackChannelSubscriptionRepository,
    private readonly projectService: ProjectService,
    private readonly logger: Logger
  ) {}

  start(): void {
    const taskEvents = [
      'task.created',
      'task.updated',
      'task.status_changed',
      'task.claimed',
      'task.deleted',
    ] as const;

    for (const eventType of taskEvents) {
      this.unsubscribes.push(
        eventBus.subscribe(eventType, (event) => {
          // Fire-and-forget: catch errors internally
          this.handleTaskEvent(eventType, event).catch((err) =>
            this.logger.error({ err, eventType }, 'SlackNotifier: unhandled error')
          );
        })
      );
    }
  }

  stop(): void {
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
  }

  private async handleTaskEvent(eventType: string, event: TaskEvent): Promise<void> {
    const projectId = event.data.project_id;

    // Query which channels are subscribed to this project+event_type
    const channelIds = this.subscriptionRepo.findSubscribedChannels(projectId, eventType);
    if (channelIds.length === 0) return;

    // Resolve project name for notification formatting
    let projectName = `Project #${projectId}`;
    try {
      const project = this.projectService.getProject(projectId);
      projectName = project.name;
    } catch {
      // Project may have been deleted; use fallback
    }

    // Format the notification blocks (enhanced with project name)
    const blocks = formatTaskNotification(event, projectName);
    const fallbackText = `${eventType}: ${event.data.title}`;

    // Post to each channel independently -- one failure does not block others
    const results = await Promise.allSettled(
      channelIds.map((channelId) =>
        this.postWithRetry(channelId, blocks, fallbackText)
      )
    );

    // Log failures
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        this.logger.error(
          { err: result.reason, channelId: channelIds[i], eventType },
          'SlackNotifier: failed to post notification after retries'
        );
      }
    }
  }

  private async postWithRetry(
    channelId: string,
    blocks: KnownBlock[],
    text: string,
    maxRetries = 2
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.client.chat.postMessage({ channel: channelId, blocks, text });
        return;
      } catch (err: any) {
        // Don't retry permanent errors
        if (err.data?.error === 'not_in_channel' || err.data?.error === 'channel_not_found') {
          throw err; // Permanent failure
        }
        if (attempt === maxRetries) throw err;
        // Exponential backoff: 500ms, 1000ms
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
}
```

## Detailed Findings

### 1. EventBus Subscription Model

**Source:** `src/events/event-bus.ts` (verified by reading source)
**Confidence:** HIGH

The EventBus is a typed wrapper around Node.js `EventEmitter`. Key characteristics:

- `subscribe(event, handler)` returns a cleanup function for unsubscription
- Handlers are wrapped in `try { handler(payload) } catch` to prevent subscriber errors from crashing the bus
- `emit()` is synchronous -- all handlers execute in the same tick
- The handler signature is `(payload: Events[K]) => void` -- synchronous return type. Async handlers return `Promise<void>` which is ignored (the promise floats). The try/catch wrapper catches synchronous throws only, not async rejections.
- This means the SlackNotifier must handle its own async errors via `.catch()` on the Promise chain.

**Existing subscribers:**
- SSEManager: wired in `server.ts` lines 118-125 (one `subscribe` call per event type)
- WorkflowEngine: subscribes in its own `start()` method, stores unsubscribe functions for cleanup in `stop()`

### 2. slack_channel_subscriptions Table Design

**Source:** `src/db/migrations/006-slack-channel-subscriptions.ts` (verified by reading source)
**Confidence:** HIGH

**Columns:**
| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Row ID |
| `channel_id` | TEXT | NOT NULL | Slack channel ID (e.g., 'C01ABC123') |
| `project_id` | INTEGER | NOT NULL, FK to projects(id) ON DELETE CASCADE | Which project |
| `event_type` | TEXT | NOT NULL | Single event type string (e.g., 'task.created') |
| `created_at` | TEXT | NOT NULL, DEFAULT datetime('now') | Timestamp |

**Unique constraint:** `UNIQUE(channel_id, project_id, event_type)` -- prevents duplicate subscriptions.

**Important:** `project_id` is `NOT NULL` in the actual migration. This means you CANNOT subscribe a channel to "all projects" -- every subscription must specify a project. This constrains the subscribe command UX: `--project <id>` is required.

**Indexes:** Three separate indexes exist on `channel_id`, `project_id`, and `event_type`. The notification lookup query (`WHERE project_id = ? AND event_type = ?`) will use the `project_id` index with a filter on `event_type` -- efficient for the expected data size.

**CASCADE behavior:** When a project is deleted, all its subscriptions are automatically removed. This is verified by the migration test.

### 3. Slash Command Router (subscribe/unsubscribe stubs)

**Source:** `src/slack/commands/tasks-command.ts` (verified by reading source)
**Confidence:** HIGH

Contrary to the phase description mentioning "CLI-only stubs," the current command router has NO subscribe or unsubscribe cases at all. They are not among the CLI-only stubs (which are: backup, doctor, stats, db-check, completions). Typing `/tasks subscribe` currently returns "Unknown subcommand: `subscribe`".

**What needs to happen:**
1. Add `case 'subscribe':` and `case 'unsubscribe':` to the switch statement
2. Create handler functions following the existing pattern (ack already called, use respond for output)
3. The `registerTasksCommand` function signature needs extending to accept the `SlackChannelSubscriptionRepository` and `ProjectService` (or pass them through the `Services` interface)

**The existing `Services` interface** already includes `projectService` and `taskService`. The subscription repository will need to be added either to this interface or passed separately.

### 4. formatTaskNotification Current Output

**Source:** `src/slack/task-formatter.ts` lines 166-187 (verified by reading source)
**Confidence:** HIGH

The current formatter produces a single `SectionBlock` with mrkdwn text containing:
- Event label (e.g., "Task created") + actor
- Status emoji + task ID + title
- Priority indicator + assignee
- `/tasks show <id>` command reference

**Missing for NTFY-05:** Project name. The task data includes `project_id` (number) but not `project.name`. Options:
1. **Recommended:** Add an optional `projectName?: string` parameter to `formatTaskNotification()`. When provided, include it in the notification text. This keeps the formatter pure (no DB lookups) and lets the caller (SlackNotifier) resolve the name.
2. Alternative: Change the TaskEvent payload to include project name. This would require modifying TaskService event emission -- too invasive.

### 5. chat.postMessage via Bolt WebClient

**Source:** `@slack/bolt` bundled `@slack/web-api`, Slack official docs
**Confidence:** HIGH

The Bolt `App` instance exposes `app.client` which is a `WebClient`. In `server.ts`, the `slackApp` (returned by `slackService.getApp()`) provides this client.

```typescript
await app.client.chat.postMessage({
  channel: string,     // Channel ID (required) -- NOT channel name
  text: string,        // Fallback text (required for accessibility/push)
  blocks: KnownBlock[] // Block Kit blocks (optional, overrides text display)
});
```

**Key details:**
- `channel` must be a channel ID (e.g., 'C01ABC123'), not a channel name
- `text` is required even when `blocks` are provided -- it's used for push notifications and screen readers
- Requires `chat:write` OAuth scope (bot must be in channel) or `chat:write.public` (public channels without joining)
- The `@slack/web-api` automatically retries on rate limit (429) responses with exponential backoff
- Errors throw with `err.data.error` containing the Slack error code (e.g., 'not_in_channel', 'channel_not_found', 'token_revoked')

### 6. SlackChannelSubscriptionRepository Design

**Confidence:** HIGH (follows verified codebase patterns)

Required methods based on use cases:

| Method | Use Case | SQL Pattern |
|--------|----------|-------------|
| `subscribe(channelId, projectId, eventTypes[])` | `/tasks subscribe` command | INSERT OR REPLACE per (channel, project, event_type) triple |
| `unsubscribe(channelId, projectId?)` | `/tasks unsubscribe` command | DELETE WHERE channel_id = ? AND (project_id = ? or all) |
| `findSubscribedChannels(projectId, eventType)` | SlackNotifier event handler | SELECT DISTINCT channel_id WHERE project_id = ? AND event_type = ? |
| `findByChannel(channelId)` | Show current subscriptions | SELECT * WHERE channel_id = ? |

**subscribe() handles multiple event types:** Since the table stores one row per event type, subscribing to multiple event types means inserting multiple rows. Use `INSERT OR IGNORE` (not `INSERT OR REPLACE`) to avoid deleting `created_at` on re-subscription.

**Transaction for multi-row subscribe:** Wrap multiple INSERT statements in a `db.transaction()` for atomicity, following the existing migration pattern.

### 7. Retry Strategy for Slack API Errors

**Confidence:** HIGH

The `@slack/web-api` WebClient (bundled with Bolt) has built-in retry logic for rate-limited responses (HTTP 429). However, it does NOT retry other transient errors (network timeouts, 5xx responses).

**Recommended strategy for SlackNotifier:**
- **Transient errors (network, 5xx):** Retry up to 2 times with exponential backoff (500ms, 1000ms). Total max delay: 1.5 seconds.
- **Permanent errors:** Do NOT retry `not_in_channel`, `channel_not_found`, `invalid_auth`, `token_revoked`. Log and skip.
- **Rate limits:** Let the built-in `@slack/web-api` retry handler manage these (it uses `Retry-After` header).
- **Per-channel isolation:** Use `Promise.allSettled()` so one channel's failure does not block others.

**Why not a queue:** For a single-workspace tool with expected low volume (<50 notifications/minute), inline retry is simpler and sufficient. A persistent queue adds complexity without proportional benefit.

### 8. Server.ts Integration

**Source:** `src/api/server.ts` (verified by reading source)
**Confidence:** HIGH

The existing wiring in `server.ts` provides the integration blueprint:

1. **SlackService is already created** (lines 137-141) and started (line 220)
2. **Bolt App is already extracted** (line 223: `const slackApp = slackService.getApp()`)
3. **Services are accessible** via the `app` object from `createApp()`
4. **Shutdown hooks exist** (lines 144-150) -- add `slackNotifier.stop()` here

**Integration points to add:**
```
After line 236 (registerTasksCommand), add:
1. Create SlackChannelSubscriptionRepository(app.db)
2. Create SlackNotifier(slackApp.client, subscriptionRepo, app.projectService, server.log)
3. Call slackNotifier.start()
4. Pass subscriptionRepo to registerTasksCommand (extend its parameters)
5. Add slackNotifier.stop() to the onClose hook
```

**The registerTasksCommand function** needs to accept the subscription repository. Two options:
- Add it to the existing `Services` interface
- Pass it as a fourth parameter

Recommended: Pass as a fourth parameter (optional) since it's Slack-specific and the `Services` interface is shared with test mocks. If the repository is `undefined` (e.g., in tests), the subscribe/unsubscribe handlers respond with "not available".

## State of the Art

| Old Approach (from architecture research) | Actual Codebase | Impact |
|------------------------------------------|-----------------|--------|
| JSON array column for event_types | One row per event_type | Simpler queries; no json_each() needed |
| SlackChannelRepository in `src/slack/repositories/` | Follow existing `src/repositories/` pattern | Repository goes in `src/slack/repositories/` per architecture doc convention |
| Separate subscription-commands.ts | Commands added to existing tasks-command.ts switch | Simpler -- no new file for 2 command handlers |

**Note:** The ARCHITECTURE_SLACK.md research document proposed a `slack_channel_subscriptions` table with `event_types TEXT DEFAULT '[]'` (JSON array). The actual migration 006 uses individual rows with `event_type TEXT NOT NULL`. The actual migration is the source of truth.

## Open Questions

1. **Default event types for subscribe command**
   - What we know: The table requires an explicit `event_type` per row. Users must specify which events they want.
   - What's unclear: Should `/tasks subscribe --project 1` (no `--events` flag) subscribe to a default set of event types?
   - Recommendation: Default to `['task.created', 'task.status_changed']` when `--events` is not specified. These are the most commonly useful notification events.

2. **Notification for project events (project.created, project.updated)**
   - What we know: EventBus has `project.created`, `project.updated`, `project.deleted` events. The `slack_channel_subscriptions` table can store these event types.
   - What's unclear: Should the notifier also handle project events, or only task events?
   - Recommendation: Phase 26 requirements only mention task events (NTFY-01: "task event notifications"). Limit to task events. Project event notifications can be added later.

3. **How to pass SlackChannelSubscriptionRepository to command handlers**
   - What we know: `registerTasksCommand` currently takes `(app, services, identityCache)`.
   - What's unclear: Best way to extend without breaking existing tests.
   - Recommendation: Add an optional fourth parameter: `subscriptionRepo?: SlackChannelSubscriptionRepository`. When undefined, subscribe/unsubscribe handlers respond with "Slack notifications not configured."

## Sources

### Primary (HIGH confidence)
- `src/events/event-bus.ts` -- EventBus implementation, subscribe/emit pattern, error handling
- `src/events/sse-manager.ts` -- Reference subscriber pattern (broadcast, matchesFilters)
- `src/events/types.ts` -- TaskEvent, ProjectEvent, EventPayload types
- `src/db/migrations/006-slack-channel-subscriptions.ts` -- Actual table schema
- `src/db/__tests__/migration-006.test.ts` -- Verified table behavior (unique constraint, cascade, indexes)
- `src/slack/task-formatter.ts` -- `formatTaskNotification()` implementation
- `src/slack/commands/tasks-command.ts` -- Command router structure, parseArgs, respondBlocks/respondError
- `src/services/slack.service.ts` -- SlackService lifecycle (start/stop/getApp/isEnabled)
- `src/api/server.ts` -- Full startup wiring, EventBus-to-SSEManager pattern, Slack integration point
- `src/repositories/comment.repository.ts` -- Repository pattern reference (prepared statements)
- `src/index.ts` -- createApp() factory, service initialization order
- `src/services/task.service.ts` -- Event emission pattern (task.created, task.updated, task.status_changed)

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE_SLACK.md` -- Pre-implementation architecture design (some details differ from actual implementation)
- `.planning/research/PITFALLS.md` -- Slack-specific pitfalls (not_in_channel, async handler errors, rate limits)
- `.planning/research/STACK.md` -- Slack integration patterns, chat.postMessage usage

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already installed and in use
- Architecture: HIGH -- all patterns verified against actual source code
- Pitfalls: HIGH -- verified against existing EventBus behavior and Slack SDK docs
- Table schema: HIGH -- verified against actual migration and tests

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (stable -- no external dependency changes expected)
