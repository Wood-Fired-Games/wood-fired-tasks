# wood-fired-tasks docs

Owner: Repository maintainers

This directory holds the reference and agent-facing docs for `wood-fired-tasks`. Start with [`AGENTS.md`](../AGENTS.md) at the repo root, then follow the read order in [`AGENT_CONTEXT.md`](AGENT_CONTEXT.md). Everything here is vendor-neutral — Claude, Cursor, Gemini, Codex, and human contributors all read the same files.

## Index by audience

### Agents (vendor-neutral)

| File | Purpose |
|------|---------|
| [`AGENT_CONTEXT.md`](AGENT_CONTEXT.md) | Authoritative contract: which agent-facing files exist, their budgets, owners, freshness rules. |
| [`REPO_MAP.md`](REPO_MAP.md) | Compact tree of `src/`, `docs/`, `scripts/` with per-directory ownership. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | System one-pager: data flow across API, MCP, CLI, Slack, DB. |
| [`WORKFLOWS.md`](WORKFLOWS.md) | Canonical build, test, lint, migrate, run, smoke recipes. |
| [`INTERFACES.md`](INTERFACES.md) | Source-verified index of REST routes, MCP tools, CLI commands. |
| [`NAVIGATION.md`](NAVIGATION.md) | Task-oriented index: "if you want to do X, read these files." |
| [`ONBOARDING_SMOKE.md`](ONBOARDING_SMOKE.md) | Seven onboarding probe scenarios that prove a fresh agent can navigate the repo from committed context alone. |

### Surface reference

| File | Purpose |
|------|---------|
| [`API.md`](API.md) | REST API reference (all `/api/v1/*` routes, schemas, auth). |
| [`MCP.md`](MCP.md) | MCP server reference (tool schemas, local stdio + remote HTTP modes). |
| [`CLI.md`](CLI.md) | `tasks` CLI reference (every subcommand, every flag). |
| [`SLACK.md`](SLACK.md) | Slack integration reference (manifest, scopes, slash-command surface, notifier). |

### Setup + release

| File | Purpose |
|------|---------|
| [`SETUP.md`](SETUP.md) | Local setup, environment variables, install paths. |
| [`RELEASE.md`](RELEASE.md) | Release process and pre-publish checks. |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | Operator recovery runbook: boot failures, wrong/stale DB, safe backup/restore. |

### Quality

| File | Purpose |
|------|---------|
| [`CODE_QUALITY_ROADMAP.md`](CODE_QUALITY_ROADMAP.md) | Code quality baseline and prioritized uplift roadmap. |

## See also (repo root)

- [`../AGENTS.md`](../AGENTS.md) — first-read navigation hub for any agent.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — human contributor workflow, commit/PR rules, agent-context maintenance.
- [`../SECURITY.md`](../SECURITY.md) — security policy and vulnerability reporting.
- [`../.agent-context.json`](../.agent-context.json) — machine-readable manifest of canonical files and their budgets.
