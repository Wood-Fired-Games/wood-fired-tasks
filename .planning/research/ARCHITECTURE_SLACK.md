# Architecture Research: Slack Interface Integration

**Domain:** Slack as a fourth interface to an existing Fastify/EventBus/service-layer application
**Researched:** 2026-02-17
**Confidence:** HIGH (Bolt SDK patterns), MEDIUM (channel subscription storage design)

---

## Context: Existing Architecture

Before describing new components, the existing system structure:

```
┌──────────────────────────────────────────────────────────────┐
│                    Interface Layer                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │ Fastify REST │  │  MCP Server  │  │     CLI      │        │
│  │ src/api/     │  │  src/mcp/    │  │  src/cli/    │        │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │
├─────────┴─────────────────┴─────────────────┴────────────────┤
│                    Service Layer                              │
│  TaskService  ProjectService  DependencyService  CommentSvc  │
├──────────────────────────────────────────────────────────────┤
│               EventBus (typed pub/sub, in-memory)            │
│  task.created  task.updated  task.status_changed  task.claimed│
│  project.created  project.updated  project.deleted           │
├──────────────────────────────────────────────────────────────┤
│                   Repository Layer                           │
│  TaskRepository  ProjectRepository  DependencyRepository     │
├──────────────────────────────────────────────────────────────┤
│             SQLite (better-sqlite3, WAL mode)                │
└──────────────────────────────────────────────────────────────┘
```

**Key integration point for Slack:** The EventBus singleton (`src/events/event-bus.ts`) is the bridge. Any new subscriber simply calls `eventBus.subscribe('task.created', handler)` and receives typed payloads. The service layer is already accessible directly via constructor injection.

---

## Target Architecture with Slack Interface

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Interface Layer                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Fastify REST │  │  MCP Server  │  │   CLI    │  │   SLACK    │  │
│  │  src/api/    │  │  src/mcp/    │  │ src/cli/ │  │ src/slack/ │  │
│  └──────┬───────┘  └──────┬───────┘  └────┬─────┘  └─────┬──────┘  │
│         │                 │               │              │          │
│         │ (REST)     (direct inject)  (HTTP client) (direct inject) │
├─────────┴─────────────────┴───────────────┴──────────────┴──────────┤
│                          Service Layer                               │
│     TaskService  ProjectService  DependencyService  CommentService  │
├──────────────────────────────────────────────────────────────────────┤
│                  EventBus (typed pub/sub, in-memory)                 │
│  ◄── SSEManager subscribes    ◄── WorkflowEngine subscribes         │
│  ◄── SlackNotifier subscribes (NEW)                                 │
├──────────────────────────────────────────────────────────────────────┤
│                        Repository Layer                              │
├──────────────────────────────────────────────────────────────────────┤
│                   SQLite (better-sqlite3, WAL mode)                 │
│  + slack_channel_subscriptions table (NEW)                          │
└──────────────────────────────────────────────────────────────────────┘

External:
┌──────────────┐    WebSocket (Socket Mode)    ┌───────────┐
│  Slack Cloud │ ◄──────────────────────────── │ Bolt App  │
│  Platform    │ ──────────────────────────────►│ (in proc) │
└──────────────┘    (persistent connection)    └───────────┘
```

---

## New Components Required

### Component 1: `SlackApp` (Bolt App wrapper)

**File:** `src/slack/app.ts`
**Responsibility:** Owns the Bolt `App` instance, Socket Mode lifecycle (connect/disconnect), and registers all command and event handlers.

**What it does:**
- Creates `new App({ token, appToken, socketMode: true })`
- Calls `app.start()` on startup and `app.stop()` on shutdown
- Registers slash command handlers via `app.command('/task-*', ...)`
- Passes `app.client` to `SlackNotifier` for outbound messages

**Integration with existing architecture:** `SlackApp` receives the same service instances that `createServer()` already wires — `taskService`, `projectService`, etc. It is initialized in the same startup sequence as the Fastify server (in `src/api/start.ts` or a new `src/slack/start.ts`).

```typescript
// src/slack/app.ts
import { App } from '@slack/bolt';
import { TaskService } from '../services/task.service.js';
import { ProjectService } from '../services/project.service.js';
import { registerCommandHandlers } from './commands/index.js';
import { SlackNotifier } from './notifier.js';

export async function createSlackApp(
  taskService: TaskService,
  projectService: ProjectService,
  notifier: SlackNotifier
): Promise<App> {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  registerCommandHandlers(app, taskService, projectService);

  return app;
}
```

---

### Component 2: Command Handlers (`src/slack/commands/`)

**Files:** `src/slack/commands/index.ts`, `src/slack/commands/task-commands.ts`, `src/slack/commands/project-commands.ts`
**Responsibility:** One handler per slash command. Each handler: (1) calls `ack()` immediately, (2) calls the service layer, (3) formats a Block Kit response, (4) calls `respond()`.

**Pattern — the 3-step handler:**

```typescript
// src/slack/commands/task-commands.ts
import type { App } from '@slack/bolt';
import type { TaskService } from '../../services/task.service.js';
import { formatTaskBlock } from '../blocks/task-blocks.js';

export function registerTaskCommands(app: App, taskService: TaskService): void {
  app.command('/tasks-list', async ({ command, ack, respond }) => {
    // Step 1: ACK within 3 seconds — Slack requires this
    await ack();

    try {
      // Step 2: Call service layer — same layer REST API uses
      const tasks = taskService.listTasks({ project_id: parseProject(command.text) });

      // Step 3: Respond with Block Kit
      await respond({
        response_type: 'ephemeral', // visible only to caller
        blocks: formatTaskBlock(tasks),
      });
    } catch (err) {
      await respond({ text: `Error: ${err.message}` });
    }
  });

  app.command('/task-create', async ({ command, ack, respond }) => {
    await ack();
    // parse command.text for title/project, call taskService.createTask()
    // respond() with confirmation block
  });
}
```

**Critical constraint:** `ack()` MUST be called within 3000ms or Slack shows an error to the user. Call it first, then do work. Use `respond()` (not `say()`) for slash command follow-up messages — `say()` is for message event handlers.

---

### Component 3: Block Kit Formatters (`src/slack/blocks/`)

**Files:** `src/slack/blocks/task-blocks.ts`, `src/slack/blocks/project-blocks.ts`
**Responsibility:** Pure functions that take domain types (`Task`, `Project`) and return Slack Block Kit JSON arrays. No service calls, no side effects.

**Why separate:** Keeps formatting logic testable in isolation, allows consistent visual style across commands and notifications.

```typescript
// src/slack/blocks/task-blocks.ts
import type { KnownBlock } from '@slack/bolt';
import type { Task } from '../../types/task.js';

export function formatTaskBlock(task: Task & { tags: string[] }): KnownBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Task #${task.id}: ${task.title}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status:* ${task.status}` },
        { type: 'mrkdwn', text: `*Project:* ${task.project_id}` },
        { type: 'mrkdwn', text: `*Priority:* ${task.priority ?? 'none'}` },
        { type: 'mrkdwn', text: `*Assignee:* ${task.assignee ?? 'unassigned'}` },
      ],
    },
  ];
}

export function formatTaskListBlock(tasks: Array<Task & { tags: string[] }>): KnownBlock[] {
  if (tasks.length === 0) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: 'No tasks found.' } }];
  }
  return tasks.flatMap((task) => [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*#${task.id}* ${task.title} — \`${task.status}\``,
      },
    },
    { type: 'divider' },
  ]);
}
```

**Type source:** `@slack/bolt` exports `KnownBlock` — use this instead of `any[]` for compile-time validation of block structure.

---

### Component 4: `SlackNotifier` (`src/slack/notifier.ts`)

**Responsibility:** Subscribes to EventBus events and posts notifications to configured Slack channels using `app.client.chat.postMessage`. Reads per-channel subscription config from `SlackChannelRepository`.

**Why a separate class (not inline in `SlackApp`):** The notifier needs its own lifecycle — subscribing to EventBus on startup, unsubscribing on shutdown. Keeping it separate follows the same pattern as `SSEManager` (which also subscribes to EventBus in `server.ts`).

```typescript
// src/slack/notifier.ts
import type { WebClient } from '@slack/web-api';
import { eventBus } from '../events/event-bus.js';
import type { SlackChannelRepository } from './repositories/channel.repository.js';
import { formatTaskNotificationBlock } from './blocks/task-blocks.js';

export class SlackNotifier {
  private unsubscribes: Array<() => void> = [];

  constructor(
    private readonly client: WebClient,
    private readonly channelRepo: SlackChannelRepository
  ) {}

  start(): void {
    this.unsubscribes.push(
      eventBus.subscribe('task.created', (event) => this.onTaskEvent('task.created', event)),
      eventBus.subscribe('task.status_changed', (event) => this.onTaskEvent('task.status_changed', event)),
      eventBus.subscribe('task.claimed', (event) => this.onTaskEvent('task.claimed', event))
    );
  }

  stop(): void {
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
  }

  private async onTaskEvent(eventType: string, event: TaskEvent): Promise<void> {
    const projectId = event.data.project_id;

    // Look up which channels care about this project + event type
    const channels = this.channelRepo.findSubscribed(projectId, eventType);

    for (const channel of channels) {
      try {
        await this.client.chat.postMessage({
          channel: channel.slack_channel_id,
          text: `Task update: ${event.data.title}`, // fallback for notifications
          blocks: formatTaskNotificationBlock(eventType, event),
        });
      } catch (err) {
        console.error(`Failed to notify ${channel.slack_channel_id}:`, err);
      }
    }
  }
}
```

**Key design decisions:**
- Errors in one channel notification do NOT stop others (try/catch per channel)
- `text` field is always set as fallback for push notifications (Slack requirement)
- Fire-and-forget per channel, same pattern as `SSEManager.sendEvent()`

---

### Component 5: `SlackChannelRepository` (`src/slack/repositories/channel.repository.ts`)

**Responsibility:** CRUD for the `slack_channel_subscriptions` table. Answers "which Slack channels want notifications for project X and event type Y?"

**New database table:**

```sql
-- Migration: 006-slack-channel-subscriptions.ts
CREATE TABLE IF NOT EXISTS slack_channel_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slack_channel_id TEXT NOT NULL,       -- e.g. 'C01ABC123'
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  event_types TEXT NOT NULL DEFAULT '[]', -- JSON array: ["task.created","task.status_changed"]
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(slack_channel_id, project_id)
);
```

**Repository interface:**

```typescript
// src/slack/repositories/channel.repository.ts
export interface ChannelSubscription {
  id: number;
  slack_channel_id: string;
  project_id: number | null;  // null = subscribe to all projects
  event_types: string[];      // parsed from JSON column
}

export class SlackChannelRepository {
  constructor(private readonly db: Database) {}

  subscribe(channelId: string, projectId: number | null, eventTypes: string[]): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO slack_channel_subscriptions
        (slack_channel_id, project_id, event_types)
      VALUES (?, ?, json(?))
    `).run(channelId, projectId, JSON.stringify(eventTypes));
  }

  findSubscribed(projectId: number, eventType: string): ChannelSubscription[] {
    return this.db.prepare(`
      SELECT * FROM slack_channel_subscriptions
      WHERE (project_id = ? OR project_id IS NULL)
        AND json_each.value = ?
      -- simplified; use json_each() for proper JSON array query
    `).all(projectId, eventType) as ChannelSubscription[];
  }

  unsubscribe(channelId: string, projectId: number | null): void {
    this.db.prepare(`
      DELETE FROM slack_channel_subscriptions
      WHERE slack_channel_id = ? AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))
    `).run(channelId, projectId, projectId);
  }
}
```

**Storage rationale:** Reuse the existing SQLite database. This subscription config is small, local, and needs to persist across restarts. Adding a new table follows the established pattern (migration files in `src/db/migrations/`). No Redis or separate store needed.

---

## Data Flow: Slash Command (Inbound)

```
User types: /tasks-list project:42

    Slack Cloud
        │
        │  WebSocket (Socket Mode)
        ▼
    @slack/bolt App (SocketModeReceiver)
        │
        │  app.command('/tasks-list', handler)
        ▼
    Command Handler (src/slack/commands/task-commands.ts)
        │
        ├─ 1. ack()                          ← must be < 3000ms
        │
        ├─ 2. taskService.listTasks({ project_id: 42 })
        │         │
        │         └─ TaskRepository.findAll({ project_id: 42 })
        │                  └─ SQLite SELECT
        │
        └─ 3. respond({ blocks: formatTaskListBlock(tasks) })
                    │
                    └─► Slack Cloud (via response_url HTTP POST)
                                │
                                └─► User sees Block Kit message
```

**Key:** Step 2 (service call + DB query) must complete fast enough that `respond()` fires within Slack's 30-minute response_url window. For typical SQLite queries this is milliseconds. No concern in practice.

---

## Data Flow: EventBus Notification (Outbound)

```
Any interface triggers a service change:

    REST API / MCP / CLI / Slack command
        │
        ▼
    TaskService.updateTask()
        │
        ├─ TaskRepository.update() → SQLite WRITE
        │
        └─ eventBus.emit('task.status_changed', event)
                │
                ├─► SSEManager.broadcast()        ← existing subscriber
                ├─► WorkflowEngine.handle()       ← existing subscriber
                └─► SlackNotifier.onTaskEvent()   ← NEW subscriber
                          │
                          ├─ channelRepo.findSubscribed(projectId, 'task.status_changed')
                          │       └─ SQLite SELECT on slack_channel_subscriptions
                          │
                          └─ app.client.chat.postMessage({ channel, blocks })
                                    │
                                    └─► Slack Cloud HTTP API
                                              │
                                              └─► Subscribed channel receives notification
```

**Critical:** EventBus subscribers execute synchronously (Node.js `EventEmitter.emit()` is synchronous). `SlackNotifier.onTaskEvent()` is `async` and fires Slack's HTTP call without blocking the EventBus dispatch. The `await` inside `onTaskEvent` is awaited internally — the EventBus handler wrapper in `event-bus.ts` catches thrown errors but does not await async handlers. This is the same pattern already used by SSEManager.

---

## System Startup Sequence

```
src/api/start.ts (or new src/start-all.ts)
    │
    ├─ createApp()                   ← existing: DB init, services, WorkflowEngine
    │       returns { taskService, projectService, ... }
    │
    ├─ createServer(app)             ← existing: Fastify + routes + SSEManager + EventBus wiring
    │
    ├─ createSlackApp(services)      ← NEW: Bolt App + command handlers
    │       │
    │       ├─ new SlackChannelRepository(db)
    │       ├─ new SlackNotifier(boltApp.client, channelRepo)
    │       ├─ notifier.start()      ← subscribes to EventBus
    │       └─ returns { boltApp, notifier }
    │
    ├─ server.listen()               ← starts Fastify HTTP server
    └─ boltApp.start()               ← opens WebSocket to Slack (no HTTP port needed)

Shutdown (SIGTERM / onClose hooks):
    ├─ server.close()               ← Fastify: drains connections
    ├─ notifier.stop()              ← unsubscribes from EventBus
    └─ boltApp.stop()               ← closes WebSocket
```

---

## New vs. Modified Components

### New Components

| Component | File | Description |
|-----------|------|-------------|
| `SlackApp` factory | `src/slack/app.ts` | Creates and configures Bolt `App` with Socket Mode |
| Command handlers | `src/slack/commands/index.ts` | Routes slash commands to handlers |
| Task commands | `src/slack/commands/task-commands.ts` | `/tasks-list`, `/task-create`, `/task-update`, `/task-claim` |
| Project commands | `src/slack/commands/project-commands.ts` | `/projects-list`, `/project-show` |
| Block Kit formatters | `src/slack/blocks/task-blocks.ts` | `formatTaskBlock()`, `formatTaskListBlock()`, `formatTaskNotificationBlock()` |
| Block Kit formatters | `src/slack/blocks/project-blocks.ts` | `formatProjectBlock()` |
| `SlackNotifier` | `src/slack/notifier.ts` | EventBus subscriber → `chat.postMessage` |
| `SlackChannelRepository` | `src/slack/repositories/channel.repository.ts` | Subscription config persistence |
| Subscription commands | `src/slack/commands/subscription-commands.ts` | `/notify-subscribe`, `/notify-unsubscribe` |
| DB migration | `src/db/migrations/006-slack-channel-subscriptions.ts` | New table |
| Config additions | `src/config/env.ts` | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` env vars |

### Modified Components

| Component | File | Change |
|-----------|------|--------|
| `configSchema` | `src/config/env.ts` | Add `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (optional — Slack disabled if absent) |
| Startup entry point | `src/api/start.ts` | Initialize Bolt App alongside Fastify; add shutdown hooks |
| `createApp()` | `src/index.ts` | Pass `db` to `SlackChannelRepository`; or construct in start.ts |

**Nothing in the service layer or EventBus changes.** The Slack interface is a pure consumer of existing infrastructure.

---

## Recommended Project Structure

```
src/
├── slack/                              # NEW: Slack interface
│   ├── app.ts                          # Bolt App factory + lifecycle
│   ├── notifier.ts                     # EventBus subscriber → chat.postMessage
│   ├── commands/
│   │   ├── index.ts                    # Registers all command handlers on App
│   │   ├── task-commands.ts            # /tasks-list, /task-create, /task-update, /task-claim
│   │   ├── project-commands.ts         # /projects-list, /project-show
│   │   └── subscription-commands.ts   # /notify-subscribe, /notify-unsubscribe
│   ├── blocks/
│   │   ├── task-blocks.ts              # Block Kit formatters for tasks
│   │   └── project-blocks.ts          # Block Kit formatters for projects
│   ├── repositories/
│   │   └── channel.repository.ts      # CRUD for slack_channel_subscriptions
│   └── __tests__/
│       ├── notifier.test.ts
│       ├── task-commands.test.ts
│       └── task-blocks.test.ts
├── db/
│   └── migrations/
│       └── 006-slack-channel-subscriptions.ts   # NEW
├── config/
│   └── env.ts                          # MODIFIED: add Slack env vars
└── api/
    └── start.ts                        # MODIFIED: init Bolt alongside Fastify
```

---

## Architectural Patterns

### Pattern 1: Ack-Then-Work

**What:** Call `ack()` at the very start of every slash command handler, then do the work, then call `respond()`.

**When to use:** Every slash command handler, every interactive component handler (buttons, selects, modals).

**Trade-offs:** Response must come via `respond()` (response_url), not return value. The response_url is valid for 30 minutes and can be called up to 5 times.

```typescript
app.command('/task-create', async ({ command, ack, respond }) => {
  await ack(); // First. Always. No exceptions.

  const task = taskService.createTask(parseInput(command.text));
  await respond({ blocks: formatTaskBlock(task) });
});
```

### Pattern 2: EventBus-to-Slack Bridge

**What:** `SlackNotifier` subscribes to the existing EventBus and translates domain events into Slack messages, filtered by per-channel subscription config.

**When to use:** Any time domain events need to push to Slack channels.

**Trade-offs:**
- Pro: Zero changes to service layer or EventBus
- Pro: Follows same pattern as SSEManager (already works)
- Con: Notifications are fire-and-forget; Slack delivery errors are logged but not retried
- Con: If process restarts, in-flight notifications are lost (acceptable for this use case)

### Pattern 3: Subscription Config in SQLite

**What:** Store Slack channel → project → event_type mappings in a `slack_channel_subscriptions` table in the existing SQLite database.

**When to use:** Persistent notification routing config that survives restarts.

**Trade-offs:**
- Pro: No additional infrastructure (reuses existing DB connection)
- Pro: Config persists across restarts (unlike in-memory approaches)
- Con: Querying JSON array column for event_type filtering requires SQLite json_each(); test this query carefully

### Pattern 4: Optional Slack (Feature Flag via Env)

**What:** If `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are not set, skip Slack initialization entirely. The service runs normally as REST/MCP/CLI only.

**When to use:** Development, testing, and deployments without Slack configured.

```typescript
// src/api/start.ts
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  const { boltApp, notifier } = await createSlackApp(services);
  notifier.start();
  await boltApp.start();
  // register shutdown hooks
}
```

---

## Anti-Patterns

### Anti-Pattern 1: Calling say() in Slash Command Handlers

**What people do:** Use `say()` instead of `respond()` in slash command handlers.

**Why it's wrong:** `say()` posts to the event's channel via the bot token — the bot must be a member of that channel. `respond()` uses the response_url, which works regardless of channel membership and posts ephemerally to the command caller by default.

**Do this instead:** Always use `respond()` for slash command replies. Reserve `say()` for `app.message()` handlers.

### Anti-Pattern 2: Async Notifier Blocking EventBus

**What people do:** Make the EventBus subscriber `await` the Slack HTTP call, blocking the synchronous EventBus dispatch.

**Why it's wrong:** Node.js EventEmitter is synchronous. If a handler awaits an HTTP call, it blocks all other EventBus subscribers from running until the HTTP call completes. Latency in Slack's API (or errors) will delay SSEManager broadcasts and WorkflowEngine processing.

**Do this instead:** The EventBus handler initiates the async work and returns without awaiting it. Catch errors inside the async function.

```typescript
// BAD: blocks EventBus dispatch
eventBus.subscribe('task.created', async (event) => {
  await this.client.chat.postMessage(...); // blocks all other subscribers
});

// GOOD: fire-and-forget, errors caught internally
eventBus.subscribe('task.created', (event) => {
  this.onTaskEvent(event).catch((err) => console.error('Slack notify failed:', err));
});
```

Note: The existing `EventBus.subscribe()` wraps handlers in try/catch but does NOT await async handlers — confirm this stays the case. See `event-bus.ts` line 42-49.

### Anti-Pattern 3: Exposing Internal IDs in Slack Command Responses

**What people do:** Display internal numeric task IDs as the primary identifier in all Slack responses.

**Why it's wrong:** Users copy-paste command invocations. `task_id=42` is opaque; `project=wood-bugs task-title=...` is usable. However, internal IDs are needed for service calls — keep them in Block Kit metadata (Block IDs, Action IDs) not visible text.

**Do this instead:** Display title + status + assignee prominently; put `task_id` in block metadata or only show it as a secondary reference.

### Anti-Pattern 4: One Monolithic Command Handler File

**What people do:** Register all 8+ slash commands in a single file.

**Why it's wrong:** Block Kit formatting logic mixed with command routing and service calls. Hard to test individual commands. Hard to find the right handler.

**Do this instead:** One file per domain (task-commands.ts, project-commands.ts, subscription-commands.ts), plus a separate blocks/ directory for formatters. Mirrors the existing pattern in `src/api/routes/tasks/`, `src/api/routes/projects/`.

---

## Build Order (considering dependencies)

The Slack interface has no external dependencies on other new features. Build in this order:

**Step 1: Config + Migration (prerequisite for everything)**
- Add `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` to `src/config/env.ts` (optional, not required)
- Create migration `006-slack-channel-subscriptions.ts` and run it
- Create `SlackChannelRepository` with tests

**Step 2: Block Kit Formatters (no dependencies, pure functions)**
- `src/slack/blocks/task-blocks.ts`
- `src/slack/blocks/project-blocks.ts`
- Unit tests: input Task/Project domain objects → verify Block Kit JSON structure

**Step 3: Command Handlers (depends on formatters + services)**
- `src/slack/commands/task-commands.ts`
- `src/slack/commands/project-commands.ts`
- `src/slack/commands/subscription-commands.ts`
- Tests with mock `ack()`, `respond()`, mock services

**Step 4: SlackNotifier (depends on EventBus + formatters + channel repo)**
- `src/slack/notifier.ts`
- Tests with mock EventBus and mock `app.client`

**Step 5: SlackApp factory + startup wiring (integration)**
- `src/slack/app.ts`
- Modify `src/api/start.ts` to init Bolt + register shutdown hooks
- Integration test: send test slash command payload → verify service called + response formatted

**Rationale for this order:** Formatters are pure functions with no deps — fast to build and test. Command handlers and notifier can be built in parallel (Step 3 and 4). Startup wiring is last because it depends on all pieces existing.

---

## Integration Points Summary

| Boundary | How Slack Connects | Notes |
|----------|--------------------|-------|
| Slack → App | WebSocket via Socket Mode | Bolt `SocketModeReceiver` manages connection; no HTTP port needed |
| Command handler → Service layer | Direct method call | Same as MCP server pattern; services are constructor-injected |
| EventBus → SlackNotifier | `eventBus.subscribe()` | Existing pub/sub; zero changes to EventBus or services |
| SlackNotifier → Slack | `app.client.chat.postMessage()` | HTTPS to Slack API; requires `chat:write` OAuth scope |
| Subscription config → DB | `SlackChannelRepository` via `db` instance | New table in existing SQLite file |
| Startup → Bolt lifecycle | `boltApp.start()` / `boltApp.stop()` | Registered alongside Fastify in start.ts |
| Config | Env vars validated via Zod | Add to existing `configSchema` in `src/config/env.ts` |

---

## Required OAuth Scopes and Tokens

| Token | Env Var | Source | Purpose |
|-------|---------|--------|---------|
| Bot OAuth token | `SLACK_BOT_TOKEN` | OAuth & Permissions page | Authenticate API calls (`chat.postMessage`, `chat:write` scope) |
| App-level token | `SLACK_APP_TOKEN` | Basic Information > App-Level Tokens | Socket Mode connection (`connections:write` scope) |

**Required bot OAuth scopes:**
- `chat:write` — post messages to channels bot is member of
- `chat:write.public` — post to public channels without joining
- `commands` — register slash commands
- `channels:read` — look up channel information (for subscription UX)

**Slack app manifest settings (Slack admin portal):**
- Socket Mode: enabled
- Slash commands: register each command (e.g., `/tasks-list`, `/task-create`) — these are configured in the Slack App UI, not in code

---

## Scaling Considerations

| Scale | Architecture Adjustment |
|-------|------------------------|
| Single workspace (current) | Monolithic Bolt App in same process as Fastify — no changes needed |
| Multiple workspaces | Bolt multi-workspace OAuth flow required; `SlackChannelRepository` needs `workspace_id` column |
| High notification volume | Consider async queue (simple in-memory queue with retry) between EventBus subscriber and `postMessage` calls |
| Rate limiting | Slack's `chat.postMessage` Tier 3: 50+ calls/minute. For bulk events, batch notifications or debounce by channel |

---

## Sources

- [@slack/bolt npm](https://www.npmjs.com/package/@slack/bolt) — Current version 4.6.0 (HIGH confidence)
- [@slack/web-api npm](https://www.npmjs.com/package/@slack/web-api) — Current version 7.14.1 (HIGH confidence)
- [@slack/socket-mode npm](https://www.npmjs.com/package/@slack/socket-mode) — Current version 2.0.5 (HIGH confidence)
- [Using Socket Mode — Slack Developer Docs](https://docs.slack.dev/apis/events-api/using-socket-mode/) — WebSocket connection flow (HIGH confidence)
- [Listening to slash commands — Bolt JS Docs](https://docs.slack.dev/tools/bolt-js/concepts/commands/) — ack/respond/say pattern (HIGH confidence)
- [Sending messages — Bolt JS Docs](https://docs.slack.dev/tools/bolt-js/concepts/message-sending/) — chat.postMessage outside handlers (HIGH confidence)
- [Bolt v3 → v4 Migration Guide](https://github.com/slackapi/bolt-js/wiki/Bolt-v3-%E2%80%90--v4-Migration-Guide) — TypeScript type changes (HIGH confidence)
- [Block Kit SectionBlock TypeScript interface](https://docs.slack.dev/tools/node-slack-sdk/reference/types/interfaces/SectionBlock/) — KnownBlock type (MEDIUM confidence — redirect chain)
- [chat.postMessage reference](https://docs.slack.dev/reference/methods/chat.postMessage) — required params + OAuth scopes (HIGH confidence)
- [Bolt TypeScript starter template](https://github.com/slack-samples/bolt-ts-starter-template) — project structure patterns (MEDIUM confidence)
- [Integrating Bolt with existing servers — GitHub Issue #212](https://github.com/slackapi/bolt-js/issues/212) — separate process patterns (MEDIUM confidence)

---

*Architecture research for: Slack interface integration — Wood Fired Bugs*
*Researched: 2026-02-17*
*Confidence: HIGH for Bolt SDK integration patterns, MEDIUM for per-channel subscription storage design (no single canonical pattern found; SQLite approach derived from existing codebase conventions)*
