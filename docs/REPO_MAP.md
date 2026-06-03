# Repository Map

Owner: Repository maintainers

This map lets agents navigate the codebase with minimal tokens. Pair with
[`AGENTS.md`](../AGENTS.md) for behavior rules and
[`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md) for the authoritative context
contract. Size budget: ≤ 250 lines / ~4k tokens. Link to deeper docs rather
than duplicating them.

## Top-level layout

| Path | Purpose |
|------|---------|
| `src/` | TypeScript sources for API, MCP, CLI, Slack, DB, services. |
| `docs/` | Authoritative reference + agent-facing docs. |
| `scripts/` | Repo automation (`aggregate-mutation-reports.ts`, `build-client-package.sh`, `scripts/__tests__/`). |
| `skills/` | Task-loop skill files under `skills/tasks/`. |
| `tests/` | Cross-cutting test assets outside `src/`: `fixtures/`, `helpers/`, `smoke/` (CLI e2e/install smoke), `verifier-fixtures/`. |
| `deploy/` | Linux systemd unit, crontab, backup/restore, install notes. |
| `client-package/` | Packaged install bundle (setup/uninstall for Windows / Linux / macOS, `commands/`). |
| `.github/workflows/` | CI: `ci.yml`, `bench.yml`, `install-scripts.yml`, `mutation.yml`, `secret-scan.yml`. |
| `data/` | SQLite DB location (gitignored). |
| `dist/` | `tsc` build output (gitignored). |
| `coverage/`, `reports/`, `.stryker-tmp/` | Test / mutation artifacts (gitignored). |
| `node_modules/` | Dependencies (gitignored). |
| `.planning/`, `.claude/`, `.codex/`, `.agents/` | Agent workspaces (gitignored, not distributed). |
| Toolchain config | `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `knip.json`, `.dependency-cruiser.cjs`. |
| Installers | `install.sh`, `install.ps1`. |
| Slack manifest | `slack-app-manifest.yml`. |
| Root docs | `README.md`, `AGENTS.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE`. |
| Env / secrets | `.env.example` (template); real `.env` is gitignored. |
| Secret-scan rules | `.gitleaks.toml`. |

## `src/` subtree

### `src/api/` — Fastify HTTP API
- `server.ts` — app factory. `start.ts` — process entrypoint (`npm run dev`).
- `routes/health.ts`, `routes/events.ts` — flat route files.
- `routes/auth/`, `routes/comments/`, `routes/dependencies/`, `routes/me/`, `routes/projects/`, `routes/tasks/`, `routes/web/` — resource folders. WSJF routes live at `routes/tasks/wsjf.ts` (task component get/set + score-history) and `routes/projects/wsjf.ts` (ranking, health, rescore, charter-history, rescore-runs).
- `plugins/auth.ts` (API-key), `plugins/swagger.ts` (OpenAPI).
- `hooks/error-handler.ts` — global error hook.
- Tests: `src/api/__tests__/`. Deeper: [`docs/API.md`](API.md).

### `src/mcp/` — Model Context Protocol server
- `server.ts`, `index.ts` — stdio + transport entry points.
- `tools/` — eight files: `comment-tools.ts`, `dependency-tools.ts`, `health-tools.ts`, `project-tools.ts`, `task-tools.ts`, `topology-tools.ts`, `wait-for-unblock-tools.ts`, `wsjf-tools.ts`. `wsjf-tools.ts` registers the four WSJF tools (`wsjf_ranking`, `wsjf_history`, `rescore_project`, `wsjf_health`), bringing the stdio total to 27 (the prior six-file set registered 22; `wait-for-unblock-tools.ts` added 1 and `wsjf-tools.ts` adds 4).
- `resources/`, `remote/` (HTTP transport), `commands/` (helpers).
- Tests: `src/mcp/__tests__/`. Deeper: [`docs/MCP.md`](MCP.md).

### `src/cli/` — Commander-based CLI (`tasks`)
- `bin/tasks.ts` — entrypoint.
- `commands/` — one file per subcommand (`backup`, `claim`, `comment-add/-delete/-list`, `completed`, `completions`, `create`, `db-check`, `delete`, `dep-add/-list/-remove`, `doctor`, `health`, `list`, `project-create/-delete/-list/-show/-update`, `show`, `stats`, `subtask-create/-list`, `update`, `wsjf`). `commands/wsjf.ts` provides `wsjf-history`, `wsjf-set`, and `charter-history`.
- `api/` (REST client), `auth/`, `config/`, `output/`, `prompts/` — shared helpers.
- Tests: `src/cli/__tests__/`. Deeper: [`docs/CLI.md`](CLI.md).

### `src/slack/` — Slack integration
- `notifier.ts`, `task-formatter.ts`, `user-identity.ts` — helpers.
- `commands/tasks-command.ts` — `/tasks` slash command (large).
- `formatters/project-formatter.ts` — message formatting.
- `repositories/channel-subscription.repository.ts` — channel subscriptions.
- Tests: `src/slack/__tests__/`. Deeper: [`docs/SLACK.md`](SLACK.md).

### `src/db/` — SQLite + migrations
- `database.ts` — better-sqlite3 connection.
- `migrate.ts` — umzug runner (`npm run migrate`).
- `migrations/001-initial-schema.ts` … `015-wsjf-audit.ts` (WSJF added `013-wsjf-fields.ts`, `014-value-charter.ts`, `015-wsjf-audit.ts`).
- Tests: `src/db/__tests__/` (includes migration tests).

### `src/repositories/` — SQL access layer
- `comment.repository.ts`, `dependency.repository.ts`, `project.repository.ts`, `task.repository.ts`.
- Shared: `errors.ts`, `interfaces.ts`, `row-mapper.ts`, `types.ts`.
- Tests: `src/repositories/__tests__/`.

### `src/services/` — Business logic
- `task.service.ts`, `project.service.ts`, `comment.service.ts`, `dependency.service.ts`, `claim-release.service.ts`, `idempotency.service.ts`, `slack.service.ts`, `workflow-engine.ts`, `errors.ts`.
- WSJF: `wsjf.service.ts` (deterministic scoring gate + ranking/propagation), `wsjf-rescore.service.ts` (transactional rescore against current charter), `wsjf-health.service.ts` (non-blocking degeneracy linter).
- Tests: `src/services/__tests__/`.

### `src/schemas/` — Zod schemas
- `task.schema.ts`, `comment.schema.ts`, `dependency.schema.ts`, `idempotency.schema.ts`.

### `src/events/` — In-process event bus + SSE
- `event-bus.ts`, `sse-manager.ts`, `types.ts`.
- Tests: `src/events/__tests__/`.

### Other
- `src/config/`, `src/types/`, `src/utils/` — cross-cutting helpers.
- `src/index.ts` — library re-exports.

## Task-to-files map

"I want to change X — where do I edit and test?"

| Change type | Edit | Adjacent test | Deeper doc |
|-------------|------|---------------|------------|
| REST route | `src/api/routes/<resource>/` or `routes/<flat>.ts` | `src/api/__tests__/` | [`API.md`](API.md) |
| MCP tool | `src/mcp/tools/<resource>-tools.ts` | `src/mcp/__tests__/` | [`MCP.md`](MCP.md) |
| CLI subcommand | `src/cli/commands/<name>.ts` (+ register in `bin/tasks.ts`) | `src/cli/__tests__/` | [`CLI.md`](CLI.md) |
| Service / business logic | `src/services/<name>.service.ts` | `src/services/__tests__/` | [`API.md`](API.md) |
| Repository / SQL | `src/repositories/<entity>.repository.ts` | `src/repositories/__tests__/` | — |
| Zod schema | `src/schemas/<entity>.schema.ts` | colocated in `__tests__/` of caller | [`API.md`](API.md) |
| Database migration | New file in `src/db/migrations/NNN-<slug>.ts` | `src/db/__tests__/` | [`SETUP.md`](SETUP.md) |
| WSJF scoring / ranking / health | `src/services/wsjf.service.ts`, `wsjf-rescore.service.ts`, `wsjf-health.service.ts` (+ tools `src/mcp/tools/wsjf-tools.ts`, routes `src/api/routes/{tasks,projects}/wsjf.ts`, CLI `src/cli/commands/wsjf.ts`) | `src/services/__tests__/` | [`MCP.md`](MCP.md) / [`API.md`](API.md) |
| Slack notifier | `src/slack/notifier.ts` / `task-formatter.ts` | `src/slack/__tests__/` | [`SLACK.md`](SLACK.md) |
| Slack slash command | `src/slack/commands/tasks-command.ts` | `src/slack/__tests__/` | [`SLACK.md`](SLACK.md) |
| SSE / event bus | `src/events/event-bus.ts`, `sse-manager.ts` | `src/events/__tests__/` | [`API.md`](API.md) |
| New vitest file | `<area>/__tests__/<name>.test.ts` adjacent to source | — | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Deploy script | `deploy/` | none (manual) | `deploy/README` notes |
| Existing deep doc | `docs/<NAME>.md` | n/a | this map |
| Skill file | `skills/tasks/<name>.md` | n/a | — |
| Client-package script | `client-package/setup.{sh,bat,ps1}`, `client-package/commands/` | `scripts/__tests__/` for `build-client-package.sh` | [`SETUP.md`](SETUP.md) |
| API key auth plugin | `src/api/plugins/auth.ts` | `src/api/__tests__/` | [`API.md`](API.md) |
| OpenAPI surface | `src/api/plugins/swagger.ts` + route schemas | `src/api/__tests__/` | [`API.md`](API.md) |

## Generated / derived / not hand-edited

- `dist/` — regenerated by `npm run build`.
- `coverage/`, `reports/`, `.stryker-tmp/` — regenerated by test / mutation runs.
- `dependency-graph.dot` — produced by `npm run depcruise:graph`.
- `.gitleaks-report.json` — produced by secret-scan workflow.
- `package-lock.json` — managed by `npm`; committed but not hand-edited (use `npm install`).
- `data/*.db` — runtime SQLite state; never edit by hand, never commit.

## Deployment-specific

`deploy/` contains the Linux host bits: systemd unit, crontab, backup/restore
scripts, and install instructions for the long-running API + MCP service.
`client-package/` is the per-developer install bundle (`setup.sh`,
`setup.bat`, `setup.ps1`, `uninstall.*`, `commands/`) used by `install.sh` /
`install.ps1`. Note: `client-package/setup.{sh,bat,ps1}` write a `bin/tasks.cmd`
shim with a baked-in API key during installation — treat any change to those
scripts as security-relevant.

## Secret-sensitive

| Path | Why sensitive |
|------|---------------|
| `.env`, `.env.local` | Gitignored; carry API key, Slack tokens, DB path. |
| `client-package/setup.{sh,bat,ps1}` | Bake an API key into `bin/tasks.cmd` on install. |
| `bin/tasks.cmd` (installed, not in repo) | Contains baked API key on the developer machine. |
| `data/*.db` | May contain real task data and Slack tokens in `slack_channel_subscriptions`. |
| `.gitleaks.toml` | Secret-scan rules — review carefully before relaxing. |

## Deeper docs

| Topic | Doc |
|-------|-----|
| HTTP API surface, auth, OpenAPI | [`docs/API.md`](API.md) |
| MCP tools and resources | [`docs/MCP.md`](MCP.md) |
| CLI commands and flags | [`docs/CLI.md`](CLI.md) |
| Local setup, DB, migrations | [`docs/SETUP.md`](SETUP.md) |
| Slack app + slash command | [`docs/SLACK.md`](SLACK.md) |
| Release process | [`docs/RELEASE.md`](RELEASE.md) |
| Agent context contract | [`docs/AGENT_CONTEXT.md`](AGENT_CONTEXT.md) |
| Code-quality roadmap | [`docs/CODE_QUALITY_ROADMAP.md`](CODE_QUALITY_ROADMAP.md) |
| Contribution rules | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
