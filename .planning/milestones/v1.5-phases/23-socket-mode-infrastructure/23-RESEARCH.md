# Phase 23: Socket Mode Infrastructure - Research

**Researched:** 2026-02-17
**Domain:** @slack/bolt Socket Mode, Zod optional config, SQLite migration, Fastify lifecycle
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SLCK-01 | Slack app connects via Socket Mode with bot token and app-level token validated at startup | `App({ token, socketMode: true, appToken })` + `await app.start()` — verified via official Bolt docs |
| SLCK-02 | Slack connection shuts down gracefully alongside Fastify via onClose hook | `fastify.addHook('onClose', async () => { await slackApp.stop(); })` — `App.stop()` calls `SocketModeReceiver.stop()` which calls `client.disconnect()` |
| SLCK-03 | Slack bot/app tokens added to Zod config schema with clear error messages on missing values | `z.string().optional()` + `.refine()` for both-or-neither validation — verified locally with the actual zod@4 version in use |
| SLCK-04 | Slack integration is optional — service starts without Slack tokens configured | Guard on `config.SLACK_BOT_TOKEN` presence before constructing `App` and calling `app.start()` |
| NTFY-04 | Channel subscription configuration persists in SQLite (new migration) | Migration 006 — new `slack_channel_subscriptions` table; follows established Umzug numbered migration pattern |

</phase_requirements>

---

## Summary

Phase 23 wires a Slack bot into the existing Fastify service using `@slack/bolt@^4.6.0` in Socket Mode. The Bolt `App` lives in the same Node.js process as Fastify and is started/stopped via Fastify's `onClose` lifecycle hook — the same pattern already used by `ClaimReleaseService`, `WorkflowEngine`, and `SSEManager`. No new process or IPC is needed.

The Slack integration is controlled by the presence of two environment variables: `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. When both are absent, the service starts normally with no Bolt code executed. When either is present without the other, the Zod schema (using `.refine()`) produces a clear error at startup. This is a standard optional-feature-flag pattern in this codebase — the config schema is the single source of truth.

The migration (006) is a straightforward `CREATE TABLE` with indexes — no table rebuilds are required. The `event_type` column stores a single TEXT value (not a JSON array) per row, meaning one subscription row per channel+event-type combination. This is the normalized approach preferred for SQLite. The prior decision to validate `json_each()` against a real test DB applies to future query work in later phases, not this table-creation migration itself.

**Primary recommendation:** Add optional Slack tokens to the Zod `configSchema` via `.refine()`, write a `SlackService` class with `start()`/`stop()` that wraps `@slack/bolt` `App`, register it in `createServer()` behind a token-presence guard, and add migration 006.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @slack/bolt | ^4.6.0 | Slack app framework — event handling, Socket Mode, Block Kit | Official Slack SDK; decided in prior phases |
| @slack/types | ^2.20.0 | Block Kit TypeScript type definitions | Dev-only for compile-time safety; no runtime cost; already decided |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @slack/socket-mode | 2.0.5 (bundled with bolt) | Underlying WebSocket client | Transitive — bolt includes it; do NOT install separately |
| zod | ^4.3.6 (already installed) | Config schema validation for SLACK_BOT_TOKEN, SLACK_APP_TOKEN | Already in use for all config validation |
| umzug | ^3.8.2 (already installed) | Migration runner | Already in use; add 006 migration file |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @slack/bolt | @slack/web-api + @slack/socket-mode directly | Bolt abstracts the receiver/lifecycle — less boilerplate, no advantage to going raw here |
| Single row per subscription (channel+event_type) | JSON array in event_types column + json_each() | Normalized rows are simpler to query, index, and maintain in SQLite; json_each avoids indexing |
| Bolt co-process in Fastify | Separate service process | Direct service injection (no IPC) is simpler and already the established architecture pattern |

**Installation:**
```bash
npm install @slack/bolt@^4.6.0
npm install --save-dev @slack/types@^2.20.0
```

---

## Architecture Patterns

### Recommended Project Structure
```
src/
├── config/
│   └── env.ts                        # Add SLACK_BOT_TOKEN, SLACK_APP_TOKEN (optional)
├── services/
│   └── slack.service.ts              # NEW: SlackService wraps @slack/bolt App
├── db/
│   └── migrations/
│       └── 006-slack-channel-subscriptions.ts  # NEW: migration
└── api/
    └── server.ts                     # Register SlackService in createServer()
```

### Pattern 1: Optional Feature Flag via Token Presence

**What:** The Bolt `App` is only constructed and started when `SLACK_BOT_TOKEN` is present. When absent, the `SlackService` is a no-op stub (or simply not instantiated).

**When to use:** Any integration that is optionally configured via environment variables.

**Example:**
```typescript
// src/services/slack.service.ts
import { App } from '@slack/bolt';
import type { Logger } from 'pino';

export class SlackService {
  private app: App | null = null;

  constructor(
    private readonly botToken: string | undefined,
    private readonly appToken: string | undefined,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    if (!this.botToken || !this.appToken) {
      this.logger.info('Slack tokens not configured — Slack integration disabled');
      return;
    }

    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
    });

    await this.app.start();
    this.logger.info('Slack app connected via Socket Mode');
  }

  async stop(): Promise<void> {
    if (!this.app) return;
    await this.app.stop();
    this.logger.info('Slack app disconnected');
  }

  isEnabled(): boolean {
    return this.app !== null;
  }

  getApp(): App | null {
    return this.app;
  }
}
```

### Pattern 2: Zod Both-or-Neither Validation

**What:** `z.string().optional()` for each token, combined with `.refine()` to enforce that both must be present or both absent. This produces a clear actionable error message at startup.

**When to use:** When two config values are interdependent — both required together or both omitted.

**Example:**
```typescript
// Addition to src/config/env.ts configSchema
export const configSchema = z.object({
  // ... existing fields ...
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
}).refine(
  (d) => (!d.SLACK_BOT_TOKEN && !d.SLACK_APP_TOKEN) || (!!d.SLACK_BOT_TOKEN && !!d.SLACK_APP_TOKEN),
  {
    message: 'Both SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be provided together, or neither should be set',
    path: ['SLACK_APP_TOKEN'],
  }
);
```

**Verified:** Tested locally against zod@4.3.6 — `.refine()` is supported; empty object passes; both present passes; only one present fails with the custom message.

### Pattern 3: Fastify onClose Hook for Bolt Lifecycle

**What:** Register a Fastify `onClose` hook to call `slackService.stop()`. This follows the existing pattern in `server.ts` for `ClaimReleaseService`, `WorkflowEngine`, and `SSEManager`.

**When to use:** Any service that needs cleanup on server shutdown.

**Example:**
```typescript
// In createServer() in src/api/server.ts
const slackService = new SlackService(
  config.SLACK_BOT_TOKEN,
  config.SLACK_APP_TOKEN,
  server.log
);

// Start Slack (no-op if tokens absent)
await slackService.start();

// Shutdown alongside Fastify
server.addHook('onClose', async () => {
  clearInterval(idempotencyCleanupInterval);
  claimReleaseService.stop();
  sseManager.shutdown();
  app.workflowEngine.stop();
  await slackService.stop();  // ADD THIS
});
```

### Pattern 4: Migration 006 — slack_channel_subscriptions

**What:** Simple additive migration creating a new table. No existing table is modified.

**When to use:** Additive schema changes — no table rebuild needed.

**Example:**
```typescript
// src/db/migrations/006-slack-channel-subscriptions.ts
import type Database from 'better-sqlite3';

export async function up(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE slack_channel_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(channel_id, project_id, event_type)
      )
    `);

    db.exec(`
      CREATE INDEX idx_slack_subs_channel_id ON slack_channel_subscriptions(channel_id)
    `);

    db.exec(`
      CREATE INDEX idx_slack_subs_project_id ON slack_channel_subscriptions(project_id)
    `);

    db.exec(`
      CREATE INDEX idx_slack_subs_event_type ON slack_channel_subscriptions(event_type)
    `);
  })();
}

export async function down(db: Database.Database): Promise<void> {
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS slack_channel_subscriptions');
  })();
}
```

**Key schema decisions:**
- `event_type` is a single TEXT column (not a JSON array). One row per channel+project+event_type combination. This is the normalized approach; no json_each() needed for this migration.
- `UNIQUE(channel_id, project_id, event_type)` prevents duplicate subscriptions.
- `project_id` is a FK to `projects(id) ON DELETE CASCADE` — subscriptions auto-delete when a project is removed.
- Indexes on all three filter columns to support future query patterns.
- The prior decision notes "validate against real SQLite test DB during Phase 23" — this refers to future query work using `json_each()` on the `event_type` column IF a different approach is chosen later. With normalized rows, no `json_each()` is needed here.

### Anti-Patterns to Avoid
- **Starting Bolt before Fastify is ready:** `slackService.start()` should be called after `createServer()` finishes setting up decorations and hooks, but the non-async nature of `addHook` makes ordering clear — register hooks, THEN call `start()` outside of `createServer()` or as the last step.
- **Calling `app.start()` unconditionally:** Without the token-presence guard, an `App` instantiation with `undefined` token will throw at Bolt's constructor level with an unhelpful error.
- **Installing `@slack/socket-mode` separately:** It is a bundled dependency of `@slack/bolt`. Separate installation creates version conflicts.
- **Storing event_types as a JSON array column:** SQLite can do it with `json_each()`, but normalized rows are simpler to index, query, and validate at the DB layer (e.g., FK checks, UNIQUE constraints).
- **Using `express` peer dep:** `@slack/bolt` lists `@types/express@^5.0.0` as a peer dep. Since this project uses Fastify (not Express), the Express receiver is never used. The peer dep warning is safe to ignore or suppress via `--legacy-peer-deps`; no Express code is needed.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Slack WebSocket connection management | Custom WebSocket client | `@slack/bolt` with `socketMode: true` | Handles reconnects, heartbeats, disconnect events, ack lifecycle |
| Token validation error messages | Custom env parsing | Zod `.refine()` on configSchema | Consistent with existing config pattern; surfaces at startup before server binds |
| Lifecycle stop/start | Custom process signals | Fastify `addHook('onClose', ...)` | Already the established pattern; hooks run in order, awaited properly |

**Key insight:** The Bolt receiver lifecycle (`start()`/`stop()`) is the only interface this phase needs. The underlying `@slack/socket-mode` client reconnect logic is entirely handled by Bolt.

---

## Common Pitfalls

### Pitfall 1: Bolt `App` Constructor Throws on Missing Token
**What goes wrong:** If `SLACK_BOT_TOKEN` is `undefined` and passed directly to `new App({ token: undefined, ... })`, Bolt throws an initialization error with a poor message.
**Why it happens:** Bolt validates tokens at constructor time in v4, not lazily.
**How to avoid:** Guard with `if (!this.botToken || !this.appToken) return;` before constructing `App`. The Zod schema catches the "one but not both" case; the guard handles the "both absent = disabled" case.
**Warning signs:** Error like `"token must be defined"` during server startup when tokens are intentionally absent.

### Pitfall 2: `App.stop()` Called Before `App.start()`
**What goes wrong:** If the onClose hook fires before `slackService.start()` completes (race), `app.stop()` may be called on an uninitialized client.
**Why it happens:** `start()` is async; if an error occurs mid-startup and Fastify shuts down, `onClose` still fires.
**How to avoid:** Track `private started = false` state in `SlackService`. Only call `this.app.stop()` if `this.started` is true. Or null-check `this.app` before calling `.stop()`.
**Warning signs:** `"This App instance is not yet initialized"` during shutdown.

### Pitfall 3: WebSocket Disconnects During Development
**What goes wrong:** Bolt Socket Mode disconnects every few hours (Slack-side rotation). This is expected behavior, not a bug.
**Why it happens:** Slack rotates Socket Mode WebSocket connections periodically.
**How to avoid:** Do not treat disconnect events as fatal. Bolt's internal reconnect logic handles this. Log at `debug` or `info`, not `error`.
**Warning signs:** Spurious error logs in production about disconnect events.

### Pitfall 4: Migration File Naming
**What goes wrong:** The next migration must be named `006-*` to follow the Umzug glob ordering pattern.
**Why it happens:** Umzug uses alphabetical ordering of filenames. Files `001` through `005` exist; the next must be `006`.
**How to avoid:** Check `src/db/migrations/` before creating — confirmed it ends at `005-backlogged-status.ts`.
**Warning signs:** Migration not running, or running out of order.

### Pitfall 5: Zod v4 `.refine()` Path
**What goes wrong:** In Zod v4, `.refine()` path must be specified in the options object or the error appears on the root `""` path, making it harder to surface in formatted error output.
**Why it happens:** Zod v4 changed how cross-field refinement errors are surfaced vs v3.
**How to avoid:** Specify `path: ['SLACK_APP_TOKEN']` in the refine options to attach the error to a named field, matching how `loadConfig()` formats errors via `issue.path.join('.')`.

---

## Code Examples

Verified patterns from official sources and local verification:

### Bolt Socket Mode Initialization (Official Docs)
```typescript
// Source: https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/
import { App } from '@slack/bolt';

const app = new App({
  token: process.env.BOT_TOKEN,
  socketMode: true,
  appToken: process.env.APP_TOKEN,
});

await app.start();
```

### Bolt App.stop() — What It Does (Verified via GitHub source)
```typescript
// Source: https://github.com/slackapi/bolt-js/blob/main/src/receivers/SocketModeReceiver.ts
// App.stop() delegates to SocketModeReceiver.stop() which:
public stop(): Promise<void> {
  if (this.httpServer !== undefined) {
    this.httpServer.close((error) => {
      if (error) this.logger.error(`Failed to shutdown the HTTP server...`);
    });
  }
  return new Promise((resolve, reject) => {
    try {
      this.client.disconnect();  // Closes the WebSocket
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}
// Conclusion: App.stop() is safe to await; it closes the WebSocket cleanly.
```

### Zod Both-or-Neither (Verified locally against zod@4.3.6)
```typescript
// Tested locally — works correctly:
const schema = z.object({
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
}).refine(
  (d) => (!d.SLACK_BOT_TOKEN && !d.SLACK_APP_TOKEN) || (!!d.SLACK_BOT_TOKEN && !!d.SLACK_APP_TOKEN),
  {
    message: 'Both SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be provided together, or neither should be set',
    path: ['SLACK_APP_TOKEN'],
  }
);
// both absent → success
// both present → success
// only SLACK_BOT_TOKEN → failure with clear message
```

### Fastify onClose Hook (Existing Pattern in server.ts)
```typescript
// Source: /home/stuart/wood-fired-bugs/src/api/server.ts lines 134-139
server.addHook('onClose', async () => {
  clearInterval(idempotencyCleanupInterval);
  claimReleaseService.stop();
  sseManager.shutdown();
  app.workflowEngine.stop();
  // Phase 23 adds:
  await slackService.stop();
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| @slack/bolt v3 with `@slack/socket-mode` v1 | @slack/bolt v4.6.0 with `@slack/socket-mode` v2 | bolt v4.0.0 (2024) | `@slack/types` no longer re-exported without namespace; `ignoreSelf` is now a value not a function call |
| HTTP-based Slack apps (requires public URL) | Socket Mode (WebSocket, no public URL) | Socket Mode GA'd 2021 | LAN deployment works; no ngrok or reverse proxy needed |
| `express` as mandatory receiver | Express is optional; `SocketModeReceiver` available | bolt v3.0.0+ | Can use socket mode without Express; Express peer dep warning is safe to ignore |

**Deprecated/outdated:**
- `@slack/bolt v3 SocketModeFunctions.defaultProcessEventErrorHandler()`: Now import the named export directly — `defaultProcessEventErrorHandler`. Not relevant for Phase 23 (no custom error handler needed yet).
- `ignoreSelf()` (function call) → `ignoreSelf` (value): Not relevant unless middleware is registered in Phase 23.

---

## Open Questions

1. **Should `SlackService` be decorated onto the Fastify instance?**
   - What we know: Other services (`taskService`, `sseManager`, etc.) are decorated for route access. Slack event handlers in Phase 23 scope are likely registered inside `SlackService` directly, not in routes.
   - What's unclear: Future phases may need route handlers to trigger Slack actions. Whether that needs Fastify decoration or direct service injection is a planner decision.
   - Recommendation: Do NOT decorate in Phase 23. `SlackService` is a standalone co-process. Decorate only if Phase 24+ route handlers need it.

2. **Where exactly in `createServer()` should `slackService.start()` be called?**
   - What we know: `start()` must be called after the `onClose` hook is registered (so cleanup is guaranteed). It should be called before `server.listen()`.
   - What's unclear: `createServer()` currently returns `{ server, app }` — `start.ts` calls `server.listen()`. The cleanest place is at the end of `createServer()` after all hooks are registered.
   - Recommendation: Call `await slackService.start()` at the end of `createServer()`, before the return statement.

3. **Should the Slack feature gate log at `info` or `debug` when disabled?**
   - What we know: The existing patterns log service starts at `info`.
   - What's unclear: "Slack disabled" might be noise in production logs.
   - Recommendation: Log at `info` for visibility — this is a notable startup configuration fact.

---

## Sources

### Primary (HIGH confidence)
- Official Bolt Socket Mode docs (https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/) — App initialization pattern
- GitHub slackapi/bolt-js `src/receivers/SocketModeReceiver.ts` (https://github.com/slackapi/bolt-js/blob/main/src/receivers/SocketModeReceiver.ts) — `stop()` implementation
- GitHub slackapi/bolt-js wiki migration guide (https://github.com/slackapi/bolt-js/wiki/Bolt-v3-%E2%80%90--v4-Migration-Guide) — breaking changes v3→v4
- Local codebase: `/home/stuart/wood-fired-bugs/src/config/env.ts` — existing configSchema and loadConfig() pattern
- Local codebase: `/home/stuart/wood-fired-bugs/src/api/server.ts` — existing onClose hook pattern
- Local codebase: `/home/stuart/wood-fired-bugs/src/db/migrations/` — migration naming convention (001–005)
- Local zod@4.3.6 test: Verified `.refine()` with both-or-neither works correctly in the actual installed version

### Secondary (MEDIUM confidence)
- npm info @slack/bolt — confirmed version 4.6.0, Node >=18 requirement
- npm info @slack/socket-mode — confirmed version 2.0.5 (bundled)
- npm info @slack/types — confirmed version 2.20.0

### Tertiary (LOW confidence — informational only)
- WebSearch: Bolt v4 general community patterns — consistent with official docs but not independently verified beyond official sources

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — npm registry confirmed 4.6.0; official docs verified socket mode API
- Architecture: HIGH — patterns derived from existing codebase + official Bolt API; stop() implementation verified from GitHub source
- Pitfalls: HIGH for token-guard and migration naming (locally verified); MEDIUM for WebSocket disconnect behavior (documented behavior, not locally tested)
- Migration schema: HIGH — simple additive CREATE TABLE; no ambiguity

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (Bolt 4.x is stable; no expected breaking changes in 30 days)
