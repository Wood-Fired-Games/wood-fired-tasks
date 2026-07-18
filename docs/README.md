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
| [`USAGE_PATTERNS.md`](USAGE_PATTERNS.md) | Operator playbook: the real plan → decompose → loop lifecycle shapes (branch/PR hygiene, context-clear rituals, the live-verified fallback). |
| [`INTERFACES.md`](INTERFACES.md) | Source-verified index of REST routes, MCP tools (27 stdio + remote), CLI commands — including the WSJF prioritization surface. |
| [`NAVIGATION.md`](NAVIGATION.md) | Task-oriented index: "if you want to do X, read these files." |
| [`ONBOARDING_SMOKE.md`](ONBOARDING_SMOKE.md) | Seven onboarding probe scenarios that prove a fresh agent can navigate the repo from committed context alone. |

### Surface reference

| File | Purpose |
|------|---------|
| [`API.md`](API.md) | REST API reference (all `/api/v1/*` routes, schemas, auth). |
| [`MCP.md`](MCP.md) | MCP server reference (tool schemas, local stdio + remote HTTP modes). |
| [`CLI.md`](CLI.md) | `tasks` CLI reference (every subcommand, every flag). |
| [`SLACK.md`](SLACK.md) | Slack integration reference (manifest, scopes, slash-command surface, notifier). |
| [`SCM.md`](SCM.md) | Pluggable source control (git/perforce/none): `tasks scm <verb>` command group, `.tasks/scm.json` config, wire contract. |

### Prioritization (WSJF)

Economic backlog ordering whose differentiators are **variance-enforced column anchoring** (batch scoring forces a usable spread out of an "everything is high" backlog) and **propagation-adjusted effective WSJF** (the dependency graph lifts the prerequisites that unblock the most downstream value). Each task is scored on Cost of Delay (Business Value + Time Criticality + Risk/Opportunity) ÷ Job Size against a per-project value charter; opt-in and backward-compatible. The surface is documented in the references above, not a standalone file.

| Surface | Where |
|---------|-------|
| MCP tools: `wsjf_ranking`, `wsjf_history`, `rescore_project`, `wsjf_health` (4 tools, full stdio↔remote parity) | [`MCP.md`](MCP.md) |
| REST endpoints under `/api/v1/tasks/:id/wsjf`, `/api/v1/tasks/:id/score-history`, `/api/v1/projects/:id/{wsjf-ranking,wsjf-health,rescore,charter-history,rescore-runs}` | [`API.md`](API.md) |
| CLI commands: `tasks wsjf-history`, `tasks wsjf-set`, `tasks charter-history` | [`CLI.md`](CLI.md) |
| Charter interview + scoring/selection skills: `/tasks:new-project`, `/tasks:decompose`, `/tasks:loop`, `/tasks:loop-dag` | [`NAVIGATION.md`](NAVIGATION.md), [`skills/tasks/`](../skills/tasks/) |

### Automation (event-driven)

| File | Purpose |
|------|---------|
| [`event-router-design.md`](event-router-design.md) | Design spec for the `wft-router` event-router daemon: SSE subscription → predicate match → handler dispatch. |
| [`automation-recipes/`](automation-recipes/) | Copy-paste automation recipes (`claude-routines.md`, `persistent-agent-sessions.md`) built on the vendor-neutral handler contract. |
| [`../packages/wft-router/README.md`](../packages/wft-router/README.md) | `wft-router` daemon reference (handlers, flags, `triggers.yaml`, deploy). Ships inside the `wood-fired-tasks` package — run via `wft-router` / `npx wft-router`. |

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
| [`BENCHMARK_POLICY.md`](BENCHMARK_POLICY.md) | Benchmark & performance-regression policy: hot paths under bench, stable `npm run test:bench` invocation, recorded baselines, and the advisory-not-blocking CI rule. |
| [`RELIABILITY.md`](RELIABILITY.md) | Loop evidence anti-fabrication guardrails: the `WFT_STRICT_EVIDENCE` server flag, the client-side SHA hook, the skill discipline rules, and an honest statement of their scope. |
| [`hooks/README.md`](hooks/README.md) | Optional client-side `PreToolUse` reference hook (`validate-sha.mjs`) that blocks evidence containing git SHAs unknown to the local repo. |

## See also (repo root)

- [`../AGENTS.md`](../AGENTS.md) — first-read navigation hub for any agent.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — human contributor workflow, commit/PR rules, agent-context maintenance.
- [`../SECURITY.md`](../SECURITY.md) — security policy and vulnerability reporting.
- [`../.agent-context.json`](../.agent-context.json) — machine-readable manifest of canonical files and their budgets.
