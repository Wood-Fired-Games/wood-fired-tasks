---
phase: quick-3
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - README.md
  - docs/API.md
  - docs/CLI.md
  - docs/MCP.md
  - docs/SETUP.md
autonomous: true

must_haves:
  truths:
    - "A developer reading README.md understands what wood-fired-bugs is, how to install it, and where to find detailed docs"
    - "A developer reading docs/API.md can call any REST endpoint correctly without reading source code"
    - "A developer reading docs/CLI.md can use any CLI command correctly without --help"
    - "A Claude Code user reading docs/MCP.md can configure and use MCP tools and skill files"
    - "A new contributor reading docs/SETUP.md can set up the project from scratch for development or production"
  artifacts:
    - path: "README.md"
      provides: "Project overview, quick start, architecture summary, links to detailed docs"
      min_lines: 150
    - path: "docs/API.md"
      provides: "Complete REST API reference with all 19 endpoints, request/response examples, auth details"
      min_lines: 200
    - path: "docs/CLI.md"
      provides: "Complete CLI command reference with all 19 commands, options, usage examples"
      min_lines: 150
    - path: "docs/MCP.md"
      provides: "MCP tools reference (16 tools) plus skill files documentation (10 skills)"
      min_lines: 100
    - path: "docs/SETUP.md"
      provides: "Development setup, production deployment, Claude Code integration, env vars"
      min_lines: 100
  key_links:
    - from: "README.md"
      to: "docs/*.md"
      via: "Markdown links to detailed docs"
      pattern: "\\[.*\\]\\(docs/"
    - from: "docs/SETUP.md"
      to: "install.sh, install.ps1"
      via: "References to installer scripts"
      pattern: "install\\.(sh|ps1)"
---

<objective>
Write comprehensive project documentation for wood-fired-bugs: a README.md as the project landing page plus four detailed reference docs covering the REST API, CLI, MCP server, and setup/deployment.

Purpose: Enable humans and AI agents to understand, install, configure, and use wood-fired-bugs without reading source code. This is the project's public-facing documentation.
Output: README.md + docs/API.md + docs/CLI.md + docs/MCP.md + docs/SETUP.md
</objective>

<execution_context>
@/home/stuart/.claude/get-shit-done/workflows/execute-plan.md
@/home/stuart/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@package.json
@src/types/task.ts
@src/schemas/task.schema.ts
@src/api/server.ts
@src/api/start.ts
@src/api/routes/tasks/index.ts
@src/api/routes/projects/index.ts
@src/api/routes/comments/index.ts
@src/api/routes/dependencies/index.ts
@src/api/routes/health.ts
@src/cli/bin/tasks.ts
@src/mcp/index.ts
@src/mcp/tools/task-tools.ts
@src/mcp/tools/project-tools.ts
@src/mcp/tools/comment-tools.ts
@src/mcp/tools/dependency-tools.ts
@src/mcp/tools/health-tools.ts
@install.sh
@install.ps1
@skills/tasks/create-task.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Write README.md and docs/SETUP.md</name>
  <files>README.md, docs/SETUP.md</files>
  <action>
Create `README.md` at the project root with these sections (in order):

1. **Header** - "Wood Fired Bugs" title, one-line description: "Network-wide task tracking for Wood Fired Games", then a brief features summary (REST API, CLI, MCP server, Claude Code skills).

2. **Quick Start** - Minimal steps to get running:
   - Clone, `npm install`, `npm run build`
   - Set env vars (API_KEYS, DB_PATH)
   - `npm start` for API, `tasks` for CLI
   - Link to docs/SETUP.md for detailed setup

3. **Architecture Overview** - Brief paragraph + table showing the 3 interfaces (API on port 3000 at /api/v1, CLI via `tasks` binary, MCP via stdio) all sharing the same service layer and SQLite database.

4. **Data Model** - Table listing the 5 entity types:
   - projects (id, name, description, timestamps)
   - tasks (id, title, description, status, priority, project_id, parent_task_id, estimated_minutes, assignee, created_by, due_date, timestamps)
   - task_tags (id, task_id, tag)
   - dependencies (id, task_id, blocks_task_id, created_at)
   - comments (id, task_id, author, content, timestamps)
   Include task statuses: open, in_progress, done, closed, blocked. Include task priorities: low, medium, high, urgent. Include the valid status transitions map from src/types/task.ts.

5. **API Summary** - Table with Method, Path, Description for all 19 endpoints. Group by resource (health, projects, tasks, comments, dependencies). Note auth requirement (X-API-Key header). Link to docs/API.md for full details.

6. **CLI Summary** - Table with Command, Description for all 19 commands. Group by domain (tasks, projects, dependencies, comments, subtasks, health). Note global flags (--json, --no-input, --force). Link to docs/CLI.md.

7. **MCP Tools Summary** - Table with Tool Name, Description for all 16 tools. Link to docs/MCP.md.

8. **Configuration** - Table of all env vars: PORT (default 3000), HOST (default 0.0.0.0), API_KEYS (comma-separated), LOG_LEVEL (default info), NODE_ENV, DB_PATH (default ./data/tasks.db), API_BASE_URL (for CLI), API_KEY (for CLI).

9. **Development** - Key commands: `npm run dev`, `npm test`, `npm run build`, `npm run cli -- <command>`, `npm run mcp:dev`.

10. **License** - ISC

Create `docs/SETUP.md` with:

1. **Prerequisites** - Node.js 20+, npm

2. **Development Setup** - Step-by-step: clone, npm install, create .env file with example values, npm run build, npm run migrate, npm run dev.

3. **Production Deployment** - npm run build, npm start, env vars for production (API_KEYS with strong keys, LOG_LEVEL=warn, NODE_ENV=production).

4. **CLI Installation** - npm link (for global `tasks` command), or direct `npx tsx src/cli/bin/tasks.ts`. Mention env vars needed: API_BASE_URL, API_KEY.

5. **Claude Code Integration** - Running install.sh (Linux/macOS) or install.ps1 (Windows). What the installer does: copies skills to ~/.claude/commands/tasks/, adds MCP server config to ~/.claude.json. Show the resulting MCP config JSON snippet. Mention the /tasks: skill namespace and list all 10 skill files.

6. **Database** - SQLite via better-sqlite3, WAL mode, auto-migration via umzug, DB_PATH env var, 3 migration files.

7. **Testing** - npm test (vitest), npm run test:watch, test count (386 tests, 36 files).

8. **Swagger UI** - Available at /documentation when server is running.

Style: No emojis. Use text labels like [NOTE], [TIP], [IMPORTANT] for callouts. Clear markdown tables with alignment. Code blocks with language tags. Readable by humans and AI agents scanning for quick answers.
  </action>
  <verify>
    - `test -f README.md && wc -l README.md` shows 150+ lines
    - `test -f docs/SETUP.md && wc -l docs/SETUP.md` shows 100+ lines
    - `grep -c "docs/" README.md` shows 4+ links to docs/ subdirectory
    - All 19 endpoints appear in README.md API summary table
    - All 19 CLI commands appear in README.md CLI summary table
    - All 16 MCP tools appear in README.md MCP summary table
    - All 8 env vars documented in README.md Configuration section
  </verify>
  <done>README.md provides complete project overview with tables summarizing all APIs/CLI/MCP, and docs/SETUP.md provides step-by-step setup for dev, prod, CLI, and Claude Code integration</done>
</task>

<task type="auto">
  <name>Task 2: Write docs/API.md and docs/CLI.md reference docs</name>
  <files>docs/API.md, docs/CLI.md</files>
  <action>
Create `docs/API.md` - Complete REST API reference:

1. **Header** - Title, base URL (`http://localhost:3000/api/v1`), auth header (`X-API-Key`).

2. **Authentication** - All endpoints under /api/v1 require X-API-Key header. Health endpoint at /health is public. Show example: `curl -H "X-API-Key: your-key"`. Show 401 error response format: `{"error": "UNAUTHORIZED", "message": "..."}`.

3. **Error Handling** - Standard error response format. Mention Zod validation errors (400), not found (404), business logic errors.

4. **Endpoints by resource** - For EACH of the 19 endpoints, document:
   - Method + Path
   - Description
   - Request body schema (JSON with field types, required/optional, constraints from Zod schemas)
   - Query parameters (for list endpoints)
   - Response schema (status code + JSON shape)
   - curl example

   Endpoints to document (read each route file for exact schemas):

   **Health (public, no auth):**
   - GET /health - Service health check

   **Projects (5 endpoints):**
   - POST /api/v1/projects - Create project (body: name required max 100, description optional max 1000)
   - GET /api/v1/projects - List all projects
   - GET /api/v1/projects/:id - Get project by ID
   - PUT /api/v1/projects/:id - Update project (partial body)
   - DELETE /api/v1/projects/:id - Delete project (204)

   **Tasks (6 endpoints):**
   - POST /api/v1/tasks - Create task (body: title required max 255, priority default medium, project_id required, created_by required, etc. Note: status NOT in create -- always starts as open)
   - GET /api/v1/tasks - List tasks with filters (query: project_id, status, assignee, tags, due_before, due_after, search)
   - GET /api/v1/tasks/:id - Get task by ID
   - PUT /api/v1/tasks/:id - Update task (partial body, includes status with transition validation)
   - DELETE /api/v1/tasks/:id - Delete task (204)
   - GET /api/v1/tasks/:id/subtasks - Get subtasks of a task

   **Comments (3 endpoints, nested under /tasks):**
   - POST /api/v1/tasks/:id/comments - Add comment (body: author max 100, content max 5000)
   - GET /api/v1/tasks/:id/comments - List comments for task
   - DELETE /api/v1/tasks/:id/comments/:commentId - Delete comment (204)

   **Dependencies (3 endpoints, nested under /tasks):**
   - POST /api/v1/tasks/:id/dependencies - Add dependency (body: blocks_task_id)
   - GET /api/v1/tasks/:id/dependencies - Get dependencies (returns blocks + blocked_by arrays)
   - DELETE /api/v1/tasks/:id/dependencies/:blocksTaskId - Remove dependency (204)

5. **Swagger** - Note that interactive API docs are available at /documentation when the server is running.

Create `docs/CLI.md` - Complete CLI command reference:

1. **Header** - Binary name `tasks`, how to run (`tasks <command>` after npm link, or `npx tsx src/cli/bin/tasks.ts <command>` for dev).

2. **Global Options** - `--json` (machine-readable output), `--no-input` (disable interactive prompts), `--force` (skip confirmations).

3. **Commands by domain** - For EACH of the 19 commands, document:
   - Command syntax with arguments and options
   - Description
   - Options with types and defaults
   - Usage example (both human and --json mode)

   Read each command file in src/cli/commands/ to get exact argument names, options, and behavior.

   **Task Commands (5):**
   - `tasks create` - Create a new task (interactive or with options)
   - `tasks list` - List tasks with filters
   - `tasks show <id>` - Show task details
   - `tasks update <id>` - Update task fields
   - `tasks delete <id>` - Delete a task

   **Project Commands (5):**
   - `tasks project-create` - Create project
   - `tasks project-list` - List projects
   - `tasks project-show <id>` - Show project
   - `tasks project-update <id>` - Update project
   - `tasks project-delete <id>` - Delete project

   **Dependency Commands (3):**
   - `tasks dep-add <taskId> <blocksTaskId>` - Add dependency
   - `tasks dep-remove <taskId> <blocksTaskId>` - Remove dependency
   - `tasks dep-list <taskId>` - List dependencies

   **Comment Commands (3):**
   - `tasks comment-add <taskId>` - Add comment
   - `tasks comment-list <taskId>` - List comments
   - `tasks comment-delete <commentId>` - Delete comment

   **Subtask Commands (2):**
   - `tasks subtask-create <parentTaskId>` - Create subtask
   - `tasks subtask-list <parentTaskId>` - List subtasks

   **Health (1):**
   - `tasks health` - Check server health

4. **Environment Variables** - API_BASE_URL (default http://localhost:3000), API_KEY for authentication.

Style: No emojis. Use fenced code blocks for all examples. Include both human-readable and --json output examples where meaningful. Tables for options/arguments.
  </action>
  <verify>
    - `test -f docs/API.md && wc -l docs/API.md` shows 200+ lines
    - `test -f docs/CLI.md && wc -l docs/CLI.md` shows 150+ lines
    - `grep -c "curl" docs/API.md` shows 10+ curl examples (at least one per resource group)
    - All 19 endpoints documented in docs/API.md (grep for each path)
    - All 19 commands documented in docs/CLI.md (grep for each command name)
    - docs/API.md includes authentication section with X-API-Key
    - docs/CLI.md includes global options section
  </verify>
  <done>docs/API.md has complete reference for all 19 REST endpoints with schemas, examples, and auth docs. docs/CLI.md has complete reference for all 19 CLI commands with syntax, options, and examples.</done>
</task>

<task type="auto">
  <name>Task 3: Write docs/MCP.md</name>
  <files>docs/MCP.md</files>
  <action>
Create `docs/MCP.md` - MCP server and skill files reference:

1. **Header** - "MCP Server and Claude Code Integration", brief intro: wood-fired-bugs exposes task management via MCP (Model Context Protocol) for direct use by Claude Code.

2. **MCP Server** - Transport: stdio. Entry point: `node dist/mcp/index.js` (or `npx tsx src/mcp/index.ts` for dev). Server name (from src/mcp/server.ts if available, otherwise "wood-fired-bugs"). DB_PATH env var for database location.

3. **Configuration** - Show the JSON snippet that goes in ~/.claude.json for mcpServers config. Reference that install.sh/install.ps1 handles this automatically.

4. **Tools Reference** - For EACH of the 16 MCP tools, document:
   - Tool name
   - Description
   - Input schema (parameters with types)
   - Example usage context (when Claude Code would use this tool)

   Read each tool registration in src/mcp/tools/ for exact names and schemas:

   **Task Tools (7):**
   - create_task - Create a new task (input: CreateTaskSchema fields)
   - get_task - Get task by ID (input: id)
   - update_task - Update task (input: id, updates)
   - list_tasks - List with filters (input: TaskFiltersSchema fields)
   - delete_task - Delete task (input: id)
   - list_subtasks - List subtasks of parent (input: task_id)
   - get_subtasks - Get subtasks of parent (input: task_id)

   **Project Tools (5):**
   - create_project - Create project (input: name, description)
   - get_project - Get project (input: id)
   - list_projects - List all (input: none)
   - update_project - Update project (input: id, updates)
   - delete_project - Delete project (input: id)

   **Comment Tools (3):**
   - add_comment - Add comment (input: task_id, author, content)
   - get_comments - Get comments for task (input: task_id)
   - delete_comment - Delete comment (input: comment_id)

   **Dependency Tools (3):**
   - add_dependency - Add dependency (input: task_id, blocks_task_id)
   - remove_dependency - Remove dependency (input: task_id, blocks_task_id)
   - get_dependencies - Get dependencies (input: task_id)

   **Health Tools (1):**
   - check_health - Check service health (input: none)

5. **Skill Files** - The /tasks: namespace. List all 10 skill files from skills/tasks/:
   - /tasks:create-task
   - /tasks:blocked
   - /tasks:done
   - /tasks:log-bug
   - /tasks:my-work
   - /tasks:pick-up
   - /tasks:project-status
   - /tasks:search
   - /tasks:show-task
   - /tasks:add-comment

   For each, provide a one-line description. Read the skill files' frontmatter (name, description fields) for accurate descriptions.

6. **How It Works** - Brief architecture note: MCP server creates its own database connection (shares same schema), does NOT call the REST API. Skill files are Claude Code slash commands that use MCP tools under the hood.

Style: No emojis. Use tables for tool reference. Code blocks for configuration examples.
  </action>
  <verify>
    - `test -f docs/MCP.md && wc -l docs/MCP.md` shows 100+ lines
    - All 16 MCP tool names appear in docs/MCP.md
    - All 10 skill file names appear in docs/MCP.md
    - docs/MCP.md includes ~/.claude.json configuration snippet
    - docs/MCP.md references both install.sh and install.ps1
  </verify>
  <done>docs/MCP.md has complete reference for all 16 MCP tools with input schemas, all 10 skill files with descriptions, configuration instructions, and architecture explanation</done>
</task>

</tasks>

<verification>
After all tasks complete:
1. All 5 documentation files exist: README.md, docs/API.md, docs/CLI.md, docs/MCP.md, docs/SETUP.md
2. README.md links to all 4 docs/ files
3. No emojis anywhere in documentation (project convention)
4. All numbers are accurate: 19 API endpoints, 19 CLI commands, 16 MCP tools, 10 skill files
5. All env vars documented: PORT, HOST, API_KEYS, LOG_LEVEL, NODE_ENV, DB_PATH, API_BASE_URL, API_KEY
6. Task statuses (open, in_progress, done, closed, blocked) and priorities (low, medium, high, urgent) documented
7. Auth mechanism (X-API-Key header) documented in API.md and referenced in README.md
</verification>

<success_criteria>
- A developer unfamiliar with the project can read README.md and understand what wood-fired-bugs is, what it does, and how to get started
- A developer can use docs/API.md to call any endpoint correctly with curl
- A developer can use docs/CLI.md to run any command correctly
- A Claude Code user can use docs/MCP.md to configure MCP integration and understand available tools
- A contributor can use docs/SETUP.md to set up a development environment from scratch
- All documentation is accurate against the actual source code (schemas, endpoints, commands, tools)
</success_criteria>

<output>
After completion, create `.planning/quick/3-write-comprehensive-project-documentatio/3-SUMMARY.md`
</output>
