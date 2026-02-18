# Roadmap: Wood Fired Bugs

## Milestones

- ✅ **v1.0 MVP** — Phases 1-6 (shipped 2026-02-13)
- ✅ **v1.1 Interface Parity & CLI Polish** — Phases 7-10 (shipped 2026-02-13)
- ✅ **v1.2 Claude Code Skills & Installer** — Phases 11-13 (shipped 2026-02-14)
- ✅ **v1.3 Multi-Agent Coordination** — Phases 14-16 (shipped 2026-02-14)
- ✅ **v1.4 Hardening and Polish** — Phases 17-22 (shipped 2026-02-17)
- 🚧 **v1.5 Slack Integration** — Phases 23-26 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-6) — SHIPPED 2026-02-13</summary>

- [x] Phase 1: Foundation (2/2 plans)
- [x] Phase 2: Data Model (2/2 plans)
- [x] Phase 3: REST API (2/2 plans)
- [x] Phase 4: MCP Server (2/2 plans)
- [x] Phase 5: CLI (3/3 plans)
- [x] Phase 6: Production (2/2 plans)

</details>

<details>
<summary>✅ v1.1 Interface Parity & CLI Polish (Phases 7-10) — SHIPPED 2026-02-13</summary>

- [x] Phase 7: Output Abstraction (2/2 plans)
- [x] Phase 8: Interactive CLI (3/3 plans)
- [x] Phase 9: CLI Feature Parity (3/3 plans)
- [x] Phase 10: MCP Tool Parity (2/2 plans)

</details>

<details>
<summary>✅ v1.2 Claude Code Skills & Installer (Phases 11-13) — SHIPPED 2026-02-14</summary>

- [x] Phase 11: MCP Stdio Compliance (2/2 plans)
- [x] Phase 12: Claude Code Skills (3/3 plans)
- [x] Phase 13: Installer & Documentation (2/2 plans)

</details>

<details>
<summary>✅ v1.3 Multi-Agent Coordination (Phases 14-16) — SHIPPED 2026-02-14</summary>

- [x] Phase 14: Event Infrastructure (4/4 plans)
- [x] Phase 15: Claim Protocol (4/4 plans)
- [x] Phase 16: Workflow Engine & Interface Parity (4/4 plans)

</details>

<details>
<summary>✅ v1.4 Hardening and Polish (Phases 17-22) — SHIPPED 2026-02-17</summary>

- [x] Phase 17: Core Reliability Fundamentals (4/4 plans) — completed 2026-02-17
- [x] Phase 18: Database & Status Model (2/2 plans) — completed 2026-02-17
- [x] Phase 19: Observability (2/2 plans) — completed 2026-02-17
- [x] Phase 20: Testing Depth (3/3 plans) — completed 2026-02-17
- [x] Phase 21: UX Polish (3/3 plans) — completed 2026-02-17
- [x] Phase 22: Infrastructure Hardening (1/1 plan) — completed 2026-02-17

</details>

### 🚧 v1.5 Slack Integration (In Progress)

**Milestone Goal:** Add Slack as a fourth interface with slash commands for all 24 CLI operations, bot notifications with per-channel subscriptions, Block Kit formatting, and Slack user identity resolution.

- [x] **Phase 23: Socket Mode Infrastructure** (2 plans) — Bolt app, DB migration, config schema, graceful shutdown, optional feature flag (completed 2026-02-18)
- [ ] **Phase 24: Block Kit Formatters & User Identity** — Pure formatter functions for tasks/projects/notifications, user ID cache
- [ ] **Phase 25: Slash Command Handlers** — All 24 CLI operations via `/tasks`, ack-first pattern, error responses
- [ ] **Phase 26: Notification Pipeline** — EventBus-to-Slack subscriber, per-channel routing, subscribe/unsubscribe commands

## Phase Details

### Phase 23: Socket Mode Infrastructure
**Goal**: The Slack bot connects to Slack via Socket Mode, the service starts without Slack tokens (optional feature), and the database schema supports channel subscriptions
**Depends on**: Phase 22
**Requirements**: SLCK-01, SLCK-02, SLCK-03, SLCK-04, NTFY-04
**Success Criteria** (what must be TRUE):
  1. Service starts normally with no Slack tokens in config — no errors, no Slack connection attempt
  2. Service starts with valid SLACK_BOT_TOKEN and SLACK_APP_TOKEN — Bolt app connects to Slack via Socket Mode and logs a connection confirmation
  3. Service shuts down gracefully and the Bolt WebSocket closes cleanly alongside Fastify (no stale connections)
  4. Missing or malformed Slack tokens produce a clear config validation error at startup with an actionable message
  5. The `slack_channel_subscriptions` table exists in the database after migration, with channel_id, project_id, and event_type columns and proper indexes
**Plans**: 2 plans

Plans:
- [x] 23-01-PLAN.md — Config schema (Slack tokens with both-or-neither validation) and migration 006 (slack_channel_subscriptions) — completed 2026-02-18
- [ ] 23-02-PLAN.md — SlackService class, @slack/bolt install, Fastify server integration with onClose hook

### Phase 24: Block Kit Formatters & User Identity
**Goal**: Pure TypeScript functions produce valid Block Kit JSON for every response type, and Slack user IDs are resolved to display names with a cached lookup
**Depends on**: Phase 23
**Requirements**: BKIT-01, BKIT-02, BKIT-03, BKIT-04, UIDENT-01, UIDENT-02, UIDENT-03
**Success Criteria** (what must be TRUE):
  1. A task list formatted by the Block Kit formatter renders status emoji, priority indicators, and assignee in a Slack message (verified by unit test with domain objects as input)
  2. A task detail card formatted by the Block Kit formatter includes all task fields in a structured layout (title, status, priority, assignee, description, due date, tags)
  3. A project list and project detail formatted by the Block Kit formatter use consistent structure matching task formatting conventions
  4. A notification message formatted by the Block Kit formatter includes task title, status change, assignee, and project with a link to the relevant slash command
  5. Slack user ID lookups resolve to display names, cache results in memory with a TTL, and tasks created or claimed from Slack show the resolved display name in CLI, REST, and MCP output
**Plans**: 3 plans

Plans:
- [ ] 24-01-PLAN.md — Task formatters (formatTaskList, formatTaskDetail, formatTaskNotification) with TDD
- [ ] 24-02-PLAN.md — Project formatters (formatProjectList, formatProjectDetail) with TDD
- [ ] 24-03-PLAN.md — UserIdentityCache (Slack user ID to display name resolution with TTL cache) with TDD

### Phase 25: Slash Command Handlers
**Goal**: Every CLI operation is accessible from Slack via `/tasks <subcommand>`, all handlers acknowledge within 3 seconds, and error responses are informative
**Depends on**: Phase 24
**Requirements**: SCMD-01, SCMD-02, SCMD-03, SCMD-04, SCMD-05, SCMD-06, SCMD-07, SCMD-08, SCMD-09, SCMD-10
**Success Criteria** (what must be TRUE):
  1. Typing `/tasks help` in Slack returns an ephemeral message listing all available subcommands with usage examples
  2. `/tasks list` returns an ephemeral Block Kit task list; `/tasks show <id>` returns an ephemeral task detail card — both within 3 seconds of the command
  3. `/tasks create <title>` creates a task and returns a confirmation card with the new task ID; `/tasks update <id> --status <status>` updates the task and confirms the change
  4. `/tasks claim <id>` claims a task using the Slack user's resolved display name as the assignee, confirmed by the response card
  5. Project, dependency, comment, and subtask subcommands are available and produce Block Kit responses with the same information as their CLI equivalents
  6. Any invalid subcommand, missing argument, or service error returns a Block Kit error message with the specific problem and a corrective usage hint
**Plans**: TBD

Plans:
- [ ] 25-01: TBD

### Phase 26: Notification Pipeline
**Goal**: Task events trigger bot messages to subscribed Slack channels, and users can manage per-channel subscriptions via slash commands
**Depends on**: Phase 24
**Requirements**: NTFY-01, NTFY-02, NTFY-03, NTFY-05
**Success Criteria** (what must be TRUE):
  1. When a task is created or its status changes, the bot posts a Block Kit notification message to every Slack channel subscribed to that project's events
  2. `/tasks subscribe` in a channel configures a subscription for that channel with optional project and event type filters, confirmed by an ephemeral response
  3. `/tasks unsubscribe` in a channel removes the channel's subscription and confirms removal
  4. Notification messages include task title, status change or creation event, assignee, and project name
  5. A Slack API error during notification posting is logged and retried without blocking other EventBus subscribers (SSEManager and WorkflowEngine continue to receive the event)
**Plans**: TBD

Plans:
- [ ] 26-01: TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1-6   | v1.0      | 13/13          | Complete | 2026-02-13 |
| 7-10  | v1.1      | 10/10          | Complete | 2026-02-13 |
| 11-13 | v1.2      | 7/7            | Complete | 2026-02-14 |
| 14-16 | v1.3      | 12/12          | Complete | 2026-02-14 |
| 17-22 | v1.4      | 15/15          | Complete | 2026-02-17 |
| 23. Socket Mode Infrastructure | 2/2 | Complete    | 2026-02-18 | - |
| 24. Block Kit Formatters & User Identity | v1.5 | 0/3 | Not started | - |
| 25. Slash Command Handlers | v1.5 | 0/TBD | Not started | - |
| 26. Notification Pipeline | v1.5 | 0/TBD | Not started | - |

---

*Last updated: 2026-02-18 — Phase 23 Plan 01 complete (config schema + migration 006)*
