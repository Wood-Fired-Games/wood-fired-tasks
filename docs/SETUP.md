# Setup Guide

Complete setup instructions for Wood Fired Bugs in development, production, and Claude Code environments.

## Prerequisites

- Node.js 20 or higher
- npm (comes with Node.js)

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
DB_PATH=./data/tasks.db

# CLI Configuration (for testing CLI commands)
API_BASE_URL=http://localhost:3000
API_KEY=dev-key-1
```

[IMPORTANT] The `API_KEYS` variable is required for authentication. Set it to one or more comma-separated keys. These keys will be required in the `X-API-Key` header for all API requests.

### 3. Build the Project

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

### 4. Run Database Migrations

```bash
npm run migrate
```

This creates the SQLite database at `DB_PATH` and runs all migrations to set up the schema.

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
export DB_PATH=/var/lib/wood-fired-bugs/tasks.db
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

### Linux and macOS

Run the install script. The installer resolves the API key in this order:
`WOOD_FIRED_BUGS_API_KEY` env var → `~/.config/wood-fired-bugs/api-key`
(mode 600) → masked interactive prompt → `--api-key` argv flag (deprecated).

```bash
# Recommended (key never on argv):
WOOD_FIRED_BUGS_API_KEY="your-key-here" ./install.sh

# Or let the installer prompt:
./install.sh
```

The installer writes the key into a 0600 file under
`~/.config/wood-fired-bugs/api-key`. Subsequent re-runs read from there and
do not need argv/env. `~/.claude.json` (and any timestamped backup) is also
chmod'd to 0600 because it contains the key in the MCP env block.

### Windows

Run the PowerShell installer. Resolution order is `-ApiKey` (deprecated) →
`WOOD_FIRED_BUGS_API_KEY` env var → `%LOCALAPPDATA%\wood-fired-bugs\api-key`
(user-only ACL) → masked prompt.

```powershell
# Recommended (key never on argv):
$env:WOOD_FIRED_BUGS_API_KEY = "your-key-here"
.\install.ps1

# Or let the installer prompt:
.\install.ps1
```

The installer tightens the ACL on `~/.claude.json` (and any timestamped
backup) to the current user only via `icacls`.

### What the Installer Does

1. **Copies skill files** to `~/.claude/commands/tasks/` (10 skill files)
2. **Updates MCP server configuration** in `~/.claude.json` to add the wood-fired-bugs MCP server
3. **Configures environment** with DB_PATH for the MCP server

### Resulting MCP Configuration

The installer adds this configuration to `~/.claude.json`:

```json
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": ["/path/to/wood-fired-bugs/dist/mcp/index.js"],
      "env": {
        "DB_PATH": "/path/to/wood-fired-bugs/data/tasks.db"
      }
    }
  }
}
```

[NOTE] The MCP server runs as a separate process via stdio. It creates its own database connection and does NOT call the REST API.

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

Set via `DB_PATH` environment variable. Defaults to `./data/tasks.db`.

### Migrations

Four migration files in `src/db/migrations/`:

1. `001-initial-schema.ts` - Creates projects, tasks, task_tags, dependencies, comments tables
2. `002-task-hierarchy-and-dependencies.ts` - Task hierarchy and dependency tracking
3. `003-comments-and-estimates.ts` - Comments and time estimates
4. `004-claim-protocol.ts` - Version field, claimed_at, idempotency_keys table

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
- MCP tool tests (all 20 tools)
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
3. The `DB_PATH` in the MCP config points to a valid database
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
- Check [README.md](../README.md) for architecture overview
