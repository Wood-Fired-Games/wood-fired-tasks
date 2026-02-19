---
phase: quick-6
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/mcp/remote/index.ts
  - src/mcp/remote/rest-client.ts
  - src/mcp/remote/register-tools.ts
  - scripts/build-client-package.sh
  - client-package/setup.ps1
  - client-package/setup.sh
  - client-package/README.md
  - client-package/commands/tasks/create-task.md
  - client-package/commands/tasks/my-work.md
  - client-package/commands/tasks/pick-up.md
  - client-package/commands/tasks/done.md
  - client-package/commands/tasks/search.md
  - client-package/commands/tasks/show-task.md
  - client-package/commands/tasks/log-bug.md
  - client-package/commands/tasks/add-comment.md
  - client-package/commands/tasks/blocked.md
  - client-package/commands/tasks/project-status.md
autonomous: false
requirements: []

must_haves:
  truths:
    - "A Windows user can unzip a single file and run setup to get full /tasks:* access"
    - "The remote MCP server exposes all 26 wood-fired-bugs tools over REST API proxy"
    - "Claude Code on the Windows machine can call /tasks:create-task and it creates a task on the Linux backend"
    - "The CLI on Windows points to the Linux backend REST API"
  artifacts:
    - path: "src/mcp/remote/index.ts"
      provides: "Remote MCP server entry point (stdio transport, REST API backend)"
      min_lines: 30
    - path: "src/mcp/remote/rest-client.ts"
      provides: "REST API HTTP client used by remote MCP tools"
      min_lines: 80
    - path: "src/mcp/remote/register-tools.ts"
      provides: "All 26 MCP tool registrations backed by REST API calls"
      min_lines: 200
    - path: "scripts/build-client-package.sh"
      provides: "Script to build the distributable zip"
      min_lines: 30
    - path: "client-package/setup.ps1"
      provides: "Windows PowerShell setup script"
      min_lines: 30
    - path: "client-package/README.md"
      provides: "User-facing setup instructions"
      min_lines: 20
  key_links:
    - from: "src/mcp/remote/register-tools.ts"
      to: "src/mcp/remote/rest-client.ts"
      via: "REST API calls for each MCP tool"
      pattern: "restClient\\."
    - from: "src/mcp/remote/index.ts"
      to: "src/mcp/remote/register-tools.ts"
      via: "tool registration on McpServer"
      pattern: "registerRemoteTools"
    - from: "client-package/commands/tasks/*.md"
      to: "wood-fired-bugs MCP server"
      via: "MCP tool calls like wood-fired-bugs:create_task"
      pattern: "wood-fired-bugs:"
---

<objective>
Create a standalone distributable package (zip) that gives any Windows (or Linux/Mac) machine
on the LAN full access to the Wood Fired Bugs task system via Claude Code.

The package contains:
1. A **remote MCP server** -- a lightweight Node.js server that runs via stdio on the client
   machine and proxies all 26 MCP tools to the Linux backend's REST API over HTTP.
2. The **/tasks:** Claude Code slash commands (skills) so users get /tasks:create-task,
   /tasks:my-work, /tasks:done, etc.
3. Setup scripts (PowerShell for Windows, bash for Linux/Mac) that configure Claude Code's
   MCP server settings and install the skills.
4. A README with clear setup instructions.

The backend remains on the Linux box (192.168.69.69:3000). Windows machines are pure clients.

Purpose: Enable any developer on the LAN to use Claude Code with full task management
capabilities by distributing a single zip file.

Output: `dist/wood-fired-bugs-client.zip` containing everything needed.
</objective>

<execution_context>
@/home/stuart/.claude/get-shit-done/workflows/execute-plan.md
@/home/stuart/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@src/mcp/server.ts
@src/mcp/tools/task-tools.ts
@src/mcp/tools/project-tools.ts
@src/mcp/tools/dependency-tools.ts
@src/mcp/tools/comment-tools.ts
@src/mcp/tools/health-tools.ts
@src/mcp/index.ts
@src/cli/api/client.ts
@src/cli/config/env.ts
@/home/stuart/.claude/commands/tasks/create-task.md
@/home/stuart/.claude/commands/tasks/my-work.md
@/home/stuart/.claude/commands/tasks/pick-up.md
@/home/stuart/.claude/commands/tasks/done.md
@/home/stuart/.claude/commands/tasks/search.md
@/home/stuart/.claude/commands/tasks/show-task.md
@/home/stuart/.claude/commands/tasks/log-bug.md
@/home/stuart/.claude/commands/tasks/add-comment.md
@/home/stuart/.claude/commands/tasks/blocked.md
@/home/stuart/.claude/commands/tasks/project-status.md
@package.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create remote MCP proxy server backed by REST API</name>
  <files>
    src/mcp/remote/index.ts
    src/mcp/remote/rest-client.ts
    src/mcp/remote/register-tools.ts
  </files>
  <action>
Create a remote MCP server that exposes the same 26 tools as the local MCP server but proxies
every operation to the REST API over HTTP. This runs via stdio on the client machine.

**src/mcp/remote/rest-client.ts:**
- Create a `RestClient` class that wraps HTTP calls to the REST API.
- Constructor takes `baseUrl: string` and `apiKey: string` (from environment: `WFB_API_URL` and `WFB_API_KEY`).
- Methods mirror the REST API endpoints the existing `src/cli/api/client.ts` uses:
  - Tasks: `createTask`, `getTask`, `updateTask`, `listTasks`, `deleteTask`, `claimTask`, `getSubtasks`
  - Projects: `createProject`, `getProject`, `updateProject`, `listProjects`, `deleteProject`
  - Dependencies: `addDependency`, `removeDependency`, `getDependencies` (GET /api/v1/tasks/:id/dependencies)
  - Comments: `addComment`, `getComments`, `deleteComment`
  - Health: `checkHealth` (GET /health)
- Use native `fetch` (Node 18+). Set `X-API-Key` header. Set Content-Type for POST/PUT.
  10-second timeout via AbortController.
- Throw descriptive errors on non-OK responses (parse JSON error body if available).
- Pattern reference: `src/cli/api/client.ts` -- follow same URL patterns and error handling.

**src/mcp/remote/register-tools.ts:**
- Export `registerRemoteTools(server: McpServer, client: RestClient): void`
- Register ALL 26 tools with the same names, descriptions, and input schemas as the local versions:
  - 8 task tools: `create_task`, `get_task`, `update_task`, `list_tasks`, `delete_task`, `claim_task`, `list_subtasks`, `get_subtasks`
  - 5 project tools: `create_project`, `get_project`, `update_project`, `list_projects`, `delete_project`
  - 3 dependency tools: `add_dependency`, `remove_dependency`, `get_dependencies`
  - 3 comment tools: `add_comment`, `get_comments`, `delete_comment`
  - 1 health tool: `check_health`
- Each tool handler calls the corresponding `RestClient` method and formats the MCP response
  with the same `content` text format and `structuredContent` as the local tools.
- Import Zod schemas from the existing schema files for input validation:
  `CreateTaskSchema`, `UpdateTaskSchema`, `TaskFiltersSchema`, `CreateProjectSchema` from
  `../../schemas/task.schema.js`.
- For health check: call REST `/health` endpoint instead of SQLite pragma.
- Catch errors and return them as MCP errors (use `McpError` with `ErrorCode.InternalError`).

**src/mcp/remote/index.ts:**
- Entry point for the remote MCP server.
- Read `WFB_API_URL` and `WFB_API_KEY` from environment variables (required -- exit with error
  message if missing).
- Create `RestClient` with those values.
- Create `McpServer` with name `'wood-fired-bugs'` and version `'1.0.0'` (same as local).
- Call `registerRemoteTools(server, client)`.
- Also register the events resource (import from `../resources/events.js`) using `WFB_API_URL`
  and `WFB_API_KEY`.
- Create `StdioServerTransport`, connect, log to stderr.
- Add global error handlers (uncaughtException, unhandledRejection) matching `src/mcp/index.ts`.

**Important:** Do NOT import any service classes or SQLite. The remote server is purely a REST
API proxy. It should be compilable with `tsc` alongside the rest of the project.

Add `"mcp:remote"` script to `package.json`: `"node dist/mcp/remote/index.js"`
  </action>
  <verify>
Run `npx tsc --noEmit` -- no type errors in the new files.
Run `node dist/mcp/remote/index.js` with `WFB_API_URL=http://localhost:3000 WFB_API_KEY=912a0df1fc2fc9abb3104195299a4918b221bd03b8cda5f44feb2994bf14f374` -- should output "Wood Fired Bugs MCP Server (remote) running on stdio" to stderr and wait for input.
  </verify>
  <done>
Remote MCP server compiles, starts via stdio, and all 26 tools are registered with REST API proxy backing.
  </done>
</task>

<task type="auto">
  <name>Task 2: Create client package contents and build script</name>
  <files>
    client-package/commands/tasks/create-task.md
    client-package/commands/tasks/my-work.md
    client-package/commands/tasks/pick-up.md
    client-package/commands/tasks/done.md
    client-package/commands/tasks/search.md
    client-package/commands/tasks/show-task.md
    client-package/commands/tasks/log-bug.md
    client-package/commands/tasks/add-comment.md
    client-package/commands/tasks/blocked.md
    client-package/commands/tasks/project-status.md
    client-package/setup.ps1
    client-package/setup.sh
    client-package/README.md
    scripts/build-client-package.sh
  </files>
  <action>
Create the distributable package contents and the build script that assembles the zip.

**Skills (client-package/commands/tasks/*.md):**
- Copy all 10 skill files from `/home/stuart/.claude/commands/tasks/` into `client-package/commands/tasks/`.
- These are the exact same files -- no modifications needed. They reference MCP tools by name
  (e.g., `wood-fired-bugs:create_task`) which will be resolved by the MCP server configuration.

**client-package/setup.ps1 (Windows PowerShell):**
- Accept optional parameter: `-ServerUrl` (default: `http://192.168.69.69:3000`), `-ApiKey` (required).
- Create `$env:USERPROFILE\.claude\commands\tasks\` directory if it doesn't exist.
- Copy all `.md` files from `commands\tasks\` in the package to that directory.
- Detect Node.js: run `node --version` and check exit code. If not found, print error:
  "Node.js 18+ is required. Download from https://nodejs.org/"
- Create/update `$env:USERPROFILE\.claude\settings.json`:
  - Read existing file if present (preserve existing settings).
  - Add/update `mcpServers.wood-fired-bugs` entry:
    ```json
    {
      "command": "node",
      "args": ["<package-path>/mcp-server/dist/mcp/remote/index.js"],
      "env": {
        "WFB_API_URL": "<ServerUrl>",
        "WFB_API_KEY": "<ApiKey>"
      }
    }
    ```
    Where `<package-path>` is resolved to the absolute path of the extracted package directory.
- Print success message with test instructions:
  "Setup complete! Open Claude Code in any project and try: /tasks:my-work"

**client-package/setup.sh (Linux/Mac):**
- Same logic as PowerShell but in bash. Accept `--server-url` and `--api-key` flags.
- Target `~/.claude/commands/tasks/` for skills.
- Target `~/.claude/settings.json` for MCP server config.
- Use `jq` for JSON manipulation if available, otherwise use a simple Python one-liner as fallback.

**client-package/README.md:**
- Title: "Wood Fired Bugs - Client Setup"
- Prerequisites: Node.js 18+, Claude Code installed, network access to the backend.
- Quick start steps:
  1. Unzip this archive
  2. Run setup script with your API key
  3. Open Claude Code and use /tasks:my-work
- Full command examples for Windows and Linux/Mac.
- Troubleshooting section: connectivity check (curl http://SERVER:3000/health),
  Node.js version check, MCP server manual test.
- Reference the 10 available /tasks: commands with brief descriptions.

**scripts/build-client-package.sh:**
- Build the TypeScript project (`npm run build`).
- Create a temp staging directory.
- Copy into staging:
  - `dist/mcp/remote/` -- the compiled remote MCP server JS files.
  - `dist/mcp/resources/` -- the events resource (needed by remote server).
  - `dist/mcp/errors.js` and `dist/mcp/errors.js.map` -- error conversion.
  - `node_modules/@modelcontextprotocol/` -- MCP SDK (runtime dependency).
  - `node_modules/zod/` -- Zod (runtime dependency for schema validation).
  - `dist/schemas/` -- compiled Zod schemas used by register-tools.
  - `package.json` -- needed for module resolution.
  - `client-package/commands/` -- the skills.
  - `client-package/setup.ps1`, `client-package/setup.sh`, `client-package/README.md`.
- Structure the staging directory:
  ```
  wood-fired-bugs-client/
    README.md
    setup.ps1
    setup.sh
    commands/tasks/*.md
    mcp-server/
      dist/mcp/remote/*.js
      dist/mcp/resources/*.js
      dist/mcp/errors.js
      dist/schemas/*.js
      node_modules/...
      package.json
  ```
- Create zip: `cd staging && zip -r ../dist/wood-fired-bugs-client.zip wood-fired-bugs-client/`
- Print final size and path.
- Make the script executable.

**Important for the setup scripts:** The MCP server entry point path in settings.json must be
an absolute path pointing to `<extracted-package>/mcp-server/dist/mcp/remote/index.js`. The
setup scripts should resolve this from their own location.
  </action>
  <verify>
Run `bash scripts/build-client-package.sh` -- produces `dist/wood-fired-bugs-client.zip`.
Unzip to a temp directory and verify:
- `commands/tasks/` contains all 10 .md files
- `mcp-server/dist/mcp/remote/index.js` exists
- `mcp-server/node_modules/@modelcontextprotocol/` exists
- `setup.ps1` and `setup.sh` exist
- `README.md` exists
Run `WFB_API_URL=http://localhost:3000 WFB_API_KEY=912a0df1fc2fc9abb3104195299a4918b221bd03b8cda5f44feb2994bf14f374 node <temp>/mcp-server/dist/mcp/remote/index.js` -- starts successfully.
  </verify>
  <done>
Build script produces a self-contained zip file. The zip contains the remote MCP server with
all dependencies, all 10 /tasks: skills, setup scripts for Windows and Linux/Mac, and a README.
The MCP server inside the zip starts successfully when given API URL and key.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: Verify client package works end-to-end</name>
  <files></files>
  <action>
Human verifies the complete client distribution package. The zip was built containing:
- Remote MCP server that proxies all 26 tools to the REST API
- All 10 /tasks: Claude Code skills
- Setup scripts for Windows (PowerShell) and Linux/Mac (bash)
- README with setup instructions
  </action>
  <verify>
1. Check the zip was created: `ls -lh dist/wood-fired-bugs-client.zip`
2. Review the zip contents: `unzip -l dist/wood-fired-bugs-client.zip | head -40`
3. Test the remote MCP server locally:
   ```
   WFB_API_URL=http://localhost:3000 WFB_API_KEY=912a0df1fc2fc9abb3104195299a4918b221bd03b8cda5f44feb2994bf14f374 \
     node dist/mcp/remote/index.js
   ```
   (Should start and respond to MCP protocol on stdin)
4. If you have a Windows machine available, copy the zip over and test the setup script.
  </verify>
  <done>User confirms the package is correct and functional.</done>
</task>

</tasks>

<verification>
- `npx tsc --noEmit` passes with no errors in new files
- `dist/wood-fired-bugs-client.zip` exists and contains correct structure
- Remote MCP server starts and connects to REST API
- Skills files are identical to originals
- Setup scripts reference correct paths
</verification>

<success_criteria>
- A single zip file exists at `dist/wood-fired-bugs-client.zip`
- The zip contains a working remote MCP server, all 10 /tasks: skills, setup scripts, and README
- Unzipping on any machine with Node.js 18+ and running the setup script configures Claude Code
  to connect to the Linux backend
- The remote MCP server proxies all 26 tools to the REST API over HTTP
</success_criteria>

<output>
After completion, create `.planning/quick/6-create-windows-installer-package-for-lan/6-SUMMARY.md`
</output>
