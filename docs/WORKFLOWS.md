# Workflows

Owner: Repository maintainers
Status: Authoritative command sheet. See [docs/AGENT_CONTEXT.md](AGENT_CONTEXT.md) for the contract.

## Mission

This is the canonical command sheet for `wood-fired-tasks`. Use it together
with [AGENTS.md](../AGENTS.md) (navigation hub) and
[docs/AGENT_CONTEXT.md](AGENT_CONTEXT.md) (the contract). When a recipe needs
deeper setup detail, follow the pointer to [docs/SETUP.md](SETUP.md). Every
command below is current with `package.json` and copy-pasteable from the repo
root.

## Quick start

From a fresh clone, the smallest path to a running local API with a green
test suite:

```
npm ci
cp .env.example .env   # configure DATABASE_PATH etc.; mint a PAT for API/CLI auth
npm run migrate
npm run build
npm test
npm run dev
```

`npm ci` reproduces the lockfile exactly and matches CI. Use `npm install`
only when adding or removing dependencies.

## Daily-loop recipes

| Recipe                       | Command                                  | When to use                                                                 |
| ---------------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| Full build + typecheck       | `npm run build`                          | Before committing; this IS the typecheck (there is no separate `--noEmit`). |
| Full test suite              | `npm test`                               | Before commit; after any cross-cutting change (schemas, services, DB).      |
| Focused test by file path    | `npx vitest run path/to/file.test.ts`    | Iterating on one module.                                                    |
| Focused test by name pattern | `npx vitest run -t "name pattern"`       | Iterating on one assertion or scenario.                                     |
| Single-file watch mode       | `npx vitest path/to/file.test.ts`        | TDD on one file.                                                            |
| Full watch mode              | `npm run test:watch`                     | TDD across the suite.                                                       |
| Coverage report              | `npm run test:coverage`                  | Before opening a PR that changes coverage-sensitive paths.                  |
| Bench suite                  | `npm run test:bench`                     | Perf-sensitive changes only.                                                |
| Lint                         | `npm run lint`                           | Before commit. Required by `quality`.                                       |
| Format (writes)              | `npm run format`                         | When you intentionally want Biome to rewrite files. See note below.         |
| Format check (CI-gated)      | `npm run format:check`                   | Read-only Biome format check; **gated in CI** (fails on unformatted files). Run before commit. |
| Unused-deps check            | `npm run lint:deps`                      | Before commit when `package.json` changed.                                  |
| Dep cycle / boundary check   | `npm run depcruise`                      | Before commit on cross-module refactors.                                    |
| Dep graph (DOT)              | `npm run depcruise:graph`                | Visualising module structure; produces `dependency-graph.dot`.              |
| Mutation tests               | `npm run test:mutation`                  | Periodic quality run. Slow; not a per-commit gate.                          |
| Real-p4d SCM suite           | `WFG_TESTS_REAL_P4=1 npx vitest run src/scm/__tests__/perforce-real-p4d.test.ts` | Validating the perforce backend against a real dockerized `p4d`; needs `docker` + `p4` on `PATH`. Silently skipped otherwise. See [docs/SCM.md § WFG_TESTS_REAL_P4](SCM.md#wfg_tests_real_p4-real-p4d-suite). |
| Manifest check               | `npm run agent-context:check`            | After editing any agent-facing doc or the manifest source.                  |
| Onboarding smoke (scripted)  | `npx vitest run scripts/agent-context/__tests__/onboarding-smoke.test.ts` | After editing any agent-facing doc; see [docs/ONBOARDING_SMOKE.md](ONBOARDING_SMOKE.md). |
| Manifest regenerate          | `npm run agent-context:gen`              | After flipping a manifest entry from `reserved` to `present`.               |
| Full local quality gate      | `npm run quality`                        | Before opening a PR — mirrors the CI matrix.                                |

### `format` vs `format:check`

`npm run format` runs `biome format --write .` and **rewrites** files in
place — use it when you intentionally want Biome to reformat. `npm run
format:check` runs `biome format .` read-only and **fails on unformatted
files**; it is gated in CI (`.github/workflows/ci.yml` — the "Format check"
step) alongside `lint`, so run it (or `format`) before committing. The Biome
formatter is enabled (`biome.json` `formatter.enabled = true`).

## Surface dev recipes

### Local API server

- Start: `npm run dev` (tsx, no build needed).
- Default endpoint: `http://127.0.0.1:3000` (controlled by `HOST` + `PORT`).
- Authenticated `/api/v1` requests must send a Bearer PAT
  (`Authorization: Bearer wft_pat_…`). Mint one with `tasks db mint-token`.
- For a production-like local run after `npm run build`: `npm run start`.

### Local MCP server (stdio)

- Start: `npm run mcp:dev`.
- Communicates over stdio — wire it into your MCP client as a child process
  invoking this command from the repo root.
- Reads the same `.env` (`DATABASE_PATH`, etc.) as the API.

### Remote MCP server

- Start: `npm run build && npm run mcp:remote`.
- Required env: `WFT_API_URL` (e.g. `https://your-server.example/`) and
  `WFT_API_KEY` (a PAT, `wft_pat_…`, sent as `Authorization: Bearer <pat>`).
  The server fails fast if either is missing.
- This points at a running API. Confirm which API instance you are targeting
  before running — see the network/secrets flags below.

### CLI usage

- In-tree: `npm run cli -- <subcommand>` (uses `tsx`, no build needed).
- After global install: `tasks <subcommand>` (uses the published `bin`).
- Required env: `API_KEY` (a PAT, `wft_pat_…`, sent as `Authorization: Bearer`;
  unless you have run `tasks login`). Optional: `API_BASE_URL` (defaults to
  `http://localhost:3000`).
- Full reference: [docs/CLI.md](CLI.md).

## Database recipes

- Migrate: `npm run migrate` runs all pending migrations against
  `DATABASE_PATH`. Idempotent — safe to re-run.
- Backup (production): `bash deploy/backup-sqlite.sh`. Uses `WFT_INSTALL_DIR`
  (default `/opt/wood-fired-tasks`). Run this before any destructive op.
- Restore (production): `bash deploy/restore-sqlite.sh <backup-file>`.
  Destructive — replaces the running DB in place. Requires explicit user
  approval.

## Quality gates and packaging

- `npm run quality` — full local gate: `build` → `test` → `lint` →
  `lint:deps` → `depcruise` → `npm audit --omit=dev --audit-level=high`.
  Mirrors the CI matrix. Run before opening any code PR.
- `npm run pack:check` — `npm pack --dry-run`; surface what would ship.
- `npm run prepublishOnly` — pre-publish gate. Runs on `npm publish`.

## Focused tests vs full suite

- Prefer focused (`npx vitest run path/...` or `-t "pattern"`) during
  code-shaping iteration — fast feedback, minimal noise.
- Run the full suite (`npm test`) before commit and after any cross-cutting
  change (schemas, services, migrations, shared utilities).
- Always run `npm run quality` before opening a PR that touches code. It is
  the local mirror of the CI gate.

## Environment variables

Names must be exact: `API_KEY` (CLI) and `WFT_API_KEY` (remote MCP) each hold a
PAT (`wft_pat_…`) sent as `Authorization: Bearer <pat>`. `API_KEYS` (plural) is
**not** an auth requirement in v2.0 — see its row below. Slack tokens must be set
as a group (bot + app + signing) or not at all.

### Local development (`.env`)

| Variable                   | Required?   | Notes                                                          |
| -------------------------- | ----------- | -------------------------------------------------------------- |
| `NODE_ENV=development`     | recommended | Default.                                                        |
| `PORT=3000`                | optional    | API listen port.                                               |
| `HOST=127.0.0.1`           | optional    | Loopback. Only set to `0.0.0.0` for deliberate LAN exposure.   |
| `LOG_LEVEL=info`           | optional    | `trace`/`debug`/`info`/`warn`/`error`.                         |
| `API_KEYS`                 | optional (legacy) | **Not an auth method, not required, not in the Zod schema.** If set, only seeds inert legacy `users` rows (`is_legacy=1`). |
| `DATABASE_PATH`            | optional    | Defaults to the OS app-data DB; if unset and a legacy `./data/tasks.db` exists (and the app-data DB does not), it is auto-adopted with a one-time warning. `DB_PATH` is a deprecated alias — prefer `DATABASE_PATH`. |
| `API_BASE_URL=http://localhost:3000` | optional | CLI target.                                              |
| `API_KEY`                  | REQUIRED for CLI | A PAT (`wft_pat_…`) sent as `Authorization: Bearer` (unless you ran `tasks login`). |
| `SLACK_BOT_TOKEN`          | group       | Set with the rest of the Slack triplet or not at all.          |
| `SLACK_APP_TOKEN`          | group       | Set with the rest of the Slack triplet or not at all.          |
| `SLACK_SIGNING_SECRET`     | group       | Set with the rest of the Slack triplet or not at all.          |

### Production / remote

| Variable                   | Required? | Notes                                                              |
| -------------------------- | --------- | ------------------------------------------------------------------ |
| `NODE_ENV=production`      | REQUIRED  | Enables production hardening.                                      |
| `HOST=0.0.0.0`             | typical   | Behind firewall / reverse proxy.                                   |
| `API_KEYS`                 | optional (legacy) | **Not an auth method, not required, not in the Zod schema.** If set, only seeds inert legacy `users` rows. Issue PATs (`tasks db mint-token`) for real auth. |
| `DATABASE_PATH=/opt/wood-fired-tasks/data/tasks.db` | typical | Matches the installer default.                  |
| `WFT_INSTALL_DIR`          | optional  | Installer root. Default `/opt/wood-fired-tasks`.                    |
| `WFT_SERVICE_USER`         | optional  | Installer service user. See `deploy/README.md`.                    |
| `WFT_API_URL`              | REQUIRED (remote MCP) | URL of the running API.                                |
| `WFT_API_KEY`              | REQUIRED (remote MCP) | A PAT (`wft_pat_…`) sent as `Authorization: Bearer <pat>`. |
| `WFT_STRICT_EVIDENCE`      | optional  | `true` opts into the anti-fabrication evidence gate (default off). Recommended for `/tasks:loop[-dag]` hosts. See [docs/RELIABILITY.md](RELIABILITY.md). |

## Network / secrets / running-API / writable-DB / approval flags

- `npm test` — writes temp SQLite files in `data/` or test-scoped paths.
  Harmless locally; do not run against a production `DATABASE_PATH`.
- `npm run dev` / `npm run start` — opens a port (default 3000), authenticates
  requests with Bearer PATs, serves real data from `DATABASE_PATH`. Do not
  expose without intent.
- `npm run mcp:dev` — reads `DATABASE_PATH`; no network egress.
- `npm run mcp:remote` — network egress to `WFT_API_URL`. Requires explicit
  user approval before running against any non-local URL.
- `npm run migrate` — writes to `DATABASE_PATH`. Always back up first in
  production.
- `deploy/backup-sqlite.sh` — reads `DATABASE_PATH` and `WFT_INSTALL_DIR`;
  writes a backup file under the install root.
- `deploy/restore-sqlite.sh` — destructive: replaces the running DB.
  Explicit user approval.
- `npm publish` (via `prepublishOnly`) — publishes a public artefact.
  Explicit user approval; the gate is intentionally heavy.
- Slack scripts — require the Slack triplet; never echo tokens to the
  terminal.

## Docs verification

- `npm run agent-context:check` validates `.agent-context.json` against the
  manifest source, including line budgets and `Owner:` lines. Run after
  editing any agent-facing doc.
- There is no markdown linter today — do not waste time looking for one.

## Pointers to deeper docs

- Local setup, env, install: [docs/SETUP.md](SETUP.md)
- Release process and pre-publish gate: [docs/RELEASE.md](RELEASE.md)
- Slack surface: [docs/SLACK.md](SLACK.md)
- CLI reference: [docs/CLI.md](CLI.md)
- REST API reference: [docs/API.md](API.md)
- MCP tool reference: [docs/MCP.md](MCP.md)
- Loop evidence anti-fabrication guardrails: [docs/RELIABILITY.md](RELIABILITY.md)
