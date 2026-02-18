# Phase 25: Slash Command Handlers - Research

**Researched:** 2026-02-17
**Domain:** @slack/bolt v4.x slash command registration, subcommand routing, Block Kit responses via respond(), UserIdentityCache write-path integration
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SCMD-01 | Single /tasks command with subcommand routing handles all 24 CLI operations | Bolt `app.command('/tasks', ...)` receives `command.text` with everything after `/tasks`; first token is the subcommand; parse with string split |
| SCMD-02 | All handlers call ack() within 3 seconds and use respond() for results | `ack()` must be the FIRST statement in the handler; respond() POSTs to response_url asynchronously after ack(); Block Kit blocks passed as `respond({ blocks, response_type: 'ephemeral' })` |
| SCMD-03 | /tasks help shows available subcommands with usage examples | Pure Block Kit response via `respond()`; formatted as `SectionBlock` with mrkdwn code spans; no service calls needed |
| SCMD-04 | /tasks list displays tasks with Block Kit formatting | Call `taskService.listTasks(filters)`, pipe through `formatTaskList()` from `src/slack/task-formatter.ts`; filters parsed from `command.text` args |
| SCMD-05 | /tasks show <id> displays task detail card with metadata, comments, dependencies | `taskService.getTask(id)` + `commentService.getComments(id)` + `dependencyService` calls; use `formatTaskDetail()` with optional comment/dep blocks appended |
| SCMD-06 | /tasks create <title> creates task, returns confirmation card | Resolve `command.user_id` via `UserIdentityCache.resolve()` for `created_by`; requires project_id arg; call `taskService.createTask()`; format with `formatTaskDetail()` |
| SCMD-07 | /tasks update <id> --status <status> updates task fields | Parse `--flag value` from `command.text`; call `taskService.updateTask(id, updates)`; return confirmation via `formatTaskDetail()` |
| SCMD-08 | /tasks claim <id> claims task using resolved display name | Resolve `command.user_id` via `UserIdentityCache.resolve()`; pass display name to `taskService.claimTask(id, displayName)`; satisfies UIDENT-03 |
| SCMD-09 | Project, dependency, comment, and subtask subcommands achieve full CLI parity | Services available: `projectService`, `dependencyService`, `commentService`, `taskService.getSubtasks()`; map all 24 CLI commands to subcommands |
| SCMD-10 | Error responses use Block Kit formatting with actionable messages | Catch errors from service layer; render `SectionBlock` with mrkdwn error text and usage hint; always use `respond()` not `say()` |

</phase_requirements>

---

## Summary

Phase 25 wires the @slack/bolt `app.command('/tasks', ...)` listener to the existing service layer (`TaskService`, `ProjectService`, `DependencyService`, `CommentService`) and the Block Kit formatters built in Phase 24. All user-visible state already exists — this phase is pure wiring with no new infrastructure.

The architecture is a **subcommand router**: one Bolt `app.command('/tasks', handler)` registration. Inside the handler, `command.text` is split into `[subcommand, ...args]`. A switch or map dispatches to an inner handler per subcommand. Every inner handler is async but the outer handler calls `await ack()` first (within 3 seconds), then awaits the service call and calls `respond()`.

The `UserIdentityCache` (built in Phase 24) closes the UIDENT-03 gap: handlers for `create` and `claim` call `await identityCache.resolve(command.user_id)` and pass the resolved display name as `created_by` or `assignee`. This is the only Phase 24 artifact not yet connected to production code.

**Primary recommendation:** Create `src/slack/commands/tasks-command.ts` with a single `registerTasksCommand(app, services, identityCache)` function called from `server.ts` after `slackService.start()`. Parse subcommand and args inside the handler; dispatch to per-subcommand async functions in the same file (or imported from submodule files for larger commands).

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @slack/bolt | 4.6.0 (installed) | `App.command()` for slash command registration; `SlashCommandMiddlewareArgs` for handler types; `ack()` and `respond()` provided via destructuring | Already installed in Phase 23; the only supported way to register slash commands with Socket Mode |
| @slack/types | ^2.20.0 (devDep, installed) | `KnownBlock`, `SectionBlock` etc. for type-safe Block Kit blocks in respond() calls | Already installed; all Phase 24 formatters use it |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| UserIdentityCache (src/slack/user-identity.ts) | Phase 24 artifact | Resolve Slack user_id to display name | Used in `create` and `claim` subcommand handlers |
| formatTaskList, formatTaskDetail, formatTaskNotification | src/slack/task-formatter.ts | Format task Block Kit responses | All task-returning subcommands |
| formatProjectList, formatProjectDetail | src/slack/formatters/project-formatter.ts | Format project Block Kit responses | All project-returning subcommands |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Single `/tasks` command + subcommand routing | Separate `/tasks-create`, `/tasks-list` etc. commands | Prior decision: single command. Multiple commands require separate Slack app slash command registrations and are harder to document/discover |
| respond() with response_type: 'ephemeral' | say() to post to channel | respond() sends back to the invoking user only (ephemeral), not channel-visible. Prior decisions say ephemeral for all slash command responses |
| Inline subcommand parsing | commander.js or yargs | No new deps; command.text is a simple string; inline split/parse is sufficient and avoids async commander complications in Bolt handlers |

**Installation:**
```bash
# No new packages needed — all dependencies already installed
```

---

## Architecture Patterns

### Recommended Project Structure
```
src/
├── slack/
│   ├── commands/
│   │   └── tasks-command.ts        # registerTasksCommand() + all subcommand handlers
│   │   └── __tests__/
│   │       └── tasks-command.test.ts
│   ├── formatters/
│   │   ├── project-formatter.ts    # Phase 24 (existing)
│   │   └── __tests__/
│   ├── task-formatter.ts           # Phase 24 (existing)
│   └── user-identity.ts            # Phase 24 (existing)
```

The handlers file is new. The formatters, UserIdentityCache, and SlackService are all Phase 24/23 artifacts consumed by this phase.

### Pattern 1: Slash Command Registration Entrypoint

**What:** A single exported function called from `server.ts` that registers the `/tasks` command on the Bolt `App` instance.

**When to use:** Called in `server.ts` after `slackService.start()`, guarded by `slackService.isEnabled()`.

```typescript
// Source: @slack/bolt App.d.ts — "command(commandName: string | RegExp, ...listeners): void"
// src/slack/commands/tasks-command.ts
import type { App } from '@slack/bolt';
import type { TaskService } from '../../services/task.service.js';
import type { ProjectService } from '../../services/project.service.js';
import type { DependencyService } from '../../services/dependency.service.js';
import type { CommentService } from '../../services/comment.service.js';
import type { UserIdentityCache } from '../user-identity.js';

interface Services {
  taskService: TaskService;
  projectService: ProjectService;
  dependencyService: DependencyService;
  commentService: CommentService;
}

export function registerTasksCommand(
  app: App,
  services: Services,
  identityCache: UserIdentityCache
): void {
  app.command('/tasks', async ({ ack, respond, command }) => {
    // ALWAYS ack() first — must complete within 3 seconds
    await ack();

    const [subcommand, ...args] = command.text.trim().split(/\s+/);

    try {
      switch (subcommand) {
        case 'list':
          await handleList(respond, services, args);
          break;
        case 'show':
          await handleShow(respond, services, args);
          break;
        case 'create':
          await handleCreate(respond, services, identityCache, command, args);
          break;
        case 'update':
          await handleUpdate(respond, services, args);
          break;
        case 'claim':
          await handleClaim(respond, services, identityCache, command, args);
          break;
        // ... (all other subcommands)
        case 'help':
        case '':
        case undefined:
          await handleHelp(respond);
          break;
        default:
          await respondError(respond, `Unknown subcommand: \`${subcommand}\``, 'Run `/tasks help` to see available subcommands.');
      }
    } catch (error) {
      await respondError(respond, formatServiceError(error));
    }
  });
}
```

**Key insight:** `ack()` returns `Promise<void>`. It MUST be awaited as the first statement. Everything after ack() has no time constraint — respond() uses the response_url webhook which is valid for 30 minutes.

### Pattern 2: The respond() Call with Block Kit

**What:** All visible output goes through `respond()` with Block Kit blocks. Use `response_type: 'ephemeral'` so only the invoking user sees the response (not posted to channel).

```typescript
// Source: @slack/bolt utilities.d.ts — RespondArguments extends ChatPostMessageArguments
// RespondFn = (message: string | RespondArguments) => Promise<any>
// RespondArguments has: response_type, replace_original, delete_original, blocks, text, ...

import type { RespondFn } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';

async function respondBlocks(
  respond: RespondFn,
  blocks: KnownBlock[],
  fallbackText: string
): Promise<void> {
  await respond({
    response_type: 'ephemeral',
    blocks,
    text: fallbackText, // accessibility fallback for screen readers / push notifications
  });
}
```

**Important:** `respond()` is NOT `say()`. `say()` posts to the channel and requires the message to be visible to everyone. `respond()` uses the response_url and defaults to ephemeral (only visible to the invoking user). Always prefer `respond()` for slash command handlers.

### Pattern 3: UIDENT-03 Write-Path Integration (claim and create)

**What:** Before writing `created_by` or `assignee` to the DB, resolve the Slack user ID to a display name.

```typescript
// Source: Phase 24 UserIdentityCache — resolve(userId) → Promise<string>
// UIDENT-03 requirement: "tasks created/claimed via Slack show the resolved display name in CLI/REST/MCP views"

async function handleClaim(
  respond: RespondFn,
  services: Services,
  identityCache: UserIdentityCache,
  command: SlashCommand,
  args: string[]
): Promise<void> {
  const id = parseInt(args[0] ?? '', 10);
  if (isNaN(id)) {
    await respondError(respond, 'Invalid task ID. Usage: `/tasks claim <id>`');
    return;
  }

  // UIDENT-03: resolve Slack user ID to display name BEFORE writing to DB
  const displayName = await identityCache.resolve(command.user_id);
  const task = services.taskService.claimTask(id, displayName);

  await respondBlocks(
    respond,
    formatTaskDetail(task),
    `Task #${task.id} claimed by ${task.assignee}`
  );
}
```

### Pattern 4: Subcommand Argument Parsing (no commander.js)

**What:** `command.text` contains everything typed after `/tasks`. Parse inline — no external parser.

```typescript
// command.text examples:
// "list"
// "list --status open --project 5"
// "show 42"
// "create Fix login bug --project 3 --priority high"
// "update 42 --status done"
// "claim 42"
// "project-create My Project"
// "comment-add 42 --author Stuart --content 'Great work'"

function parseArgs(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1] ?? '';
      flags[key] = value;
      i++; // skip next arg (it's the value)
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}
```

**Important limitation:** Slack delivers `command.text` as a plain string — no shell quoting. Titles with spaces must use the rest of the positional text: `"create Fix login bug"` means the title is `"Fix login bug"`. Flags stop at the first `--flag` token, so `create Fix the bug --project 3` can work if you join positionals before the first flag.

### Pattern 5: Error Response Block Kit Format

**What:** All errors respond with a Block Kit `SectionBlock` containing mrkdwn error text and an actionable hint.

```typescript
// Source: @slack/types SectionBlock verified in Phase 24
async function respondError(
  respond: RespondFn,
  message: string,
  hint?: string
): Promise<void> {
  const text = hint ? `${message}\n${hint}` : message;
  await respond({
    response_type: 'ephemeral',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:x: ${text}` },
      },
    ],
    text: message, // fallback
  });
}

function formatServiceError(error: unknown): string {
  if (error instanceof NotFoundError) return `Not found: ${error.message}`;
  if (error instanceof ValidationError) return `Validation error: ${JSON.stringify(error.fieldErrors)}`;
  if (error instanceof BusinessError) return error.message;
  return 'An unexpected error occurred';
}
```

### Pattern 6: Registration in server.ts

**What:** After `slackService.start()`, construct `UserIdentityCache` once and register the command handler.

```typescript
// server.ts additions after slackService.start():
import { registerTasksCommand } from '../slack/commands/tasks-command.js';
import { UserIdentityCache } from '../slack/user-identity.js';

// After: await slackService.start();
const slackApp = slackService.getApp();
if (slackApp) {
  const identityCache = new UserIdentityCache(slackApp.client);
  registerTasksCommand(
    slackApp,
    {
      taskService: app.taskService,
      projectService: app.projectService,
      dependencyService: app.dependencyService,
      commentService: app.commentService,
    },
    identityCache
  );
  server.log.info('Slack /tasks command handler registered');
}
```

**Important:** `UserIdentityCache` is constructed ONCE (not per-request) to preserve cache state across multiple slash command invocations. The `app` in `server.ts` is the application `App` object (from `createApp()`) — not the Bolt `App` (`slackService.getApp()`). These two `App` names conflict in scope — use explicit aliasing or rename.

### Pattern 7: Complete Subcommand Inventory

Based on the 25 CLI command files, here is the full mapping. Note that CLI commands call the REST API (`/api/v1/...`) while slash command handlers call services directly:

**Task commands (service: TaskService):**
| CLI command | Subcommand | Service method | Notes |
|-------------|------------|----------------|-------|
| `tasks list` | `list` | `taskService.listTasks(filters)` | Filters: --status, --project, --assignee, --search, --tags |
| `tasks show <id>` | `show <id>` | `taskService.getTask(id)` | SCMD-05 also shows comments/deps |
| `tasks create` | `create <title>` | `taskService.createTask({...})` | Requires project_id arg; created_by from identity cache |
| `tasks update <id>` | `update <id> --field val` | `taskService.updateTask(id, updates)` | Flags: --status, --title, --priority, --assignee, --due |
| `tasks delete <id>` | `delete <id>` | `taskService.deleteTask(id)` | Destructive — consider confirm text response |
| `tasks claim <id>` | `claim <id>` | `taskService.claimTask(id, displayName)` | UIDENT-03: resolve user_id before calling |

**Project commands (service: ProjectService):**
| CLI command | Subcommand | Service method |
|-------------|------------|----------------|
| `tasks project-create` | `project-create <name>` | `projectService.createProject({...})` |
| `tasks project-list` | `project-list` | `projectService.listProjects()` |
| `tasks project-show <id>` | `project-show <id>` | `projectService.getProject(id)` |
| `tasks project-update <id>` | `project-update <id> --field val` | `projectService.updateProject(id, updates)` |
| `tasks project-delete <id>` | `project-delete <id>` | `projectService.deleteProject(id)` |

**Dependency commands (service: DependencyService):**
| CLI command | Subcommand | Service method |
|-------------|------------|----------------|
| `tasks dep-add <id> <blocks-id>` | `dep-add <id> <blocks-id>` | `dependencyService.addDependency({task_id, blocks_task_id})` |
| `tasks dep-list <id>` | `dep-list <id>` | `dependencyService.getBlockedBy(id)` + `getBlockers(id)` |
| `tasks dep-remove <id> <blocks-id>` | `dep-remove <id> <blocks-id>` | `dependencyService.removeDependency(id, blocksId)` |

**Comment commands (service: CommentService):**
| CLI command | Subcommand | Service method |
|-------------|------------|----------------|
| `tasks comment-add <id>` | `comment-add <id> <content>` | `commentService.addComment({task_id, author: displayName, content})` |
| `tasks comment-list <id>` | `comment-list <id>` | `commentService.getComments(id)` |
| `tasks comment-delete <task-id> <comment-id>` | `comment-delete <task-id> <comment-id>` | `commentService.deleteComment(commentId)` |

**Subtask commands (service: TaskService):**
| CLI command | Subcommand | Service method |
|-------------|------------|----------------|
| `tasks subtask-create <parent-id>` | `subtask-create <parent-id> <title>` | `taskService.createTask({...parent_task_id})` |
| `tasks subtask-list <parent-id>` | `subtask-list <parent-id>` | `taskService.getSubtasks(parentId)` |

**Operational commands — CLI-only, no service layer equivalent:**
| CLI command | Subcommand | Approach |
|-------------|------------|----------|
| `tasks health` | `health` | Call `taskService.listTasks({})` with count — or call REST API health endpoint; service layer has no health method. Simple "service is online" response. |
| `tasks backup` | N/A — CLI-only | No service layer. Responds with informational message: "Use the CLI: `tasks backup`" |
| `tasks doctor` | N/A — CLI-only | No service layer. Responds with informational message. |
| `tasks stats` | N/A — CLI-only (accesses DB directly) | No service method. Can approximate with `taskService.countTasks()` and `taskService.listTasks()`. |
| `tasks db-check` | N/A — CLI-only (accesses DB directly) | No service layer. Inform user to run CLI command. |
| `tasks completions` | N/A — CLI-only | Shell completions don't apply in Slack. Respond with not-applicable message. |

**Count:** 20 service-backed subcommands + 6 operational (5 CLI-only, 1 health approximation) = 26 total. The requirement says "24 CLI operations" — there are 25 CLI command files (including completions which is shell-specific). The Phase description says "every CLI operation accessible from Slack" but notes "backup, doctor, stats, db-check, completions" are CLI-only. Plan for 20 fully-backed + 6 informational stubs.

### Pattern 8: help Subcommand Format

```typescript
// SCMD-03: /tasks help shows available subcommands with usage examples
const HELP_BLOCKS: KnownBlock[] = [
  {
    type: 'header',
    text: { type: 'plain_text', text: 'Tasks — Available Commands', emoji: true },
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*Task commands*',
        '`/tasks list [--status open] [--project 3] [--assignee name]`',
        '`/tasks show <id>`',
        '`/tasks create <title> --project <id> [--priority high]`',
        '`/tasks update <id> --status done [--assignee name]`',
        '`/tasks claim <id>`',
        '`/tasks delete <id>`',
      ].join('\n'),
    },
  },
  { type: 'divider' },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*Project commands*',
        '`/tasks project-list`',
        '`/tasks project-show <id>`',
        '`/tasks project-create <name>`',
        '`/tasks project-update <id> --name <name>`',
        '`/tasks project-delete <id>`',
      ].join('\n'),
    },
  },
  { type: 'divider' },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        '*Dependency, Comment & Subtask commands*',
        '`/tasks dep-add <id> <blocks-id>`',
        '`/tasks dep-list <id>`',
        '`/tasks dep-remove <id> <blocks-id>`',
        '`/tasks comment-add <id> <content>`',
        '`/tasks comment-list <id>`',
        '`/tasks comment-delete <task-id> <comment-id>`',
        '`/tasks subtask-create <parent-id> <title>`',
        '`/tasks subtask-list <parent-id>`',
      ].join('\n'),
    },
  },
];
```

### Anti-Patterns to Avoid

- **await ack() not first:** Any code before `await ack()` risks missing the 3-second deadline. Even a cheap synchronous operation before ack() is dangerous if the event loop is loaded. ack() MUST be the first statement.
- **Using say() instead of respond():** `say()` posts to the channel as a visible message. `respond()` sends an ephemeral reply visible only to the invoking user. All slash command responses should use `respond()` with `response_type: 'ephemeral'`.
- **Constructing UserIdentityCache per-request:** The cache has state. Create once in `server.ts` startup and pass as dependency to `registerTasksCommand()`. Creating per-handler invocation defeats the TTL cache entirely.
- **Not guarding with slackService.isEnabled():** If Slack tokens are absent, `slackService.getApp()` returns null. Always guard: `const app = slackService.getApp(); if (app) { registerTasksCommand(app, ...) }`.
- **Calling service methods synchronously:** All service methods (`taskService.createTask`, etc.) are synchronous (they're better-sqlite3 sync operations) but calling them inside a Bolt handler still requires proper async/await wrapping since the handler is async and error handling must be managed.
- **Not providing text fallback in respond():** Block Kit responses should always include a `text` field as accessibility fallback for notifications and screen readers.
- **Accessing `_service.Assets` or internal service state:** Per project guidelines, never bypass the service layer interface. Only call public methods on services (as seen in the existing service interfaces).
- **Naming conflict: `app` for both createApp result and Bolt App:** `server.ts` already uses `const app = await createApp(...)` for the application. The Bolt app is `slackService.getApp()`. When writing server.ts additions, use `const slackApp = slackService.getApp()` to avoid shadowing.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Slack slash command registration | Custom HTTP endpoint for Slack webhook | `app.command('/tasks', handler)` from @slack/bolt | Bolt handles Socket Mode event routing, request verification, ack() timing — all built-in |
| User ID → display name resolution | Per-request users.info call | `UserIdentityCache.resolve(userId)` (Phase 24 artifact) | Cache already built, tested, handles fallback chain and error TTL |
| Block Kit JSON composition | Custom block builder functions | `formatTaskList()`, `formatTaskDetail()`, `formatProjectList()`, `formatProjectDetail()` (Phase 24 artifacts) | All formatters built and tested in Phase 24; don't duplicate |
| Argument parsing | commander.js, yargs, or argv-like parsing | Inline `split(/\s+/)` + `parseArgs()` helper | command.text is simple; no subshell quoting; keeping it inline avoids async commander complications inside Bolt handlers |
| Service error formatting | Custom error type check logic | Import and check `NotFoundError`, `ValidationError`, `BusinessError` from `src/services/errors.ts` | These are the canonical error types already thrown by all service methods |

---

## Common Pitfalls

### Pitfall 1: 3-Second ack() Deadline
**What goes wrong:** Slack shows "This operation timed out" to the user even if the command eventually succeeds.
**Why it happens:** Any await before `ack()` (service call, identity resolution, formatting) can push past 3 seconds if the system is under load or the DB has a brief lock.
**How to avoid:** `ack()` MUST be the absolute first statement. Verified from @slack/bolt source: Bolt builds the ack function from the incoming request's response mechanism; it has a hardcoded 3-second window in the Slack platform.
**Warning signs:** Users see Slack's "This app did not respond" timeout message despite the handler completing successfully.

### Pitfall 2: respond() After ack() Timeout Is Fine
**What goes wrong:** Developers think they must respond() within 3 seconds too.
**Why it happens:** Conflating ack() (required: 3s) with respond() (optional: 30 min via response_url).
**How to avoid:** Only ack() is time-constrained. respond() uses the `response_url` webhook which is valid for 30 minutes. All service calls and formatting happen AFTER ack() with no deadline.
**Warning signs:** Unnecessary architecture complexity adding background queues or premature responds.

### Pitfall 3: command.text Is Empty String for Bare `/tasks`
**What goes wrong:** `command.text.trim().split(/\s+/)` on empty string returns `['']` — the first element is `''`, not `undefined`. The default case in the switch catches it unexpectedly.
**Why it happens:** `''.split(/\s+/)` in JavaScript returns `['']`, not `[]`.
**How to avoid:** Check `if (!subcommand || subcommand === '')` to redirect to help. Verified: `SlashCommand.text: string` (not optional) — will be empty string for bare `/tasks`.
**Warning signs:** Bare `/tasks` showing "Unknown subcommand" error instead of help.

### Pitfall 4: Naming Conflict Between Application App and Bolt App
**What goes wrong:** TypeScript error or runtime confusion when both `app` (from `createApp()`) and `slackService.getApp()` are in scope.
**Why it happens:** `server.ts` already has `const { server, app } = await createServer()` and `createServer()` returns `{ server, app }` where `app` is the `App` interface from `src/index.ts`. `slackService.getApp()` returns a Bolt `App` (from `@slack/bolt`).
**How to avoid:** Use `const slackApp = slackService.getApp()` in server.ts. Never use the name `app` for the Bolt App instance in any file that also imports the application `App`.
**Warning signs:** TypeScript error `Property 'command' does not exist on type 'App'` (if the wrong App is used).

### Pitfall 5: Services Are Sync, Handlers Are Async — Error Handling Gap
**What goes wrong:** An uncaught `NotFoundError` or `BusinessError` thrown by a synchronous service method crashes the Bolt handler with an unhandled promise rejection.
**Why it happens:** `taskService.getTask(id)` is synchronous (better-sqlite3) but throws `NotFoundError`. Inside an `async` function, throwing synchronously still creates a rejected promise — BUT only if the calling code is already in the async context. Since Bolt handlers are async, synchronous throws from called sync functions are caught by the ambient `try/catch`.
**How to avoid:** Always wrap the full subcommand body (after ack()) in try/catch. The top-level switch should have a catch that calls `respondError()`.
**Warning signs:** Bolt logs `unhandledRejection` errors when task IDs don't exist.

### Pitfall 6: Block Count Limit for show Command
**What goes wrong:** `/tasks show <id>` with many comments and dependencies may exceed 50 blocks.
**Why it happens:** `formatTaskDetail()` produces 2-4 blocks. Adding comments (1 block each) + dependencies (1 block each) can easily exceed 50 for tasks with long histories.
**How to avoid:** Limit comments shown in `/tasks show` to most recent 5 (with "X more comments" footer). Limit dependencies to 10. Total blocks: 4 (task detail) + 1 (divider) + 5 (comments) + 1 (divider) + 10 (deps) = 21. Well under 50.
**Warning signs:** Slack API returns `too_many_blocks` or `invalid_blocks` for tasks with long history.

### Pitfall 7: comment-add Content With Spaces
**What goes wrong:** `/tasks comment-add 42 This is my comment` — the content is everything after the task ID, but arg splitting loses the space semantics.
**Why it happens:** `command.text.split(/\s+/)` breaks `"comment-add 42 This is my comment"` into 6 tokens. The handler only sees `args = ['42', 'This', 'is', 'my', 'comment']`.
**How to avoid:** For content-taking commands (comment-add), rejoin args[1+] as the content: `args.slice(1).join(' ')`. Alternatively, use a `--content <text>` flag convention (but Slack doesn't shell-quote, so multi-word values still need joining after the `--content` key).
**Warning signs:** Comments getting truncated to one word.

---

## Code Examples

Verified patterns from installed packages and existing Phase 24 code:

### Verified: SlashCommandMiddlewareArgs destructuring
```typescript
// Source: @slack/bolt dist/types/command/index.d.ts — verified locally
// SlashCommandMiddlewareArgs: { payload, command, body, say, respond, ack }
// SlashCommand: { token, command, text, response_url, trigger_id, user_id, user_name, ... }

app.command('/tasks', async ({ ack, respond, command }) => {
  await ack(); // FIRST — always
  const [subcommand, ...args] = command.text.trim().split(/\s+/);
  // command.user_id  — Slack user ID (e.g. "U0123ABCDEF")
  // command.user_name — Slack username (display, not canonical)
  // command.text     — everything typed after "/tasks" (empty string if bare /tasks)
});
```

### Verified: respond() with Block Kit blocks
```typescript
// Source: @slack/bolt dist/types/utilities.d.ts
// RespondArguments: { response_type?, replace_original?, delete_original?, blocks?, text?, ... }
// RespondFn = (message: string | RespondArguments) => Promise<any>

await respond({
  response_type: 'ephemeral',
  blocks: formatTaskList(tasks),
  text: `Tasks (${tasks.length})`, // accessibility fallback
});
```

### Verified: UserIdentityCache.resolve() for UIDENT-03
```typescript
// Source: src/slack/user-identity.ts — resolve(userId): Promise<string>
// Phase 25 must call this BEFORE writing to DB for UIDENT-03

const displayName = await identityCache.resolve(command.user_id);
const task = taskService.claimTask(taskId, displayName);
// Now task.assignee = "Stuart" (not "U0123ABCDEF") — visible in CLI/REST/MCP
```

### Verified: Service error types for catch blocks
```typescript
// Source: src/services/errors.ts
import { NotFoundError, ValidationError, BusinessError } from '../../services/errors.js';

function formatServiceError(error: unknown): string {
  if (error instanceof NotFoundError) return `Not found: ${error.message}`;
  if (error instanceof ValidationError) {
    const fields = Object.entries(error.fieldErrors)
      .map(([f, msgs]) => `${f}: ${msgs.join(', ')}`)
      .join('; ');
    return `Validation failed — ${fields}`;
  }
  if (error instanceof BusinessError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}
```

### Verified: Constructing and guarding UserIdentityCache in server.ts
```typescript
// Source: src/services/slack.service.ts — getApp(): App | null
// Source: src/slack/user-identity.ts — constructor(client: WebClient)
// Source: @slack/bolt App.d.ts — "client: WebClient" public property

import { registerTasksCommand } from '../slack/commands/tasks-command.js';
import { UserIdentityCache } from '../slack/user-identity.js';

// After: await slackService.start();
const slackApp = slackService.getApp();
if (slackApp) {
  const identityCache = new UserIdentityCache(slackApp.client);
  registerTasksCommand(
    slackApp,
    { taskService: app.taskService, projectService: app.projectService,
      dependencyService: app.dependencyService, commentService: app.commentService },
    identityCache
  );
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| One slash command per operation (`/tasks-create`, `/tasks-list`) | Single `/tasks` with subcommand routing | Prior decision (Phase 23 planning) | Fewer Slack app registrations; discoverability via `help`; simpler UX |
| Bolt v3 — async ack was optional | Bolt v4 — ack() is always required and is an async function | bolt v4.0.0 (2024) | Must always `await ack()` — not calling it causes Bolt to log a warning and Slack shows timeout |
| `say()` for all responses | `respond()` for slash commands, `say()` for messages | Current Slack best practice | respond() is ephemeral by default; say() posts to channel; slash commands should use respond() |

**Deprecated/outdated:**
- `ack('message text')`: While `AckFn<string | RespondArguments>` allows passing a response to ack(), this immediately responds with the ack payload. For Block Kit responses, always ack() with no arguments then call respond() separately — the ack response has limited formatting support.

---

## Open Questions

1. **Should show command include comments and dependencies inline?**
   - What we know: SCMD-05 says "displays task detail card with metadata, comments, dependencies." The service methods exist: `commentService.getComments(id)` and `dependencyService.getBlockedBy(id)` + `getBlockers(id)`.
   - What's unclear: Whether to include ALL comments/deps or just a summary. Block count limit of 50 applies.
   - Recommendation: Include last 5 comments and first 10 dependencies. Add context block footer if truncated. Total blocks well under 50.

2. **How should create handle the project_id requirement?**
   - What we know: `TaskService.createTask()` requires `project_id` (a number). CLI prompts interactively. Slack can't prompt.
   - What's unclear: Whether to require `--project <id>` flag or default to project 1 or respond with error.
   - Recommendation: Require `--project <id>` flag. If missing, respond with error: `:x: Project ID required. Usage: \`/tasks create <title> --project <id>\``. No default project — task creation without explicit project is ambiguous.

3. **Should UIDENT-03 also apply to comment-add author field?**
   - What we know: UIDENT-03 says "tasks created/claimed via Slack show the resolved display name." Comments have an `author` field too.
   - What's unclear: Whether resolving user ID for comment author is in scope for UIDENT-03 or just task `created_by`/`assignee`.
   - Recommendation: Apply the same pattern to `comment-add` — resolve `command.user_id` and use as `author`. This is consistent behavior and uses the same cached lookup with no additional cost.

4. **How to handle delete operations without confirmation dialogs?**
   - What we know: CLI uses interactive `confirmAction()` prompts before delete/remove. Slack slash commands can't block for user input (no modal in this phase).
   - What's unclear: Whether to add a confirmation modal (Phase 26 territory?) or just execute immediately.
   - Recommendation: Execute deletes immediately for this phase. Add a note in the response: "Task #42 deleted." For destructive operations, this is acceptable for a Slack-first workflow tool where errors can be corrected by re-creating. Phase 26 could add modal confirmation if needed.

5. **Should operational commands (backup, doctor, db-check, completions) be stubs or omitted?**
   - What we know: These commands access the DB or filesystem directly — no service layer equivalent exists.
   - What's unclear: Whether to implement stubs (respond with "use CLI") or skip them entirely (unknown subcommand error).
   - Recommendation: Implement as informational stubs responding with "This operation is only available via CLI: `tasks <command>`". This is more helpful than an "unknown subcommand" error, and satisfies "actionable messages" per SCMD-10.

---

## Sources

### Primary (HIGH confidence)
- Local: `/home/stuart/wood-fired-bugs/node_modules/@slack/bolt/dist/types/command/index.d.ts` — `SlashCommandMiddlewareArgs`, `SlashCommand` type definition verified (user_id, text, response_url fields)
- Local: `/home/stuart/wood-fired-bugs/node_modules/@slack/bolt/dist/types/utilities.d.ts` — `RespondFn`, `RespondArguments` type definition verified (response_type, blocks, text fields)
- Local: `/home/stuart/wood-fired-bugs/node_modules/@slack/bolt/dist/App.d.ts` — `app.command(commandName, ...listeners)` signature verified; `client: WebClient` public property verified
- Local: `/home/stuart/wood-fired-bugs/node_modules/@slack/bolt/dist/App.js` line 631-636 — `respond()` built from `body.response_url` via `buildRespondFn()`; line 974-977 — `buildRespondFn` POSTs to response_url (30 min validity confirmed by Slack platform)
- Local: `/home/stuart/wood-fired-bugs/src/services/slack.service.ts` — `getApp(): App | null`, `isEnabled(): boolean`, startup pattern verified
- Local: `/home/stuart/wood-fired-bugs/src/slack/user-identity.ts` — `UserIdentityCache.resolve(userId): Promise<string>` verified; constructor takes `WebClient`
- Local: `/home/stuart/wood-fired-bugs/src/slack/task-formatter.ts` — `formatTaskList`, `formatTaskDetail`, `formatTaskNotification` verified as exported from this path (NOT `src/slack/formatters/task-formatter.ts` — see Phase 24 VERIFICATION note)
- Local: `/home/stuart/wood-fired-bugs/src/slack/formatters/project-formatter.ts` — `formatProjectList`, `formatProjectDetail` verified
- Local: `/home/stuart/wood-fired-bugs/src/services/task.service.ts` — all public methods verified: `createTask`, `getTask`, `listTasks`, `updateTask`, `deleteTask`, `claimTask`, `getSubtasks`, `countTasks`
- Local: `/home/stuart/wood-fired-bugs/src/services/project.service.ts` — `createProject`, `getProject`, `listProjects`, `updateProject`, `deleteProject` verified
- Local: `/home/stuart/wood-fired-bugs/src/services/dependency.service.ts` — `addDependency`, `removeDependency`, `getBlockedBy`, `getBlockers` verified
- Local: `/home/stuart/wood-fired-bugs/src/services/comment.service.ts` — `addComment`, `getComments`, `deleteComment` verified
- Local: `/home/stuart/wood-fired-bugs/src/api/server.ts` — startup wiring pattern; `slackService` created and started; `app.taskService` etc. available in scope
- Local: `/home/stuart/wood-fired-bugs/.planning/phases/24-block-kit-formatters-user-identity/24-VERIFICATION.md` — confirmed UIDENT-03 gap: `UserIdentityCache` is an orphan; no production code calls it outside tests. Phase 25 must wire it.

### Secondary (MEDIUM confidence)
- Phase 24 research/summaries — ack() 3-second constraint, respond() via response_url, ephemeral vs in-channel response patterns, 50-block limit — all consistent across multiple Phase 24 documents
- Phase 23 SUMMARY — confirmed `commands` scope registered; `chat:write`, `chat:write.public`, `channels:read` registered; `/tasks` command must be added in Slack app dashboard

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified locally from node_modules; no new installations needed
- Architecture patterns: HIGH — command handler type signatures verified from bolt dist types; respond() implementation read from App.js; all service methods verified from source
- Subcommand inventory: HIGH — all 25 CLI command files read and mapped; service method signatures verified
- UIDENT-03 integration: HIGH — verified gap from Phase 24 VERIFICATION.md; resolve() method signature verified from user-identity.ts; write path pattern confirmed from Phase 24 research
- Pitfalls: HIGH for type/API pitfalls (verified from bolt source); MEDIUM for the command.text empty string edge case (verified from JS semantics, not bolt-specific doc)

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (@slack/bolt@4.6.0 installed; no version changes expected within 30 days; core slash command API is stable)
