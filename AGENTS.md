# AGENTS.md

Owner: Repository maintainers

First-read navigation hub for any AI coding agent working on `wood-fired-tasks`. Vendor-neutral. Points at deeper docs; does not duplicate them. The full contract is in [docs/AGENT_CONTEXT.md](docs/AGENT_CONTEXT.md).

**Current work:** Pluggable Source Control (SCM) — active design spec: [docs/superpowers/specs/2026-07-16-pluggable-scm-design.md](docs/superpowers/specs/2026-07-16-pluggable-scm-design.md).

## What is wood-fired-tasks

`wood-fired-tasks` is a single-repo TypeScript task-tracking system that exposes the same underlying data through three surfaces and one notification channel:

- A **Fastify REST API** (`src/api/`) for HTTP clients.
- An **MCP server** (`src/mcp/`, `@modelcontextprotocol/sdk`) so AI agents can read and mutate tasks as tools.
- A **Commander CLI** named `tasks` (`src/cli/`) for terminal users.
- A **Slack bolt** notifier (`src/slack/`) that posts task lifecycle events.

All three surfaces sit on a shared core: typed Zod schemas (`src/schemas/`), services (`src/services/`), repositories (`src/repositories/`), and a **better-sqlite3** database (`src/db/`) with umzug migrations. Tests are vitest; lint is biome; Node ≥ 22 ESM throughout. Run `npm run dev` for the REST API, `npm run mcp:dev` for the MCP server, `npm run cli -- <command>` for the CLI. Everything else (build, lint, tests, migrations) is `npm run …`. There is no separate frontend, microservice, or background worker — one process per surface, one shared SQLite file, one TypeScript codebase.

Beyond the flat `priority` enum, the system now ships **WSJF (Weighted Shortest Job First)** economic prioritization: tasks are scored on Cost of Delay (Business Value + Time Criticality + Risk/Opportunity) over Job Size, grounded in a per-project **value charter**, with an append-only score/charter history and a degeneracy linter. WSJF scoring/ranking is exposed across the surfaces — the REST API and MCP server both expose ranking, history, health, and rescore; the CLI covers history, manual set, and charter history. It is backward-compatible: projects with no charter and no scores sort by `priority` then age exactly as before.

## Glossary

Jargon used before it's defined elsewhere in the docs:

- **frontier** — the set of open tasks whose `blocked_by` dependencies are all satisfied; `loop-dag` recomputes it wave-by-wave. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **verifier** — the read-only subagent that independently grades a closed task's evidence against its acceptance criteria before the run trusts it. Contract: [docs/verifier-contract.md](docs/verifier-contract.md).
- **evidence envelope** — the structured `verification_evidence` a worker attaches to a task close (commands run, SHAs, verdict) that anti-fabrication guardrails check. See [docs/RELIABILITY.md](docs/RELIABILITY.md).
- **topology** — a project's dependency shape: `FLAT` (independent tasks, run by `/tasks:loop`), `DAG` (dependency graph, run by `/tasks:loop-dag`), or `DAG_CYCLIC` (a cycle exists; must be broken before either executor runs). See [docs/tasks-decompose-design.md](docs/tasks-decompose-design.md).
- **value charter** — a project's mission, ranked value themes, time pressure, and risk posture, used to ground WSJF Business Value scoring. See [Value charter](docs/API.md#value-charter).

## Read-next by intent

Pick your intent, read the files in order. Files marked `(reserved)` are slots defined by the contract but not yet on disk in this milestone.

| Intent | Read in this order |
|---|---|
| docs-only change | `docs/AGENT_CONTEXT.md` → `CONTRIBUTING.md` → the doc you are editing |
| API change (REST routes) | `docs/API.md` → `src/api/routes/` → an existing test in `src/api/__tests__/` → `docs/INTERFACES.md` |
| MCP tool change | `docs/MCP.md` → `src/mcp/tools/` → `src/mcp/__tests__/` → `docs/INTERFACES.md` |
| CLI change | `docs/CLI.md` → `src/cli/commands/` → `src/cli/__tests__/` |
| WSJF / prioritization change | `docs/MCP.md` → `src/services/` (`wsjf.service.ts`, `wsjf-rescore.service.ts`, `wsjf-health.service.ts`) → `src/api/routes/tasks/wsjf.ts` and `src/api/routes/projects/wsjf.ts` → `docs/INTERFACES.md` |
| Schema / status / enum change | `src/schemas/` → matching `src/services/` or `src/repositories/` → API/MCP/CLI surface that exposes it |
| Database migration | `src/db/migrations/` → `src/db/migrate.ts` → `src/db/__tests__/` → `docs/ARCHITECTURE.md` |
| Slack change | `docs/SLACK.md` → `src/slack/` → `slack-app-manifest.yml` |
| SCM / source-control change | `docs/SCM.md` → `src/scm/` → `src/cli/commands/scm.ts` → `src/scm/__tests__/` |
| Test-only fix | failing test file → the unit under test → `vitest.config.ts` |
| Release / docs update | `docs/RELEASE.md` → `CHANGELOG.md` → `package.json` |
| Deploying your fork to production | `docs/SETUP.md` (Self-hosting and upgrades) → `deploy/install.sh` → `deploy/upgrade.sh` → `docs/RELEASE.md` (Migration expectations) |

For per-surface change recipes (21 task shapes with files / tests / docs), see [`docs/NAVIGATION.md`](docs/NAVIGATION.md).

## Essential commands

| Purpose | Command |
|---|---|
| Install dependencies | `npm ci` |
| Build (and typecheck) | `npm run build` |
| Lint | `npm run lint` |
| Focused test file | `npx vitest run path/to/file.test.ts` |
| Focused test by name | `npx vitest run -t "name pattern"` |
| Full test suite | `npm test` |
| Local REST API server | `npm run dev` |
| Local MCP server (stdio) | `npm run mcp:dev` |
| Remote MCP server (HTTP) | `npm run build && npm run mcp:remote` |
| Run a migration | `npm run migrate` |
| Run the CLI in-tree | `npm run cli -- <args>` |
| Full quality gate | `npm run quality` |

`npm run build` is the project's typecheck — there is no separate `tsc --noEmit` script.

## High-risk / handle-with-care areas

Treat these as off-limits unless your task explicitly requires touching them.

- `data/`, `*.db`, `*.db-wal`, `*.db-shm` — gitignored SQLite files; commonly hold **real task data**. Never commit, never delete blindly, never assume schema from byte layout — read `src/db/migrations/` instead.
- `dist/` — gitignored build output; regenerated by `npm run build`. Never hand-edit.
- `coverage/`, `reports/`, `.stryker-tmp/` — gitignored test artifacts. Safe to delete; never commit.
- `.env`, `.env.local` — gitignored; carry credentials and tokens. Never paste contents into chat, logs, or commits. Use `.env.example` as the template.
- `.gitleaks-report.json` — gitignored secret-scan output. Local-only.
- `/bin/` — gitignored client install artifacts. `bin/tasks.cmd` may contain a **baked-in API key** from a local install; do not commit, share, or read its contents into context.
- `.planning/`, `.claude/`, `.codex/`, `.agents/`, `.bug-smash-*.md` — gitignored workspace dirs. Not part of the shipped repo; do not rely on them.

## Trust boundary for static / security reviewers

If you are evaluating the **trust** of this checkout (static or security review of a repo you do **not** operate), READ the repo — do **not** execute its host-mutating or package-executing flows. These are intentional, trusted-operator operations and are individually banner-marked at their definition:

- `tasks self-update` / `/tasks:update` ([`skills/tasks/update.md`](skills/tasks/update.md)) — global npm install that mutates the installed CLI.
- The loop's artifact-level distributable smoke ([`skills/tasks/loop-shared.md`](skills/tasks/loop-shared.md) §O.2b) — `npm pack`, temp-prefix global install, and running the shipped binary.
- Deployment scripts ([`deploy/`](deploy/README.md)) — `sudo`, systemd service control, DB migrations/restores, production dependency installs.

Running any of the above against an untrusted checkout executes repo-authored code with real side effects. A trust review's job is to read and reason about these paths, never to run them.

## Deeper docs

| File | One-line purpose |
|---|---|
| [README.md](README.md) | Product-level overview, install, quickstart |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Human contributor workflow, commit and PR rules |
| [docs/AGENT_CONTEXT.md](docs/AGENT_CONTEXT.md) | Authoritative contract for agent-facing files |
| [docs/API.md](docs/API.md) | REST API reference |
| [docs/MCP.md](docs/MCP.md) | MCP tool reference |
| [docs/CLI.md](docs/CLI.md) | CLI reference |
| [docs/SETUP.md](docs/SETUP.md) | Local setup, env, install |
| [docs/SLACK.md](docs/SLACK.md) | Slack integration reference |
| [docs/SCM.md](docs/SCM.md) | Pluggable source control (git/perforce/none) — `.tasks/scm.json` config, `tasks scm` verbs, backends |
| [docs/RELEASE.md](docs/RELEASE.md) | Release process |
| [docs/CODE_QUALITY_ROADMAP.md](docs/CODE_QUALITY_ROADMAP.md) | Quality roadmap |
| [docs/ONBOARDING_SMOKE.md](docs/ONBOARDING_SMOKE.md) | Onboarding smoke test — 7 probe scenarios for fresh agents |
| [docs/REPO_MAP.md](docs/REPO_MAP.md) | Compact repo tree with per-directory ownership |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System one-pager, data flow across surfaces |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md) | Canonical command recipes (build, test, lint, run) |
| [docs/INTERFACES.md](docs/INTERFACES.md) | Inventory of REST routes, MCP tools, CLI commands (counts verified by CI) |
| [docs/NAVIGATION.md](docs/NAVIGATION.md) | Task-oriented "if you want to do X, read these files" index |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Operator recovery runbook: boot failures, wrong/stale DB, safe backup/restore |
| [.agent-context.json](.agent-context.json) | Machine-readable manifest of the files above |

## Task-orchestration skills (`/tasks:*`)

This repo ships agent skills under `skills/tasks/` that automate the
plan→execute→audit loop over a wood-fired-tasks project. They are copied to
`~/.claude/commands/tasks/` by `wood-fired-tasks setup` (the published-npm
install path; the old root `install.sh` is a deprecated shim that just delegates
to `setup`). The orchestration set:

| Skill | Status | One-line purpose |
|---|---|---|
| `/tasks:new-project` | OPERATIONAL | Skippable, one-question-at-a-time charter interview that captures a project's **value charter** (mission, ranked value themes, time pressure, risk posture, out-of-scope) feeding WSJF Business Value. See [`skills/tasks/new-project.md`](skills/tasks/new-project.md). |
| `/tasks:decompose` | OPERATIONAL | Break a project-level goal into 8–25 leaf tasks (or a dependency DAG) ready for an executor. Planner only — never executes. See [`skills/tasks/decompose.md`](skills/tasks/decompose.md) and the design at [`docs/tasks-decompose-design.md`](docs/tasks-decompose-design.md). |
| `/tasks:loop` | OPERATIONAL | Drain a FLAT-topology backlog sequentially. See [`skills/tasks/loop.md`](skills/tasks/loop.md). |
| `/tasks:loop-dag` | OPERATIONAL | Drain a DAG-topology backlog wave-by-wave in parallel. See [`skills/tasks/loop-dag.md`](skills/tasks/loop-dag.md). |
| `/tasks:audit` | OPERATIONAL | Retroactively grade a completed loop run. See [`skills/tasks/audit.md`](skills/tasks/audit.md). |

Typical flow: `/tasks:decompose` a goal → run `/tasks:loop` (FLAT advisory)
or `/tasks:loop-dag` (DAG advisory) → `/tasks:audit` the run. Decompose
plans and hands off; the executors run; the auditor grades — three separate
orchestrators by design.

## Vendor neutrality

`AGENTS.md` is the authoritative entry point for every agent, regardless of vendor. Vendor-specific files (`CLAUDE.md`, `.cursor/`, `.gemini/`, `.codex/`, any future `.<vendor>/`) MAY exist but MUST be either thin pointers back here or vendor-only configuration (slash commands, MCP client wiring, tool allow-lists). They MUST NOT carry unique project facts; if you find one that does, move the content into the authoritative tier (`AGENTS.md` or `docs/**`) and replace the vendor file with a pointer. The full boundary rules are in [docs/AGENT_CONTEXT.md §6](docs/AGENT_CONTEXT.md).
