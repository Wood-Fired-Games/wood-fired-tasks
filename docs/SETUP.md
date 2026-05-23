# Setup Guide

Complete setup instructions for Wood Fired Bugs in development, production, and Claude Code environments.

## Prerequisites

- **Node.js 22 or higher** — matches the CI matrix (`actions/setup-node` with
  `node-version: '22'`) and is enforced by the `engines` field in
  `package.json`.
- **npm** — comes with Node.js.
- **jq** — required by `install.sh` to merge the MCP server entry into
  `~/.claude.json` safely (raw heredocs would mis-quote the API key on
  embedded `"`/`\`/newline). Install with:
  - Debian/Ubuntu: `sudo apt-get install jq`
  - RHEL/CentOS: `sudo yum install jq`
  - Fedora: `sudo dnf install jq`
  - macOS: `brew install jq`
- **curl** — required by `install.sh` to validate that the API server is
  reachable at the configured URL (post-install connectivity check). Almost
  always preinstalled; install with the same package managers if missing.

The Windows installer (`install.ps1`) uses native PowerShell JSON handling
and `Invoke-WebRequest` instead, so it does not require `jq` or `curl`.

## Secrets

[CRITICAL] Treat every value in `.env` as a production-grade secret. The
file holds `API_KEYS`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and
`SLACK_SIGNING_SECRET` — anything leaked here grants full access to your
task data and Slack workspace.

**Rules:**

1. **Create `.env` fresh after every `git clone`.** Copy `.env.example`
   and fill in real values locally:

   ```bash
   cp .env.example .env
   # then edit .env with your real tokens
   ```

2. **`.env` is gitignored — never commit it.** The repo's `.gitignore`
   already excludes it; do not override that. Run `git status` before
   every commit and confirm `.env` is not staged.

3. **Never paste secrets into the repository.** Not in `.env.example`,
   not in code comments, not in test fixtures, not in commit messages,
   not in issue descriptions. If a secret lands in tracked content,
   rotate it immediately at the issuer (Slack admin console, API key
   generator, etc.) and scrub the working tree.

4. **Rotation requires a server restart.** Both the API server and the
   Slack subprocess read `.env` on boot only. After changing any value,
   restart with `npm run dev` (development) or your process manager
   (`pm2 restart wood-fired-bugs`, `systemctl restart …`) so the new
   value takes effect.

5. **Use a secret manager in production.** A flat `.env` file is fine
   for local development, but production deployments should source
   secrets from a dedicated manager such as:

   - [1Password CLI](https://developer.1password.com/docs/cli/) — `op run -- npm start`
   - [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/) — fetched at boot or via sidecar
   - [HashiCorp Vault](https://www.vaultproject.io/) — `vault agent` template rendering
   - [Doppler](https://www.doppler.com/) / [Infisical](https://infisical.com/) — drop-in `.env` replacements

   Inject the resolved values as environment variables on the process;
   do not write them to disk on the production host.

6. **Compromised tokens are assumed compromised forever.** If a token
   was ever in cleartext on a workstation that is not under your sole
   physical control (shared dev VM, CI runner, lost laptop), rotate it.
   Do not try to "remember which value was where" — rotate first, audit
   later.

## OIDC (Google) Configuration

OIDC (OpenID Connect) is the **recommended** auth path as of v1.6. It
replaces the legacy `X-API-Key` model with per-user identity, browser SSO
via Google, and PATs (Personal Access Tokens) minted from a logged-in
session. The legacy `X-API-Key` path keeps working through the v1.7 sunset
date — see [`SECURITY.md`](../SECURITY.md) → **Legacy Auth Sunset
Timeline**.

OIDC is fully **optional**. Leaving all four `OIDC_*` env vars unset keeps
the server in legacy mode; PAT minting + the web login UI are gated on the
same env vars, so they simply do not register.

### 1. Create the Google OAuth client

1. Visit the [Google Cloud Console](https://console.cloud.google.com/) and
   pick (or create) the project that will own the OAuth client.
2. **APIs & Services → Credentials → Create Credentials → OAuth client
   ID**.
3. Application type: **Web application**.
4. Authorised JavaScript origins: the public origin of your server,
   e.g. `http://localhost:3000` for local dev or
   `https://bugs.example.com` for production.
5. Authorised redirect URIs: append `/auth/callback` to each origin,
   e.g. `http://localhost:3000/auth/callback`.
6. **Create** — copy the generated Client ID and Client Secret. The
   secret is shown only once.

### 2. Set the OIDC env vars

Add the following to your `.env` (or your secret manager). All four
`OIDC_*` vars are validated as a group — set all of them or none.

```bash
# Identity provider issuer URL. For Google this is fixed.
OIDC_ISSUER_URL=https://accounts.google.com

# From the Google Cloud Console step above.
OIDC_CLIENT_ID=your-client-id.apps.googleusercontent.com
OIDC_CLIENT_SECRET=your-client-secret

# Must exactly match an entry on the "Authorised redirect URIs" list.
OIDC_REDIRECT_URI=http://localhost:3000/auth/callback

# Optional — defaults to "openid email profile". The server requires at
# minimum "openid email" to map the OIDC subject to a local user row.
OIDC_SCOPES=openid email profile
```

### 3. Generate the session cookie secret

Required whenever OIDC is enabled. The cookie is a sodium sealed-box,
keyed on a 32-byte secret. Generate with:

```bash
openssl rand -base64 32
```

Then set:

```bash
# Must decode to exactly 32 bytes; the server refuses to boot otherwise.
SESSION_COOKIE_SECRET=<output of openssl rand -base64 32>

# Optional — the cookie name. Defaults to wfb_session.
SESSION_COOKIE_NAME=wfb_session
```

[CRITICAL] Treat `SESSION_COOKIE_SECRET` as a production-grade secret.
Rotating it invalidates every active session immediately — every user
must log in again.

### 4. (Optional) Set the legacy sunset date

The server stamps `Deprecation: true` + `Sunset: <date>` headers on every
REST request that authenticated via the legacy `X-API-Key` path. The
default sunset date is `2026-12-31` (six months after v1.6 ship). Override
with:

```bash
# Must be a valid calendar date in YYYY-MM-DD form.
LEGACY_AUTH_SUNSET_DATE=2026-12-31
```

### 5. Verify the OIDC flow

1. Restart the server (`npm run dev` locally).
2. In a browser, visit `http://localhost:3000/auth/login`.
3. You should be redirected to Google, complete consent, and land on
   `/me`. The `/me` page shows your email, display name, and a list of
   your PATs.
4. From `/me` you can mint a new PAT (the value is shown **once**, copy
   it then) or revoke an existing one.

### 6. Bootstrap a PAT without a browser (servers, CI, headless agents)

For deployments where no browser is available, mint the first PAT
directly against the SQLite database:

```bash
# Adds a row to personal_access_tokens for the named user.
node dist/cli/bin/tasks.js db mint-token --user-email you@example.com
```

The command prints the raw PAT to stdout once. Use it as the
`Authorization: Bearer wfb_pat_<…>` value on subsequent requests, or as
the `WFB_API_KEY` env var in MCP and CLI clients (the REST client switches
to `Authorization: Bearer …` automatically when the value starts with
`wfb_pat_`). See [`SECURITY.md`](../SECURITY.md) →
**Authentication Architecture** for the full chain.

### 7. Migrating from an `API_KEYS`-only deployment

Historical task / comment rows that pre-date v1.6 have NULL identity FKs
(`tasks.created_by_user_id`, `tasks.assignee_user_id`,
`task_comments.author_user_id`) because the legacy TEXT columns were the
only identity record at the time. Backfill the FKs from the TEXT columns
with:

```bash
# Dry-run — prints a per-mapping summary, no writes.
node dist/cli/bin/tasks.js db migrate-identities

# Apply. Idempotent: safe to re-run.
node dist/cli/bin/tasks.js db migrate-identities --commit
```

Unmatched TEXT values default to the lowest-id `is_legacy=1` user.
Override per-string with `--alias-map <file>`; pass
`--user-fallback skip` to leave the FK NULL when no mapping is found.
The CLI is detailed in [`CLI.md`](CLI.md).

[NOTE] Re-running `migrate-identities --commit` is a no-op once every
matchable row has been backfilled — the UPDATE is guarded by
`AND <fk_col> IS NULL`.

## Development Setup

### 1. Clone and Install

```bash
git clone https://github.com/Wood-Fired-Games/wood-fired-bugs.git
cd wood-fired-bugs
npm install
```

### 2. Create Environment File

Create a `.env` file in the project root:

```bash
# API Server Configuration
PORT=3000
# HOST defaults to 127.0.0.1 (loopback only). Uncomment the next line to
# expose the server on the LAN — required only when you actually want
# other machines on your network to reach it.
# HOST=0.0.0.0
LOG_LEVEL=debug
NODE_ENV=development

# Authentication
API_KEYS=dev-key-1,dev-key-2

# Database
DATABASE_PATH=./data/tasks.db

# CLI Configuration (for testing CLI commands)
API_BASE_URL=http://localhost:3000
API_KEY=dev-key-1
```

[IMPORTANT] The `API_KEYS` variable is required for authentication. Set it to one or more comma-separated keys. These keys will be required in the `X-API-Key` header for all API requests.

[NOTE] `DATABASE_PATH` is the canonical name validated by `src/config/env.ts`
and used by the CLI commands. The MCP server also accepts the legacy
`DB_PATH` as an alias for backward compatibility with older
`~/.claude.json` installs, but new configurations should use `DATABASE_PATH`.
See the [Environment Variables](#environment-variables) section below for the
full list.

### 3. Build the Project

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

### 4. Run Database Migrations

```bash
npm run migrate
```

This creates the SQLite database at `DATABASE_PATH` and runs all migrations to set up the schema.

### 5. Start Development Server

```bash
npm run dev
```

The API server will start with hot reload enabled. Any changes to TypeScript files will automatically restart the server.

[TIP] The development server uses `pino-pretty` for colored, human-readable logs.

## Production Deployment

### 1. Install and Build

```bash
npm install --production
npm run build
```

### 2. Set Production Environment Variables

```bash
export NODE_ENV=production
export PORT=3000
# HOST defaults to 127.0.0.1 (loopback only). Set to 0.0.0.0 to listen on
# all interfaces, or to a specific LAN IP to bind only to that NIC. Do
# this only when the server is intended to be reachable from other hosts;
# in containerised or reverse-proxied deployments, prefer a specific
# interface or rely on the container network instead of 0.0.0.0.
export HOST=0.0.0.0
export LOG_LEVEL=warn
export API_KEYS=your-production-key-here
export DATABASE_PATH=/var/lib/wood-fired-bugs/tasks.db
```

[IMPORTANT] Use strong, unique API keys in production. These keys provide full access to your task data.

[SECURITY] The server binds to `127.0.0.1` (loopback) by default. New deployments
must opt in to LAN exposure by setting `HOST=0.0.0.0` (or a specific LAN IP).
On boot the bound interface is logged at info level so the binding is
visible to operators.

### 3. Run Migrations

```bash
npm run migrate
```

### 4. Start the Server

```bash
npm start
```

This runs the compiled JavaScript from `dist/api/start.js`.

[TIP] Use a process manager like PM2 or systemd to keep the server running and restart on failure.

Example with PM2:

```bash
pm2 start npm --name "wood-fired-bugs" -- start
pm2 save
pm2 startup
```

## CLI Installation

The CLI can be used in two ways: globally via `npm link` or directly via `npx tsx`.

### Global Installation (Recommended)

From the project directory:

```bash
npm link
```

This creates a global `tasks` command that can be run from anywhere.

### Environment Variables for CLI

The CLI needs to know where to find the API server and how to authenticate:

```bash
export API_BASE_URL=http://localhost:3000
export API_KEY=your-api-key-here
```

[TIP] Add these to your `.bashrc` or `.zshrc` for persistent configuration.

### Direct Usage (Development)

For development, you can run CLI commands directly without building or linking:

```bash
npx tsx src/cli/bin/tasks.ts <command>
```

Or use the npm script:

```bash
npm run cli -- <command>
```

## Claude Code Integration

Wood Fired Bugs includes installers for seamless Claude Code integration on Linux/macOS and Windows.

### Install modes

The installer supports two modes:

| Mode | Server name written to `~/.claude.json` | What it does | API key |
|------|-----------------------------------------|--------------|---------|
| `local` (default) | `wood-fired-bugs` | Spawns the stdio MCP server (`dist/mcp/index.js`) that opens the SQLite database in-process. | **Not used.** Local MCP only needs `DATABASE_PATH`; no key is collected, persisted, or written. |
| `remote` | `wood-fired-bugs-remote` | Spawns the stdio bridge (`dist/mcp/remote/index.js`) that proxies every tool call to a deployed REST API. | Required. Written as `WFB_API_KEY` in the MCP entry's `env`. |

Both modes write independent entries, so it is safe to run the installer in
local mode and later add a remote entry with `--mode remote` — they coexist
under different server names in `~/.claude.json`.

### Linux and macOS

```bash
# Local mode (default) — no key prompt, no key in ~/.claude.json:
./install.sh

# Remote mode — resolves WFB_API_KEY from env, secret file, or prompt:
WOOD_FIRED_BUGS_API_KEY="your-key-here" ./install.sh --mode remote
```

In `--mode remote`, the installer resolves the API key in this order:
`WOOD_FIRED_BUGS_API_KEY` env var → `~/.config/wood-fired-bugs/api-key`
(mode 600) → masked interactive prompt → `--api-key` argv flag (deprecated).
The key is then cached at `~/.config/wood-fired-bugs/api-key` (mode 600)
and written into the `wood-fired-bugs-remote` MCP entry's `env` as
`WFB_API_KEY`. `~/.claude.json` (and any timestamped backup) is also
chmod'd to 0600.

In `--mode local`, none of those paths execute — even if
`WOOD_FIRED_BUGS_API_KEY` is exported in your shell, the installer silently
ignores it.

### Windows

```powershell
# Local mode (default):
.\install.ps1

# Remote mode:
$env:WOOD_FIRED_BUGS_API_KEY = "your-key-here"
.\install.ps1 -Mode remote
```

Resolution order in `-Mode remote` is `-ApiKey` (deprecated) →
`WOOD_FIRED_BUGS_API_KEY` env var → `%LOCALAPPDATA%\wood-fired-bugs\api-key`
(user-only ACL) → masked prompt. The installer tightens the ACL on
`~/.claude.json` (and any timestamped backup) to the current user only via
`icacls`. `-Mode local` collects no key.

### What the Installer Does

1. **Copies skill files** to `~/.claude/commands/tasks/` (10 skill files)
2. **Updates MCP server configuration** in `~/.claude.json`:
   - Local: adds/updates the `wood-fired-bugs` entry pointing at `dist/mcp/index.js`
   - Remote: adds/updates the `wood-fired-bugs-remote` entry pointing at `dist/mcp/remote/index.js`
3. **Configures environment** — `DATABASE_PATH` for local, `WFB_API_URL` + `WFB_API_KEY` for remote

### Resulting MCP Configuration

**Local mode (default)** — no API key is written:

```json
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["dist/mcp/index.js"],
      "cwd": "/path/to/wood-fired-bugs",
      "env": {
        "DATABASE_PATH": "./data/tasks.db"
      }
    }
  }
}
```

**Remote mode** — separate server name, holds the API key:

```json
{
  "mcpServers": {
    "wood-fired-bugs-remote": {
      "command": "node",
      "args": ["dist/mcp/remote/index.js"],
      "cwd": "/path/to/wood-fired-bugs",
      "env": {
        "WFB_API_URL": "http://localhost:3000",
        "WFB_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

[NOTE] Older installs may have `DB_PATH` instead of `DATABASE_PATH`. The MCP
server still accepts that as a deprecated alias, but re-running the installer
or hand-editing to `DATABASE_PATH` is recommended for consistency with
`src/config/env.ts`.

[NOTE] The local MCP server runs as a separate process via stdio. It creates
its own database connection and does NOT call the REST API.

#### Migration: removing an unused API key from older local installs (task #258)

Versions of the installer before task #258 wrote `WOOD_FIRED_BUGS_API_KEY`
into the `wood-fired-bugs` MCP entry even though the **local** MCP server
never reads it (it only consumes `DATABASE_PATH`). The key sat there as
dead weight and as a needless leak surface.

If you previously ran `./install.sh` or `.\install.ps1` and your
`~/.claude.json` looks like this under `mcpServers."wood-fired-bugs".env`:

```json
{
  "WOOD_FIRED_BUGS_API_KEY": "...",
  "DATABASE_PATH": "./data/tasks.db"
}
```

…you can safely **delete the `WOOD_FIRED_BUGS_API_KEY` line** by hand. The
local MCP server will keep working with only `DATABASE_PATH`. Re-running
`./install.sh` (default `--mode local`) also rewrites the entry without the
key. If you also want the remote bridge, run `./install.sh --mode remote`
to add a separate `wood-fired-bugs-remote` entry that carries
`WFB_API_KEY` — that's where the key belongs.

### Skill Files

After installation, you can use these slash commands in Claude Code:

| Skill | Command | Description |
|-------|---------|-------------|
| Create Task | /tasks:create-task | Create a new task with project, priority, and assignee |
| Show Task | /tasks:show-task | Show full task details with comments and dependencies |
| My Work | /tasks:my-work | List tasks assigned to current user grouped by status |
| Project Status | /tasks:project-status | Show project overview with task counts and completion |
| Search | /tasks:search | Search tasks by keyword across titles and descriptions |
| Log Bug | /tasks:log-bug | Create a high-priority bug report task |
| Done | /tasks:done | Mark a task as complete |
| Blocked | /tasks:blocked | Mark a task as blocked and record reason |
| Pick Up | /tasks:pick-up | Assign task to current user and set to in_progress |
| Add Comment | /tasks:add-comment | Add a comment to a task |

All skills use the MCP tools under the hood for data access.

## Database

### Technology

- **Driver:** better-sqlite3 (synchronous SQLite library for Node.js)
- **Mode:** WAL (Write-Ahead Logging) for better concurrency
- **Migrations:** Umzug for automatic schema versioning

### Database Path

Set via `DATABASE_PATH` environment variable. Defaults to `./data/tasks.db`.
The MCP server also accepts the legacy `DB_PATH` as a deprecated alias for
backward compatibility with older `~/.claude.json` installs.

### Migrations

Seven migration files in `src/db/migrations/`:

1. `001-initial-schema.ts` — Creates `projects`, `tasks`, `task_tags`, `dependencies`, `comments` tables.
2. `002-task-hierarchy-and-dependencies.ts` — Task hierarchy (`parent_task_id`) and dependency tracking.
3. `003-comments-and-estimates.ts` — Comments and `estimated_minutes` field.
4. `004-claim-protocol.ts` — Optimistic-lock `version` field, `claimed_at` column, `idempotency_keys` table.
5. `005-backlogged-status.ts` — Adds `backlogged` to the task status CHECK constraint (rebuilds `tasks` table; preserves FTS triggers).
6. `006-slack-channel-subscriptions.ts` — New `slack_channel_subscriptions` table for the Slack notifier (channel × project × event_type).
7. `007-completed-at.ts` — Adds `completed_at` timestamp populated on transition into `done` (backfilled from `updated_at` for existing done rows).

### Task statuses

Valid statuses (post-005): `open`, `in_progress`, `done`, `closed`, `blocked`, `backlogged`.

`backlogged` is a non-terminal "deferred but not abandoned" state distinct from
`closed` (won't-do / archive). `completed_at` is populated only when a task
enters `done`; it is intentionally not set for `closed`.

Migrations run automatically on server start. To run manually:

```bash
npm run migrate
```

[TIP] Migrations are idempotent and safe to run multiple times.

### Database Access

Each interface creates its own database connection:

- **API Server:** Connection created in `src/index.ts`, shared across all routes
- **CLI:** Connection created per command execution
- **MCP Server:** Connection created on server start, shared across all tool calls

All connections use the same schema and WAL mode.

## Testing

### Run Tests

```bash
npm test
```

Runs the full test suite with Vitest (1084 tests across 87 files).

### Watch Mode

```bash
npm run test:watch
```

Runs tests in watch mode for active development.

### Test Coverage

Tests include:

- Service layer unit tests (TaskService, ProjectService, DependencyService, CommentService)
- API route integration tests (all 20 authenticated endpoints + health)
- MCP tool tests (all 21 tools)
- CLI command tests
- Event system tests (EventBus, SSEManager, events API)
- Claim protocol tests (including 20-agent concurrency)
- Workflow engine tests (auto-complete, auto-unblock, cascade depth)
- Skill file validation tests
- E2E regression tests

[TIP] Tests use in-memory SQLite databases for fast execution and isolation.

## Swagger UI

Interactive API documentation is available at:

```
http://localhost:3000/documentation
```

[NOTE] Swagger UI is available in both development and production. Use it to explore endpoints, view schemas, and test API calls with authentication.

The Swagger UI includes:

- All endpoint schemas with request/response examples
- Interactive "Try it out" functionality
- Authentication support (X-API-Key header)
- Full schema definitions from Zod validators

## Environment Variables

The canonical schema lives in [`src/config/env.ts`](../src/config/env.ts) and
is enforced with Zod at server startup. Misconfiguration causes the server to
fail fast with sysexits `EX_CONFIG` (78). The table below documents every
variable the server reads, plus the CLI- and MCP-specific variables.

### Server (read by `src/config/env.ts`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEYS` | **yes** | — | Comma-separated API keys. Format: bare (`abc123`) or labelled (`abc123:alice-laptop`). Every valid key has full admin power; issue one per machine/agent. See the README "Security Model" section. |
| `NODE_ENV` | no | `development` | One of `development`, `production`, `test`. Switches log formatting (pino-pretty in dev) and Swagger gating in production. |
| `PORT` | no | `3000` | HTTP server port. |
| `HOST` | no | `127.0.0.1` | Bind interface. Loopback-only by default (task #188). Set `0.0.0.0` or a LAN IP to expose. The bound interface is logged at info level on boot. |
| `LOG_LEVEL` | no | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `DATABASE_PATH` | no | `./data/tasks.db` | Filesystem path to the SQLite database. The MCP server also accepts the legacy `DB_PATH` as a deprecated alias. |
| `CONNECTION_TIMEOUT` | no | `120000` (ms) | Fastify `connectionTimeout`. |
| `REQUEST_TIMEOUT` | no | `60000` (ms) | Fastify `requestTimeout`. |
| `KEEP_ALIVE_TIMEOUT` | no | `10000` (ms) | Fastify `keepAliveTimeout`. |
| `WAL_CHECKPOINT_INTERVAL_MS` | no | `900000` (15 min) | Interval for the periodic SQLite WAL checkpoint job. |
| `ENABLE_SWAGGER_IN_PRODUCTION` | no | `false` | Opt-in flag to expose `/documentation` and `/documentation/json` when `NODE_ENV=production`. Gated by the auth plugin when enabled (task #185). |
| `SSE_MAX_CONNECTIONS_PER_KEY` | no | `4` | Per-API-key cap on concurrent SSE connections. 429 with `Retry-After` when exceeded. |
| `SSE_MAX_CONNECTIONS_PER_IP` | no | `8` | Per-IP cap on concurrent SSE connections. |
| `SSE_MAX_CONNECTIONS` | no | `200` | Global cap on concurrent SSE connections. |
| `SLACK_BOT_TOKEN` | conditional | — | Slack bot token (`xoxb-…`). Required if any Slack var is set; refused alone (see [`docs/SLACK.md`](SLACK.md)). |
| `SLACK_APP_TOKEN` | conditional | — | Slack app-level token (`xapp-…`) for Socket Mode. Must be set together with `SLACK_BOT_TOKEN` or neither. |
| `SLACK_SIGNING_SECRET` | conditional | — | Slack request signing secret. Required when running Slack in HTTP mode; harmless in Socket Mode. |

### Rate limiting (read directly in `src/api/server.ts`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RATE_LIMIT_MAX` | no | `1000` | Maximum requests per window (global, via `@fastify/rate-limit`). `/health` is allow-listed. |
| `RATE_LIMIT_TIME_WINDOW` | no | `1 minute` | Window string accepted by `@fastify/rate-limit`. |

### CLI (read by `src/cli/config/env.ts` and individual commands)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_BASE_URL` | no | `http://localhost:3000` | Base URL for the REST API the CLI talks to. |
| `API_KEY` | yes | — | Single API key sent in the `X-API-Key` header. Must match one of the entries in the server's `API_KEYS`. |
| `DATABASE_PATH` | no | `./data/tasks.db` | Used by the offline CLI commands (`backup`, `doctor`, `stats`, `db-check`, `completed`) that open the SQLite database directly. |
| `NO_COLOR` | no | unset | When set (any value), suppresses ANSI colors in CLI output. |

### MCP server (read by `src/mcp/index.ts` and `src/mcp/server.ts`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_PATH` | no | `./data/tasks.db` | Path to the SQLite database opened on stdio startup. Canonical name. |
| `DB_PATH` | no | — | **Deprecated alias** for `DATABASE_PATH`. Read only when `DATABASE_PATH` is unset. Kept for backward compatibility with older `~/.claude.json` installs produced by pre-task-#217 versions of `install.sh` / `install.ps1`. |
| `API_URL` | no | `http://localhost:3000/api/v1` | Only used by the optional remote MCP transport (`src/mcp/server.ts`). |
| `WOOD_FIRED_BUGS_API_KEY` | no | — | Read by the installer in `--mode remote` to populate the `WFB_API_KEY` env on the `wood-fired-bugs-remote` MCP entry. Ignored by `--mode local` (task #258) and never read by the local MCP server itself. |

### Installer (read by `install.sh` and `install.ps1` only)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WOOD_FIRED_BUGS_API_KEY` | no | — | API key consumed by the installer **only in `--mode remote`**. Resolution order: env var > on-disk secret file > masked prompt > deprecated `--api-key` flag. Silently ignored in local mode (default) since the local MCP server does not use a key. |
| `WOOD_FIRED_BUGS_URL` | no | `http://localhost:3000` | Health-check URL the installer pings after writing `~/.claude.json`. |
| `XDG_CONFIG_HOME` | no | `$HOME/.config` | Standard XDG variable; the installer caches the API key under `$XDG_CONFIG_HOME/wood-fired-bugs/api-key` (mode 600). |

[TIP] In production, source these from a secret manager (1Password CLI, AWS
Secrets Manager, Vault, Doppler, Infisical) — see the "Secrets" section at
the top of this guide.

## Slack Integration

See [`docs/SLACK.md`](SLACK.md) for the full Slack integration guide: app
manifest, required scopes, env vars, slash command reference (`/tasks …`),
channel subscription model, and notifier behaviour. Slack is **optional** —
the service runs without it; the three Slack env vars are validated as a
group (all three or none).

## Troubleshooting

### API returns 401 Unauthorized

Check that:
1. `API_KEYS` environment variable is set on the server
2. Your request includes `X-API-Key` header
3. The header value matches one of the keys in `API_KEYS`

### CLI commands fail with connection error

Check that:
1. API server is running (`npm start` or `npm run dev`)
2. `API_BASE_URL` environment variable is set correctly
3. `API_KEY` environment variable matches a key in server's `API_KEYS`

### MCP tools not working in Claude Code

Check that:
1. The installer completed successfully
2. `~/.claude.json` contains the wood-fired-bugs MCP server configuration
3. The `DATABASE_PATH` (or legacy `DB_PATH`) in the MCP config points to a valid database
4. The `command` path points to the compiled MCP server (`dist/mcp/index.js`)

[TIP] Restart Claude Code after running the installer for changes to take effect.

### Database errors

If you see database errors, try:

1. Delete the database file and run migrations again:
   ```bash
   rm ./data/tasks.db
   npm run migrate
   ```

2. Check file permissions on the database file and `data/` directory

3. Ensure only one process is writing to the database at a time

## Next Steps

- Read [API.md](API.md) for complete API reference
- Read [CLI.md](CLI.md) for complete CLI reference
- Read [MCP.md](MCP.md) for MCP tools and skill files reference
- Read [SLACK.md](SLACK.md) for the optional Slack integration (slash commands, notifier, channel subscriptions)
- Check [README.md](../README.md) for architecture overview
