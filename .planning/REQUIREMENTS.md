# Requirements: Wood Fired Bugs v1.5

**Defined:** 2026-02-17
**Core Value:** Any agent on the local network can reliably create, find, and update work items in real time — making this the single source of truth for all Wood Fired Games task tracking.

## v1.5 Requirements

Slack integration milestone — adding Slack as a fourth interface with slash commands, bot notifications, and per-channel subscriptions.

### Slack Infrastructure

- [ ] **SLCK-01**: Slack app connects via Socket Mode with bot token and app-level token validated at startup
- [ ] **SLCK-02**: Slack connection shuts down gracefully alongside Fastify via onClose hook
- [ ] **SLCK-03**: Slack bot/app tokens added to Zod config schema with clear error messages on missing values
- [ ] **SLCK-04**: Slack integration is optional — service starts without Slack tokens configured (feature flag via presence of tokens)

### Slash Commands

- [ ] **SCMD-01**: Single `/tasks` command with subcommand routing handles all 24 CLI operations
- [ ] **SCMD-02**: All slash command handlers call ack() within 3 seconds and use respond() for results
- [ ] **SCMD-03**: `/tasks help` shows available subcommands with usage examples
- [ ] **SCMD-04**: `/tasks list` displays tasks with Block Kit formatting (status colors, priority indicators)
- [ ] **SCMD-05**: `/tasks show <id>` displays task detail card with metadata, comments, and dependencies
- [ ] **SCMD-06**: `/tasks create <title>` creates a task, returning confirmation card with task ID
- [ ] **SCMD-07**: `/tasks update <id> --status <status>` updates task fields
- [ ] **SCMD-08**: `/tasks claim <id>` claims a task using the Slack user's resolved identity
- [ ] **SCMD-09**: Project, dependency, comment, and subtask subcommands achieve full CLI parity
- [ ] **SCMD-10**: Error responses use Block Kit formatting with actionable error messages

### Block Kit Formatting

- [ ] **BKIT-01**: Task list responses use Block Kit sections with status emoji, priority colors, and assignee
- [ ] **BKIT-02**: Task detail cards show all fields in structured Block Kit layout
- [ ] **BKIT-03**: Project list and detail responses use consistent Block Kit formatting
- [ ] **BKIT-04**: Notification messages use Block Kit with task summary, status change, and link to relevant command

### Notifications

- [ ] **NTFY-01**: Bot posts task event notifications to subscribed Slack channels
- [ ] **NTFY-02**: `/tasks subscribe` configures per-channel subscriptions with project and event type filters
- [ ] **NTFY-03**: `/tasks unsubscribe` removes channel subscriptions
- [ ] **NTFY-04**: Channel subscription configuration persists in SQLite (new migration)
- [ ] **NTFY-05**: Notification formatting includes task title, status change, assignee, and project

### User Identity

- [ ] **UIDENT-01**: Slack user IDs are resolved to display names for task created_by/assignee fields
- [ ] **UIDENT-02**: User ID to display name mapping is cached in memory with TTL to avoid rate limiting
- [ ] **UIDENT-03**: Tasks created/claimed via Slack show the resolved display name in CLI/REST/MCP views

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-workspace OAuth distribution | Single workspace custom app sufficient; no app directory listing needed |
| Interactive buttons/modals | Callback handler infrastructure adds complexity; slash commands sufficient for v1.5 |
| Slack Events API (HTTP mode) | Socket Mode eliminates need for public URL; better fit for LAN deployment |
| Thread-based conversations | Bot posts top-level messages; threading adds UX complexity |
| Slack user profile sync | Display name cache is sufficient; no need to maintain full profile records |
| @mention in notification messages | Requires mapping all team members; add in v1.6 if valuable |
| Message scheduling/batching | Direct posting is sufficient for single-workspace volume |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SLCK-01 | Phase 23 | Pending |
| SLCK-02 | Phase 23 | Pending |
| SLCK-03 | Phase 23 | Pending |
| SLCK-04 | Phase 23 | Pending |
| NTFY-04 | Phase 23 | Pending |
| BKIT-01 | Phase 24 | Pending |
| BKIT-02 | Phase 24 | Pending |
| BKIT-03 | Phase 24 | Pending |
| BKIT-04 | Phase 24 | Pending |
| UIDENT-01 | Phase 24 | Pending |
| UIDENT-02 | Phase 24 | Pending |
| UIDENT-03 | Phase 24 | Pending |
| SCMD-01 | Phase 25 | Pending |
| SCMD-02 | Phase 25 | Pending |
| SCMD-03 | Phase 25 | Pending |
| SCMD-04 | Phase 25 | Pending |
| SCMD-05 | Phase 25 | Pending |
| SCMD-06 | Phase 25 | Pending |
| SCMD-07 | Phase 25 | Pending |
| SCMD-08 | Phase 25 | Pending |
| SCMD-09 | Phase 25 | Pending |
| SCMD-10 | Phase 25 | Pending |
| NTFY-01 | Phase 26 | Pending |
| NTFY-02 | Phase 26 | Pending |
| NTFY-03 | Phase 26 | Pending |
| NTFY-05 | Phase 26 | Pending |

**Coverage:**
- v1.5 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0

---
*Requirements defined: 2026-02-17*
*Last updated: 2026-02-17 — traceability mapped to phases 23-26*
