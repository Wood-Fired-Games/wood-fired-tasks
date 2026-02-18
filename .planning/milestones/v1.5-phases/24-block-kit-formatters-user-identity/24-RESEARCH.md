# Phase 24: Block Kit Formatters & User Identity - Research

**Researched:** 2026-02-17
**Domain:** Slack Block Kit JSON composition, @slack/types type safety, @slack/web-api users.info, in-memory TTL cache
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| BKIT-01 | Task list responses use Block Kit sections with status emoji, priority colors, and assignee | `SectionBlock` with `text` (mrkdwn) per item; emoji via Unicode literals in string; bold via `*text*`; verified from @slack/types `blocks.d.ts` |
| BKIT-02 | Task detail cards show all fields in structured Block Kit layout | `HeaderBlock` (title) + `SectionBlock` with `fields` array (2-column key/value pairs) + `ContextBlock` for metadata; all type-verified from @slack/types |
| BKIT-03 | Project list and detail responses use consistent Block Kit formatting | Same `HeaderBlock` + `SectionBlock` pattern as tasks; `DividerBlock` between items in list |
| BKIT-04 | Notification messages use Block Kit with task summary, status change, and link to relevant command | `SectionBlock` with mrkdwn text + `/tasks show <id>` as the "relevant command link" (plain text code span, not URL); consistent with slash command interface planned for Phase 25 |
| UIDENT-01 | Slack user IDs are resolved to display names for task created_by/assignee fields | `app.client.users.info({ user: userId })` returns `profile.display_name` or fallback to `profile.real_name` then `name`; `app` from `SlackService.getApp()` |
| UIDENT-02 | User ID to display name mapping is cached in memory with TTL to avoid rate limiting | Pure Map-based TTL cache in `UserIdentityCache` class; no external lib required; `users.info` is Tier 4 (generous) but caching still needed for volume |
| UIDENT-03 | Tasks created/claimed via Slack show the resolved display name in CLI/REST/MCP views | Store resolved display name as `assignee`/`created_by` string at write time (not the Slack ID) — consistent with prior decision "store Slack user IDs as canonical identifier" needs clarification |

</phase_requirements>

---

## Summary

Phase 24 is split into two independent but complementary concerns: Block Kit JSON formatters and user identity resolution. Both are pure TypeScript with no new runtime dependencies — they use `@slack/types` (already installed as devDep) for compile-time type safety and `@slack/bolt`'s bundled `@slack/web-api` `WebClient` for the `users.info` API call.

The Block Kit formatters are pure functions — they take domain objects (`Task`, `Project`, `EventPayload`) and return `KnownBlock[]`. They live in `src/slack/formatters/` as a new module with no side effects. The types from `@slack/types@^2.20.0` (already installed) provide full compile-time validation: `SectionBlock`, `HeaderBlock`, `DividerBlock`, `ContextBlock`, and `MrkdwnElement` cover all required layouts. Testing is unit tests only — formatters are pure functions, so no mocking needed.

User identity resolution is a `UserIdentityCache` service class that wraps `app.client.users.info()` from the Bolt `App` instance (accessed via `SlackService.getApp()`). The cache uses a plain `Map<string, { displayName: string; expiresAt: number }>` with a configurable TTL (default 5 minutes). The prior decision "store Slack user IDs as canonical identifier" means the identity layer resolves IDs to display names at **read time** for Slack output, not at write time — tasks store whatever string was passed as `assignee`/`created_by`. When a Slack slash command (Phase 25) creates/claims a task, it passes the resolved display name so CLI/REST/MCP always show the human name. UIDENT-03 is satisfied by resolving at write time within the slash command handler, not in the cache layer itself.

**Primary recommendation:** Create `src/slack/formatters/` for pure Block Kit functions (no SlackService dependency), and `src/slack/user-identity.ts` for the `UserIdentityCache` class that takes a `WebClient` (not a `SlackService`) for dependency inversion and testability.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @slack/types | ^2.20.0 (already installed as devDep) | `KnownBlock`, `SectionBlock`, `HeaderBlock`, `DividerBlock`, `ContextBlock`, `MrkdwnElement`, `PlainTextElement` types | Official Slack types; compile-time Block Kit safety; already decided in Phase 23 |
| @slack/web-api | bundled in @slack/bolt@^4.6.0 | `WebClient` for `users.info` API call; `UsersInfoResponse` type | Bundled — no additional install; `app.client` is a `WebClient` instance |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @slack/bolt | ^4.6.0 (already installed) | `App` instance provides `app.client: WebClient`; `getApp()` from `SlackService` | Access `WebClient` from SlackService; never construct a raw WebClient — bolt already manages auth |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Pure Map TTL cache | `node-cache`, `lru-cache` | No new deps; Map + Date.now() is sufficient for a single-key-type cache with simple TTL; adds dependency for trivial problem |
| Import types from @slack/types | Import from @slack/web-api or @slack/bolt | @slack/types is the canonical dev-only type source; other packages re-export subsets; keeps formatter imports clean |
| Formatter as class | Pure functions | Pure functions are simpler to test, compose, and reason about; no instance state in formatting logic |

**Installation:**
```bash
# No new packages needed — all dependencies already installed:
# @slack/bolt@^4.6.0 (runtime — includes @slack/web-api)
# @slack/types@^2.20.0 (devDependency — Block Kit types)
```

---

## Architecture Patterns

### Recommended Project Structure
```
src/
├── slack/
│   ├── formatters/
│   │   ├── task-formatter.ts      # formatTaskList(), formatTaskDetail(), formatTaskNotification()
│   │   ├── project-formatter.ts   # formatProjectList(), formatProjectDetail()
│   │   └── __tests__/
│   │       ├── task-formatter.test.ts
│   │       └── project-formatter.test.ts
│   ├── user-identity.ts           # UserIdentityCache class
│   └── __tests__/
│       └── user-identity.test.ts
```

This is a NEW `src/slack/` directory separate from `src/services/`. Formatters are not services — they have no lifecycle, no dependencies, no constructor. `UserIdentityCache` is service-like (stateful, injectable) but belongs in `src/slack/` since it's Slack-specific.

### Pattern 1: Pure Block Kit Formatter Function

**What:** A function that takes a domain object and returns `KnownBlock[]`. No side effects. No async. No imports from services.

**When to use:** All BKIT-01 through BKIT-04 implementations.

**Example (BKIT-01 — task list):**
```typescript
// Source: @slack/types blocks.d.ts — SectionBlock, MrkdwnElement, DividerBlock verified
import type { KnownBlock, SectionBlock, DividerBlock, HeaderBlock } from '@slack/types';
import type { Task } from '../../types/task.js';

const STATUS_EMOJI: Record<string, string> = {
  open:        '⚪',
  in_progress: '🔵',
  done:        '✅',
  closed:      '⛔',
  blocked:     '🔴',
  backlogged:  '🟡',
};

const PRIORITY_INDICATOR: Record<string, string> = {
  urgent: '🔴 urgent',
  high:   '🟠 high',
  medium: '🟡 medium',
  low:    '⚪ low',
};

export function formatTaskList(tasks: Array<Task & { tags: string[] }>): KnownBlock[] {
  if (tasks.length === 0) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: '_No tasks found._' } }];
  }

  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: `Tasks (${tasks.length})`, emoji: true } },
  ];

  for (const task of tasks) {
    const emoji = STATUS_EMOJI[task.status] ?? '❓';
    const priority = PRIORITY_INDICATOR[task.priority] ?? task.priority;
    const assignee = task.assignee ? `@${task.assignee}` : '_unassigned_';

    const section: SectionBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *#${task.id} ${task.title}*\n${priority} · ${assignee}`,
      },
    };
    blocks.push(section);
  }

  return blocks;
}
```

### Pattern 2: Task Detail Card (BKIT-02)

**What:** `HeaderBlock` for title + `SectionBlock` with `fields` for 2-column key/value layout + optional `DividerBlock` + `ContextBlock` for metadata.

**Key constraints from @slack/types (verified):**
- `HeaderBlock.text` is `PlainTextElement` — max 150 characters
- `SectionBlock.fields` is `TextObject[]` — max 10 items, each max 2000 characters
- `SectionBlock.text` is `TextObject` — max 3000 characters
- `ContextBlock.elements` is `(ImageElement | TextObject)[]` — max 10 items

**Example (BKIT-02 — task detail):**
```typescript
// Source: @slack/types blocks.d.ts verified
import type { KnownBlock, SectionBlock, HeaderBlock, ContextBlock, DividerBlock, MrkdwnElement } from '@slack/types';
import type { Task } from '../../types/task.js';

export function formatTaskDetail(task: Task & { tags: string[] }): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  // Header: title (truncate to 150 chars — HeaderBlock limit)
  const header: HeaderBlock = {
    type: 'header',
    text: { type: 'plain_text', text: task.title.slice(0, 150), emoji: true },
  };
  blocks.push(header);

  // Fields section: 2-column key/value pairs (max 10 items per SectionBlock.fields)
  const fields: MrkdwnElement[] = [
    { type: 'mrkdwn', text: `*Status*\n${STATUS_EMOJI[task.status]} ${task.status}` },
    { type: 'mrkdwn', text: `*Priority*\n${PRIORITY_INDICATOR[task.priority]}` },
    { type: 'mrkdwn', text: `*Assignee*\n${task.assignee ?? '_unassigned_'}` },
    { type: 'mrkdwn', text: `*Due Date*\n${task.due_date ?? '_none_'}` },
    { type: 'mrkdwn', text: `*Project*\n#${task.project_id}` },
    { type: 'mrkdwn', text: `*Created by*\n${task.created_by}` },
  ];

  // Tags only if present (max 10 fields total, already at 6)
  if (task.tags.length > 0) {
    fields.push({ type: 'mrkdwn', text: `*Tags*\n${task.tags.join(', ')}` });
  }

  const fieldsSection: SectionBlock = { type: 'section', fields };
  blocks.push(fieldsSection);

  // Description (only if present)
  if (task.description) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: task.description.slice(0, 3000) },
    });
  }

  return blocks;
}
```

### Pattern 3: Notification Formatter (BKIT-04)

**What:** A `SectionBlock` with compact task summary + status change text. "Link to relevant command" is a plain-text code span: `` `/tasks show 42` ``.

**Important:** Block Kit does not support deep links into Slack slash commands as clickable URLs. The "link to relevant command" per BKIT-04 is a `mrkdwn` code span showing the command the user can run — not a hyperlink. This is consistent with the Phase 25 slash command interface.

```typescript
// Source: Prior decision "fire-and-forget async in SlackNotifier"
import type { KnownBlock } from '@slack/types';
import type { TaskEvent } from '../../events/types.js';

export function formatTaskNotification(event: TaskEvent): KnownBlock[] {
  const { data: task, eventType, metadata } = event;
  const emoji = STATUS_EMOJI[task.status] ?? '❓';
  const actor = metadata.actor ?? 'system';

  const eventLabel: Record<string, string> = {
    'task.created': 'Task created',
    'task.updated': 'Task updated',
    'task.status_changed': 'Status changed',
    'task.claimed': 'Task claimed',
    'task.deleted': 'Task deleted',
  };
  const label = eventLabel[eventType] ?? eventType;

  const assignee = task.assignee ? `@${task.assignee}` : '_unassigned_';

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${label}* by ${actor}`,
          `${emoji} *#${task.id} ${task.title}*`,
          `${PRIORITY_INDICATOR[task.priority]} · ${assignee}`,
          `\`/tasks show ${task.id}\``,
        ].join('\n'),
      },
    },
  ];
}
```

### Pattern 4: UserIdentityCache

**What:** Stateful class that wraps `WebClient.users.info()` with an in-memory Map TTL cache. Takes `WebClient` (not `SlackService`) in constructor for testability.

**Key API facts (verified from @slack/web-api dist):**
- `app.client` is a `WebClient` instance
- `client.users.info({ user: userId })` returns `UsersInfoResponse`
- Response shape: `{ ok: boolean, user?: User }` where `User.profile?.display_name` is the display name
- Fallback chain: `profile.display_name` → `profile.real_name` → `user.name` → userId

**Rate limit:** `users.info` is confirmed Tier 4 (100+ per minute, generous burst). TTL cache of 5 minutes is appropriate to handle repeated lookups without hitting rate limits.

**Required scope:** `users:read` (already listed in Phase 23 setup as `channels:read, chat:write, chat:write.public, commands`). CRITICAL: `users:read` must be explicitly added to the bot OAuth scopes in the Slack app dashboard.

```typescript
// Source: @slack/web-api UsersInfoResponse.d.ts verified
import type { WebClient } from '@slack/web-api';
import type { Logger } from 'pino';

interface CacheEntry {
  displayName: string;
  expiresAt: number; // Date.now() ms
}

export class UserIdentityCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly client: WebClient,
    private readonly ttlMs: number = 5 * 60 * 1000, // 5 minutes
    private readonly logger?: Logger
  ) {}

  async resolve(userId: string): Promise<string> {
    const now = Date.now();
    const cached = this.cache.get(userId);

    if (cached && cached.expiresAt > now) {
      return cached.displayName;
    }

    try {
      const response = await this.client.users.info({ user: userId });
      const profile = response.user?.profile;
      const name = response.user?.name;
      // Fallback: display_name → real_name → name → userId
      const displayName =
        (profile?.display_name && profile.display_name.trim())
          ? profile.display_name
          : (profile?.real_name && profile.real_name.trim())
            ? profile.real_name
            : name ?? userId;

      this.cache.set(userId, { displayName, expiresAt: now + this.ttlMs });
      return displayName;
    } catch (err) {
      this.logger?.warn({ userId, err }, 'Failed to resolve Slack user identity — returning userId');
      // On error: cache the userId itself briefly (30s) to avoid hammering API on repeated failures
      this.cache.set(userId, { displayName: userId, expiresAt: now + 30_000 });
      return userId;
    }
  }

  /** Clear the full cache (useful for testing) */
  clear(): void {
    this.cache.clear();
  }
}
```

### Pattern 5: Accessing WebClient from SlackService

**What:** Phase 25/26 callers need `WebClient`. The pattern is: `slackService.getApp()?.client` — `App.client` is a public property of type `WebClient`.

```typescript
// Source: @slack/bolt App.d.ts — verified: "client: WebClient"
const app = slackService.getApp();
if (app) {
  const identityCache = new UserIdentityCache(app.client, 5 * 60 * 1000, logger);
}
```

**Important:** `UserIdentityCache` should be constructed once and shared — not created per-request. Phase 25 (slash commands) will receive it as a dependency.

### Pattern 6: How UIDENT-03 is Satisfied

**The prior decision:** "Store Slack user IDs as canonical assignee identifier — display names are mutable and non-unique."

**Resolution:** This decision says what to store in the DB when the source of truth is unclear. But for UIDENT-03 specifically — "tasks created/claimed via Slack show the resolved display name in CLI/REST/MCP views" — the slash command handler (Phase 25) must:

1. Receive the Slack user ID from the slash command payload (`command.user_id`)
2. Call `identityCache.resolve(command.user_id)` to get the display name
3. Pass the **display name** (not the Slack ID) as `created_by`/`assignee` to `TaskService.createTask()` or `claimTask()`

This means CLI/REST/MCP see a human-readable name, not `U0123ABC`. The cache ensures subsequent lookups for the same user don't hit the API on every slash command. This is the correct interpretation of UIDENT-03 — Phase 24 builds the resolution tool; Phase 25 uses it.

### Anti-Patterns to Avoid

- **Mrkdwn in HeaderBlock:** `HeaderBlock.text` must be `PlainTextElement` (type `plain_text`). Using `mrkdwn` type here is a type error caught by `@slack/types`.
- **More than 10 fields in SectionBlock.fields:** Max 10 items. Task detail has up to 7 fields (status, priority, assignee, due_date, project, created_by, tags) — within limit, but don't add more without checking.
- **Exceeding HeaderBlock 150-char limit:** Truncate `task.title` to 150 characters before passing to HeaderBlock. Section text allows 3000 chars.
- **Constructing `UserIdentityCache` per-request:** The cache state is the point. Construct once at startup/handler registration, share across requests.
- **Calling `users.info` synchronously:** It's always async. The formatter functions (BKIT-*) are pure and sync — they do NOT call `users.info`. User resolution happens upstream (in Phase 25 slash command handlers) before formatting, so the formatter receives display names, not Slack IDs.
- **Storing Slack IDs in tasks when display names are intended:** The identity cache is used by Phase 25 handlers to resolve BEFORE writing to DB. The formatters themselves receive already-resolved names in task domain objects.
- **Using @slack/types in runtime code path:** `@slack/types` is a devDependency — types are erased at compile time. The formatter functions return plain JS objects at runtime. This is correct; do not add `@slack/types` to runtime deps.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Block Kit type definitions | Custom interfaces for `SectionBlock`, `HeaderBlock`, etc. | Import from `@slack/types` | Already installed; official; catches field name typos and wrong `type` literals at compile time |
| Rate-limited API client | Custom retry/backoff wrapper | `@slack/web-api` WebClient (bundled) | `WebClient` already handles rate limit retries internally (Tier 4, generous); add TTL cache on top |
| Slack user profile fetch | Direct HTTP to Slack API | `app.client.users.info()` | WebClient handles auth (bot token), error wrapping, TypeScript types, and retry |
| Block Kit JSON validation | Zod schemas for output | TypeScript type checking via `@slack/types` | Formatters are pure functions — TypeScript enforces correct shape at compile time; no runtime validation needed |

**Key insight:** The formatters produce plain JavaScript objects that TypeScript verifies against `@slack/types` interfaces. At runtime they're just POJOs. No serialization library or runtime validator is needed.

---

## Common Pitfalls

### Pitfall 1: HeaderBlock Text Length
**What goes wrong:** Slack rejects messages where `HeaderBlock.text.text.length > 150`.
**Why it happens:** The 150-char limit is a Slack API constraint documented in the official Block Kit reference. Long task titles will exceed it.
**How to avoid:** Always `title.slice(0, 150)` before putting in a HeaderBlock. Truncate with ellipsis for display: `title.length > 147 ? title.slice(0, 147) + '...' : title`.
**Warning signs:** Slack API returns `invalid_arguments` error on `chat.postMessage` with long titles.

### Pitfall 2: MrkdwnElement vs PlainTextElement in Wrong Block
**What goes wrong:** TypeScript error when passing `{ type: 'mrkdwn', text: '...' }` to `HeaderBlock.text` — it requires `PlainTextElement` (`type: 'plain_text'`).
**Why it happens:** Different blocks require different text object types. `HeaderBlock` is always plain text. `SectionBlock.text` accepts either.
**How to avoid:** Always type formatter return values as `KnownBlock[]` and let TypeScript catch mismatches. Don't cast to `any`.
**Warning signs:** TypeScript `TS2322` error at the `text:` field of a HeaderBlock.

### Pitfall 3: `profile.display_name` May Be Empty String
**What goes wrong:** `response.user?.profile?.display_name` returns `""` (empty string) for users who haven't set a display name, causing blank assignee fields.
**Why it happens:** Slack's API documentation explicitly states: "may not be present at all, may be null or may contain the empty string." Only `image_*` fields are guaranteed.
**How to avoid:** Use fallback chain: `display_name (trimmed) || real_name (trimmed) || name || userId`. The `.trim()` check catches empty/whitespace-only strings.
**Warning signs:** Assignee field appears blank in Slack messages for some users.

### Pitfall 4: Missing `users:read` Scope
**What goes wrong:** `users.info` call fails with `missing_scope` error.
**Why it happens:** The Phase 23 setup instructions listed `channels:read, chat:write, chat:write.public, commands` but not `users:read`.
**How to avoid:** Add `users:read` to bot OAuth scopes in the Slack app dashboard before testing UIDENT-01/02. Document this in the plan's user setup section.
**Warning signs:** `error: 'missing_scope', needed: 'users:read'` in error response.

### Pitfall 5: Formatter Receives Slack User IDs Instead of Display Names
**What goes wrong:** Task detail shows `U0123ABCDEF` instead of `Stuart` in assignee field.
**Why it happens:** The formatter was passed the raw Slack user ID without going through `UserIdentityCache.resolve()` first.
**How to avoid:** Formatters are pure — they don't call the identity API. Resolution must happen in the slash command handler (Phase 25) before creating/claiming the task. The formatter always receives already-resolved human names. This separation is by design.
**Warning signs:** Assignee shows uppercase Slack ID pattern (`U` + alphanumeric) in Slack messages.

### Pitfall 6: 50-Block Limit on Messages
**What goes wrong:** Task list with many items exceeds the 50-block-per-message limit.
**Why it happens:** Slack enforces a maximum of 50 blocks per `chat.postMessage` call.
**How to avoid:** Limit task lists to at most 20 tasks in the Block Kit output (1 header + 20 sections = 21 blocks, well within limit). Add a "showing first N of M" footer if truncated.
**Warning signs:** Slack API returns `invalid_blocks` or `too_many_blocks` error.

---

## Code Examples

Verified patterns from installed packages (`@slack/types@2.20.0`, `@slack/web-api` bundled with `@slack/bolt@4.6.0`):

### Verified: `KnownBlock` union type (from `@slack/types@2.20.0`)
```typescript
// Source: /home/stuart/wood-fired-bugs/node_modules/@slack/types/dist/block-kit/blocks.d.ts
export type KnownBlock =
  | ActionsBlock | ContextBlock | ContextActionsBlock | DividerBlock | FileBlock
  | HeaderBlock | ImageBlock | InputBlock | MarkdownBlock | RichTextBlock
  | SectionBlock | TableBlock | TaskCardBlock | PlanBlock | VideoBlock;
```

### Verified: `SectionBlock` with `fields` (2-column layout)
```typescript
// Source: @slack/types blocks.d.ts — fields is TextObject[] max 10 items
const section: SectionBlock = {
  type: 'section',
  fields: [
    { type: 'mrkdwn', text: '*Status*\n✅ done' },    // col 1
    { type: 'mrkdwn', text: '*Priority*\n🟡 medium' }, // col 2
    { type: 'mrkdwn', text: '*Assignee*\nStuart' },    // col 1
    { type: 'mrkdwn', text: '*Due Date*\n2026-03-01' }, // col 2
  ],
};
```

### Verified: `HeaderBlock` constraint (PlainTextElement, max 150 chars)
```typescript
// Source: @slack/types blocks.d.ts line 122-132
const header: HeaderBlock = {
  type: 'header',
  text: { type: 'plain_text', text: 'Task Title Here', emoji: true },
  // type: 'mrkdwn' would be a TypeScript error here
};
```

### Verified: `users.info` Response Shape
```typescript
// Source: /home/stuart/wood-fired-bugs/node_modules/@slack/web-api/dist/types/response/UsersInfoResponse.d.ts
// response.user?.profile?.display_name  — may be null/empty
// response.user?.profile?.real_name     — may be null/empty
// response.user?.name                   — usually present
```

### Verified: `App.client` is `WebClient`
```typescript
// Source: /home/stuart/wood-fired-bugs/node_modules/@slack/bolt/dist/App.d.ts
// "client: WebClient" — public property, no need to call any getter
const client: WebClient = slackService.getApp()!.client;
```

### Verified: `chat.postMessage` with blocks
```typescript
// Source: @slack/web-api/dist/types/request/chat.d.ts
// ChannelAndBlocks extends Channel with blocks: (KnownBlock | Block)[]
await app.client.chat.postMessage({
  channel: 'C0123ABC',
  blocks: formatTaskList(tasks),
  // text is optional fallback for notification previews/accessibility
  text: 'Task list update',
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Legacy message attachments (color bars, fields in `attachments[]`) | Block Kit (structured blocks) | Slack deprecated attachments ~2019; still work but discouraged | Use Block Kit exclusively; no `attachments` in new code |
| Bolt v3 `@slack/types` re-exports via namespace | Bolt v4 — `@slack/types` is a separate devDep, not re-exported from bolt | bolt v4.0.0 (2024) | Import directly from `@slack/types`, not from `@slack/bolt` |
| Manual `users.info` HTTP calls | `WebClient.users.info()` from bundled `@slack/web-api` | Stable for years | Always use WebClient — handles auth header, retry, TypeScript types |

**Deprecated/outdated:**
- `message.attachments[].color` for priority color coding: Replaced by Block Kit emoji indicators (`🔴 urgent`). Color-coded attachments still work but conflict with Block Kit-first strategy.
- Importing Block Kit types from `@slack/bolt` directly: In v4, import from `@slack/types` as a dev dep.

---

## Open Questions

1. **Should `UserIdentityCache` be exposed via SlackService or constructed independently in Phase 25?**
   - What we know: Phase 25 (slash commands) needs the cache. SlackService is already in `server.ts`. The cache needs `app.client` from `SlackService.getApp()`.
   - What's unclear: Whether to add `getUserIdentityCache()` to `SlackService` or have Phase 25 construct it inline when registering handlers.
   - Recommendation: Add `createUserIdentityCache(): UserIdentityCache | null` method to `SlackService` that returns null when disabled, constructs and returns a cache instance when enabled. This follows the same `isEnabled()` / `getApp()` pattern already established. The cache instance should be stored on `SlackService` (not recreated per-call) to preserve cache state.

2. **Should project detail formatter include task count?**
   - What we know: BKIT-03 says "project list and detail responses use consistent Block Kit formatting." The domain `Project` type has no task count field.
   - What's unclear: Whether to include a task summary or just project metadata.
   - Recommendation: Formatter only formats what it receives — don't add DB queries to formatters. If task count is needed, the caller (Phase 25 slash command handler) fetches it and passes it to the formatter. Keep formatters pure.

3. **What text to use as the `text` fallback in `chat.postMessage` alongside blocks?**
   - What we know: Slack recommends a `text` fallback for accessibility (screen readers, notification previews). When `blocks` is provided, `text` is still shown in push notifications.
   - What's unclear: Per-formatter fallback strings.
   - Recommendation: Each formatter returns `KnownBlock[]`. The caller (Phase 26 notifier / Phase 25 command handler) is responsible for providing the `text` fallback. This keeps formatters focused: they produce blocks only.

4. **Is `users:read` already in the Slack app OAuth scopes?**
   - What we know: Phase 23 setup instructions in 23-02-SUMMARY.md listed: `chat:write`, `chat:write.public`, `commands`, `channels:read`. `users:read` was NOT listed.
   - What's unclear: Whether Stuart has already added this scope to the Slack app dashboard.
   - Recommendation: The Phase 24 plan MUST include a user setup step: "Add `users:read` to bot OAuth scopes in Slack app dashboard and reinstall the app to workspace." This is required for UIDENT-01.

---

## Sources

### Primary (HIGH confidence)
- Local: `/home/stuart/wood-fired-bugs/node_modules/@slack/types/dist/block-kit/blocks.d.ts` — `KnownBlock`, `SectionBlock`, `HeaderBlock`, `DividerBlock`, `ContextBlock`, `MrkdwnElement`, `PlainTextElement` — read directly, all type constraints verified
- Local: `/home/stuart/wood-fired-bugs/node_modules/@slack/web-api/dist/types/response/UsersInfoResponse.d.ts` — `UsersInfoResponse`, `User`, `Profile` — `display_name`, `real_name`, `name` fields verified
- Local: `/home/stuart/wood-fired-bugs/node_modules/@slack/bolt/dist/App.d.ts` — `client: WebClient` is a public property on `App` — verified
- Local: `/home/stuart/wood-fired-bugs/node_modules/@slack/web-api/dist/types/request/chat.d.ts` — `ChannelAndBlocks` with `blocks: (KnownBlock | Block)[]` — verified
- Local: `/home/stuart/wood-fired-bugs/src/services/slack.service.ts` — `getApp(): App | null` — verified Phase 23 implementation
- Local: `/home/stuart/wood-fired-bugs/src/types/task.ts` — `Task`, `TaskStatus`, `TaskPriority`, domain type shapes — verified
- Official: `https://docs.slack.dev/reference/block-kit/blocks/section-block/` — `SectionBlock` constraints (max 10 fields, 2000 chars/field, 3000 chars text)
- Official: `https://docs.slack.dev/reference/block-kit/blocks/header-block/` — HeaderBlock max 150 chars

### Secondary (MEDIUM confidence)
- WebSearch + `docs.slack.dev/reference/block-kit/blocks/` — 50 blocks per message limit — confirmed by multiple sources (Salesforce community, Bolt GitHub issues, official docs reference)
- `https://docs.slack.dev/reference/methods/users.info/` — profile fields, `users:read` scope requirement — confirmed `display_name` is in profile hash, may be empty
- Phase 23 SUMMARY files — scopes listed in user setup section, prior decisions on Slack architecture

### Tertiary (LOW confidence — needs validation)
- `users.info` rate limit Tier 4 — stated by WebSearch results referencing Slack changelog; exact tier not surfaced in the method reference page fetched. Confirmed as "50+" or "100+" range by multiple community sources. Cache still required regardless.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages verified locally from `node_modules`, no new installations needed
- Architecture: HIGH — pure function pattern verified from domain types; `WebClient` API verified from dist types; `SectionBlock.fields` 2-column layout verified from type definition
- Block Kit constraints: HIGH — character limits verified from installed `@slack/types` and official docs
- Pitfalls: HIGH for type-system pitfalls (verified locally); MEDIUM for rate limit tier (community sources; WebClient handles retries regardless)
- UIDENT-03 resolution: MEDIUM — interpretation of "store Slack user IDs as canonical" vs "show display names in all views" requires planner to confirm the write-time resolution approach in Phase 25

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (Block Kit API is stable; `@slack/types@2.20.0` and `@slack/web-api` bundled in bolt@4.6.0 will not change without a version bump)
