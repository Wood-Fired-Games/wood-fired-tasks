# Project Research Summary

**Project:** Wood Fired Bugs — Slack Integration (v1.5)
**Domain:** Slack bot as a fourth interface to an existing Fastify/SQLite/EventBus task-tracking service
**Researched:** 2026-02-17
**Confidence:** HIGH

## Executive Summary

This milestone adds Slack as a fourth interface (alongside REST API, MCP server, and CLI) to an existing, well-structured Node.js/TypeScript task-tracking service. The integration is architecturally clean because the existing EventBus and service layer are designed for exactly this kind of extension: the Slack bot consumes the same services via direct injection and subscribes to the existing EventBus for outbound notifications. No changes to the service layer, repositories, or EventBus are required. The only new persistent data is a `slack_channel_subscriptions` table for per-channel notification routing.

The recommended approach is `@slack/bolt` v4.6 in Socket Mode — an outbound WebSocket to Slack's cloud that eliminates the need for any public URL, reverse proxy, or ngrok tunnel. This is the right choice for a LAN-hosted internal tool. Two new production dependencies are needed: `@slack/bolt` (the full Slack framework, bundling web-api and socket-mode internals) and `@slack/types` (Block Kit TypeScript types). The Bolt app runs as a co-process alongside Fastify in the same Node.js process, sharing service instances via constructor injection. ESM compatibility is confirmed via the official bolt-ts-starter-template, which uses `"type": "module"` + `@slack/bolt@^4.6.0` — exactly matching this project's `"module": "Node16"` tsconfig.

The primary risks are operational and data-model decisions, not architectural ones. The most critical: (1) `ack()` must be called as the first statement in every slash command handler or users see timeout errors; (2) Slack user IDs, not display names, must be stored as the canonical assignee identifier — display names are mutable and non-unique; (3) WebSocket connections must be cleanly closed on shutdown or stale connections accumulate until `too_many_websockets` errors appear. All three risks are preventable with upfront discipline rather than infrastructure changes.

---

## Key Findings

### Recommended Stack

The existing stack requires minimal additions. Only two new production dependencies are needed: `@slack/bolt@^4.6.0` (bundles `@slack/web-api` and `@slack/socket-mode` internally — no separate installs) and `@slack/types@^2.20.0` as a dev dependency for Block Kit TypeScript type safety.

**Core technologies (Slack milestone):**
- `@slack/bolt@^4.6.0`: Official Slack framework (Socket Mode, slash commands, event handling) — handles WebSocket lifecycle, ack() timeouts, middleware; no Express dependency in Socket Mode
- `@slack/types@^2.20.0`: Block Kit TypeScript types — compile-time safety for Block Kit JSON; actively maintained by Slack
- `better-sqlite3` (existing): New `slack_channel_subscriptions` table via existing umzug migration pattern — no new DB infrastructure
- EventBus singleton (`src/events/event-bus.ts`) (existing): Integration point for outbound notifications — zero changes needed

**What NOT to use:**
- `slack-block-builder`: Last published December 2021, missing 3+ years of Block Kit blocks — use raw JSON + `@slack/types`
- HTTP mode: Requires public URL and reverse proxy — Socket Mode eliminates all of this for LAN deployment
- Separate Slack process: Adds IPC complexity — run in same process via direct service injection
- `@slack/web-api` or `@slack/socket-mode` as direct dependencies: Already bundled inside `@slack/bolt`, separate install risks version conflicts
- `@types/express`: Bolt v4.2.1+ made it optional; Socket Mode does not use Express at all

### Expected Features

The feature surface is clearly divided into MVP (P1), post-validation (P2), and future (P3) tiers. The MVP must prove the full end-to-end integration before P2 work begins.

**Must have (table stakes — P1 launch):**
- Socket Mode setup — foundational; without this nothing else works
- `/bug help` — discoverability; all task bots require this
- `/bug list` and `/bug show <id>` — core read path; validates service integration end-to-end
- `/bug create`, `/bug claim <id>`, `/bug update <id> --status <s>` — core write path; validates Slack user identity flow
- Block Kit task card formatter — shared formatting; needed by all list, show, and notification output
- `slack_subscriptions` table + `/bug subscribe` / `/bug unsubscribe` — notification routing backbone; required before any bot notification can be delivered
- Bot notifications: `task.created` and `task.status_changed` — the core value proposition; proves outbound EventBus-to-Slack pipeline
- Slack user identity resolution (`users.info` → display_name for presentation, user ID for storage)
- Ephemeral responses for queries — Slack UX standard; in-channel only for team announcements

**Should have (differentiators — P2, after MVP validated):**
- `/bug list` with filters (`--status`, `--project`) — same filter power as CLI
- `/bug comment add <id> <text>`, `/bug assign <id> @user` — full CRUD parity from Slack
- Bot notification: `task.claimed`; per-channel event type filter
- Priority emoji indicators in Block Kit cards (`urgent` → `🔴`, `high` → `🟠`, etc.)
- `@mention` assignee in notifications (requires user_id↔display_name cache)
- `/bug projects` — project ID discovery from Slack

**Defer (v2+):**
- Interactive buttons on notification cards (claim/close without a command) — requires callback IDs, view submission handlers, significant state management
- Modal-based task creation — requires trigger_id and separate view handler; overkill for text commands
- Scheduled digests, due date reminders, full-text search from Slack

**Anti-features (explicitly avoid):**
- One slash command per operation (`/bug-list`, `/bug-create`) — Slack app registration overhead per command; use `/bug` + subcommand routing
- In-channel responses for query results — channel noise; ephemeral is the Slack UX standard for reads
- Notifications for every `task.updated` event by default — notification fatigue destroys bot adoption; default to status_changed only
- Storing Slack user tokens — single workspace bot token is sufficient for this use case

### Architecture Approach

The Slack interface slots into the existing layered architecture as a fourth interface. Five new components are needed; nothing in the existing service layer, EventBus, or repositories changes. The Bolt app runs in the same Node.js process as Fastify, sharing service instances via constructor injection. An environment flag (`SLACK_BOT_TOKEN` absent) gracefully disables the entire Slack interface so the service operates normally without Slack credentials in development and CI.

**Major components:**
1. `SlackApp` (`src/slack/app.ts`) — Creates and configures Bolt `App` with Socket Mode; owns WebSocket lifecycle (`start()` / `stop()`); registers all command handlers; passes `app.client` to `SlackNotifier`
2. Command Handlers (`src/slack/commands/`) — One file per domain (task-commands, project-commands, subscription-commands); enforces ack-first pattern; calls service layer directly (same as MCP server pattern)
3. Block Kit Formatters (`src/slack/blocks/`) — Pure functions: `Task`/`Project` domain types → Block Kit JSON arrays; no side effects; independently testable with no mocks needed
4. `SlackNotifier` (`src/slack/notifier.ts`) — Subscribes to EventBus events; queries `SlackChannelRepository` for routing; calls `app.client.chat.postMessage()` per channel; handles errors without blocking EventBus dispatch (fire-and-forget with internal retry)
5. `SlackChannelRepository` (`src/slack/repositories/channel.repository.ts`) — CRUD for `slack_channel_subscriptions` table using existing `db` instance and repository pattern

**Recommended build order:**
1. Config + Migration (DB schema + env vars — prerequisite for all other components)
2. Block Kit Formatters (pure functions, no dependencies — fastest to build and test)
3. Command Handlers and SlackNotifier (parallel — share no dependencies on each other)
4. SlackApp factory + startup wiring (integration — assembles all prior pieces)

### Critical Pitfalls

1. **ack() called after async work** — Call `await ack()` as the absolute first statement in every slash command handler. Slack's 3-second deadline is for the ack, not the response. Any `await` before `ack()` causes user-visible `operation_timeout` errors. The work continues after `ack()`; the actual response goes via `respond()` using the response_url (30-minute window).

2. **Slack display names stored as assignee identifiers** — Store Slack user IDs (`U012AB3CD`) as the canonical assignee everywhere in SQLite. Display names are mutable, non-unique, and cannot reliably reverse-resolve. Resolve to display name only at presentation time via a cached `users.info` lookup. Slack's official docs state: "apps should no longer be concerned with usernames — reference user IDs instead."

3. **Stale WebSocket connections from uncleaned shutdown** — Register `slackApp.stop()` in Fastify's `onClose` hook at the same time `slackApp.start()` is added. Unclean shutdowns leave Slack-side connections open for ~30 minutes. At 10 concurrent connections, Slack sends `too_many_websockets` and event delivery becomes unreliable. Recovery: revoke and regenerate the app-level token in the Slack dashboard.

4. **Async Slack API calls blocking the synchronous EventBus** — The existing EventBus `emit()` is synchronous. `SlackNotifier` handlers must fire-and-forget their async `postMessage` calls; awaiting them synchronously blocks SSEManager and WorkflowEngine from receiving the same event. Pattern: `this.onTaskEvent(event).catch(err => log.error(err))`.

5. **Bot cannot post to channels without chat:write.public scope** — Add `chat:write.public` to the bot's OAuth scopes in the Slack app manifest. `chat:write` alone requires the bot to be an explicit channel member. For a single-workspace internal tool, `chat:write.public` is simpler and more reliable than requiring `/invite @bot` in every subscribed channel.

---

## Implications for Roadmap

The Slack integration should be built in four phases ordered by dependency chain: infrastructure and data model first, pure formatting second, command handlers and notification subscriber in parallel, integration and startup wiring last.

### Phase 1: Socket Mode Infrastructure and Subscription Schema

**Rationale:** Everything else depends on the Bolt app existing, the database migration being applied, and the graceful shutdown hooks being in place. Choosing Socket Mode is an architectural fork — committing to it early eliminates the largest class of pitfalls (signature verification failures, raw body parsing conflicts, public URL management) before any feature work begins.

**Delivers:** Running Bolt `App` in Socket Mode connected to Slack; `slack_channel_subscriptions` table with proper indexes; `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` added to config schema; `slackApp.stop()` registered in Fastify `onClose` hook; optional Slack flag (disabled if env vars absent).

**Addresses:** FEATURES.md — "Socket Mode setup + request verification" (P1 table stakes)

**Avoids:**
- Pitfall 2: Bolt + Fastify port conflict (Socket Mode has no HTTP dependency; no receiver needed)
- Pitfall 3: `too_many_websockets` from stale connections (shutdown hook registered in same phase as `start()`)
- Pitfall 4: Signing secret / raw body issue (Socket Mode eliminates HTTP receiver entirely)
- Pitfall 8: Missing subscription index (index added in same migration as table creation)

### Phase 2: Block Kit Formatters

**Rationale:** Block Kit formatters are pure functions with no external dependencies. They can be built and fully unit-tested before any command handler or notification subscriber exists. Building them first means all subsequent phases inherit consistent, tested formatting rather than duplicating inline formatting logic. They are a cross-cutting concern that benefits every command response and every outbound notification equally.

**Delivers:** Type-safe Block Kit JSON builders for task cards (`formatTaskBlock`), task lists (`formatTaskListBlock`), project cards, and notification messages (`formatTaskNotificationBlock`). Unit tests use domain objects as input and verify Block Kit JSON structure against `@slack/types`.

**Addresses:** FEATURES.md — "Block Kit formatting for task cards" (P1 table stakes)

**Uses:** `@slack/types@^2.20.0` (dev dep), existing `Task`/`Project` domain types from `src/types/`

### Phase 3A: Slash Command Handlers

**Rationale:** Command handlers depend on Block Kit formatters (Phase 2) and the Bolt app (Phase 1) but are fully independent of the notification subscriber (Phase 3B). The ack-first pattern must be enforced as a hard rule in this phase — it is the most user-visible correctness requirement in the entire integration and easy to violate.

**Delivers:** Full MVP command set: `/bug help`, `/bug list`, `/bug show <id>`, `/bug create`, `/bug claim <id>`, `/bug update <id>`, `/bug subscribe`, `/bug unsubscribe`. Each handler: acks immediately, calls service layer directly via constructor injection, formats response with Block Kit, responds ephemerally. Slack user identity resolution (`users.info` cache) built alongside first handler that resolves names.

**Addresses:** FEATURES.md — all P1 table-stakes slash commands

**Avoids:**
- Pitfall 1: ack() after async work — ack-first enforced as a review checklist item for every handler
- Pitfall 6: Display name as assignee — user IDs stored from the first handler written, cache resolves display at render time
- Pitfall 7: Rate limit from unbatched `users.info` — `SlackUserCache` with 1-hour TTL and LRU cap built in this phase
- Pitfall 10: Command name mismatch — `SLACK_COMMANDS` constant array established as the single source of truth for command names

### Phase 3B: EventBus-to-Slack Notification Pipeline

**Rationale:** `SlackNotifier` depends on Block Kit formatters (Phase 2), the channel repository (Phase 1 migration), and the Bolt client (Phase 1), but has no dependency on command handlers (Phase 3A). Build in parallel with 3A. The critical design decision — fire-and-forget async calls to avoid blocking the synchronous EventBus — must be established here, not retrofitted.

**Delivers:** `SlackNotifier` subscribing to `task.created`, `task.status_changed`, and `task.claimed` EventBus events; per-channel subscription routing via `SlackChannelRepository`; error handling that retries transient Slack API failures without blocking EventBus dispatch or other subscribers.

**Addresses:** FEATURES.md — all P1 bot notification requirements (`task.created`, `task.status_changed`)

**Avoids:**
- Pitfall 4: Async Slack calls blocking EventBus — fire-and-forget pattern established as the standard from the start
- Pitfall 5: Bot not in channel — `chat:write.public` scope confirmed in app manifest before first `postMessage`
- Pitfall 9: Silent notification failure — retry wrapper inside subscriber; transient vs. permanent errors classified and logged

### Phase 4: Integration, Startup Wiring, and End-to-End Validation

**Rationale:** Assembly phase. All components exist from Phases 1-3; this phase wires them together in the startup sequence and validates the full round-trip: slash command → service call → Block Kit response, and domain event → EventBus → SlackNotifier → channel message. Intentionally last because integration testing is most valuable when individual components are already tested.

**Delivers:** Production-ready startup sequence in `src/api/start.ts`; graceful shutdown with Bolt cleanup; optional Slack (env-flag disabled if tokens absent); integration tests covering both the command-to-response and event-to-notification flows.

**Implements:** Architecture component — `createSlackApp()` factory initialized alongside `createServer()`; `Promise.all([fastify.listen(), boltApp.start()])` startup pattern

### Phase Ordering Rationale

- **Infrastructure before all feature work:** The Bolt app, DB migration, and shutdown hooks are prerequisites for every other phase. No handler or notification can be tested against Slack without them.
- **Formatters before handlers:** Block Kit formatters are independently testable pure functions. Building them first prevents duplication and creates a tested formatting foundation that both command handlers and the notification subscriber reuse.
- **Handlers and notifier in parallel (3A + 3B):** These two feature areas share no implementation dependencies on each other. Running them in parallel is the fastest path to a working MVP.
- **Integration wiring last:** Assembling components is cheaper after each component is individually proven. Integration tests at Phase 4 validate the wiring, not the logic — the logic was validated in each prior phase.
- **Pitfall prevention is phase-native:** Each pitfall is addressed at the phase where it first appears, not retrofitted. The ack-first pattern is established in Phase 3A; fire-and-forget async is established in Phase 3B; shutdown hooks are in Phase 1 alongside `start()`.

### Research Flags

All phases can proceed without additional `/gsd:research-phase` investigation. The research was comprehensive and all critical integration points were verified against official Slack documentation and bolt-js GitHub issues.

Phases with standard patterns (skip research-phase):
- **Phase 1:** Socket Mode setup is fully documented by official Slack docs and the bolt-ts-starter-template. The umzug migration pattern is already established in this codebase.
- **Phase 2:** Pure TypeScript with `@slack/types`. Standard unit testing. No external integration.
- **Phase 3A:** Bolt `app.command()` is thoroughly documented. Ack-first rule is unambiguous. Standard patterns apply.
- **Phase 3B:** EventBus subscription pattern already exists for SSEManager — SlackNotifier is an exact parallel. Fire-and-forget async is a known Node.js pattern.
- **Phase 4:** Bolt + Fastify co-process is confirmed by official gist from a Bolt maintainer. Standard startup orchestration.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | `@slack/bolt` v4.6 + ESM compatibility confirmed via official bolt-ts-starter-template. Only 2 new prod deps. No alternatives ambiguous. |
| Features | HIGH | Core Slack mechanics verified against official Slack Developer Docs. EventBus integration assessed from direct codebase inspection. Existing system well-understood. |
| Architecture | HIGH (Bolt patterns), MEDIUM (subscription storage) | Bolt SDK integration verified from official docs and GitHub issues. Per-channel subscription storage in SQLite derived from codebase conventions; no single canonical Slack pattern found. |
| Pitfalls | HIGH | All 10 critical pitfalls verified with official Slack docs and bolt-js GitHub issues. Recovery strategies documented. |

**Overall confidence:** HIGH

### Gaps to Address

- **SQLite `json_each()` query for event_type filtering:** The `SlackChannelRepository.findSubscribed()` query uses SQLite's `json_each()` function to filter channels by event type stored as a JSON array column. This query was described in research but not executed. Validate the `json_each()` query against a real SQLite test database during Phase 1 before the repository is used by any downstream component.

- **Slack app manifest / Dashboard configuration:** Slack App must be manually configured in the Slack Developer Console (Socket Mode enabled, slash commands registered, OAuth scopes added). This is operational setup that must precede Phase 1 code testing. Document the exact required scopes (`chat:write`, `chat:write.public`, `commands`, `channels:read`, `connections:write`) as part of Phase 1 deliverables.

- **Existing `assignee` field data model compatibility:** The existing task `assignee` field currently stores human-readable strings (from CLI and REST API). When Slack creates tasks, it will store Slack user IDs (`U012AB3CD`). Validate during Phase 3A whether this mixed-format field is acceptable or whether a display-name resolution layer needs to be applied uniformly at the service layer (affects CLI output when tasks were created from Slack).

- **`too_many_websockets` recovery procedure for development:** During active development with frequent restarts, stale connection accumulation is a real risk. Document the token revocation procedure (Slack Dashboard → App Settings → App-Level Tokens → Revoke → Regenerate) as part of Phase 1 onboarding so developers know the recovery path before they hit it.

---

## Sources

### Primary (HIGH confidence — Official Docs + Official Repositories)

- [bolt-ts-starter-template package.json](https://raw.githubusercontent.com/slack-samples/bolt-ts-starter-template/main/package.json) — ESM + `@slack/bolt@^4.6.0` compatibility confirmed
- [Bolt JS Getting Started](https://docs.slack.dev/tools/bolt-js/getting-started) — Socket Mode tokens and configuration
- [Socket Mode Docs](https://docs.slack.dev/apis/events-api/using-socket-mode/) — Required tokens, scopes, WebSocket connection limits
- [Implementing slash commands — Slack Official](https://docs.slack.dev/interactivity/implementing-slash-commands/) — 3-second ack deadline, response types
- [Acknowledging requests — Bolt JS Docs](https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/) — ack() timing constraints
- [chat.postMessage reference](https://docs.slack.dev/reference/methods/chat.postMessage/) — Required params, OAuth scopes
- [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/) — HMAC-SHA256 signing
- [Slack changelog: farewell to usernames](https://docs.slack.dev/changelog/2017-09-the-one-about-usernames/) — User ID vs display name canonical guidance
- [Rate limits — Slack Developer Docs](https://docs.slack.dev/apis/web-api/rate-limits/) — Tier classifications for `users.info`
- [@slack/bolt npm](https://www.npmjs.com/package/@slack/bolt) — v4.6.0, bundled dependencies confirmed
- [bolt-js GitHub package.json](https://github.com/slackapi/bolt-js/blob/main/package.json) — CJS-only, bundled web-api and socket-mode

### Secondary (MEDIUM confidence — Official but indirect)

- [Bolt v3→v4 Migration Guide](https://github.com/slackapi/bolt-js/wiki/Bolt-v3-%E2%80%90--v4-Migration-Guide) — Breaking changes, TypeScript type changes
- [bolt-js #834: Custom receiver discarded with socketMode](https://github.com/slackapi/bolt-js/issues/834) — Pitfall 2 verification
- [bolt-js #2238: too_many_websockets](https://github.com/slackapi/bolt-js/issues/2238) — Pitfall 3 verification
- [bolt-js #1548, #1727: operation_timeout](https://github.com/slackapi/bolt-js/issues/1548) — Pitfall 1 verification
- [Bolt + Fastify integration gist by @seratch](https://gist.github.com/seratch/2b97e752645e83322a1066a9c24e2a20) — Co-process architecture pattern
- [@slack/types npm](https://www.npmjs.com/package/@slack/types) — v2.20.0, actively maintained
- [Jira for Slack channel notifications](https://support.atlassian.com/jira-software-cloud/docs/use-jira-cloud-for-slack/) — Per-channel subscribe model comparison

### Tertiary (LOW confidence — Indirect, consistent with other sources)

- `slack-block-builder` last published Dec 2021 — treat as unmaintained; confirmed via GitHub releases page
- Socket Mode limit of 10 WebSocket connections per app — from official Socket Mode docs; non-issue for single-workspace LAN deployment

---

*Research completed: 2026-02-17*
*Ready for roadmap: yes*
