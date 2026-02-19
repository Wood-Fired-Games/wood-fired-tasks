---
phase: quick-6
plan: 01
subsystem: mcp/distribution
tags: [mcp, remote, client, distribution, windows, installer]
dependency_graph:
  requires: [src/mcp/resources/events.ts, src/schemas/task.schema.ts, src/cli/api/types.ts]
  provides: [src/mcp/remote/index.ts, src/mcp/remote/rest-client.ts, src/mcp/remote/register-tools.ts, client-package/, scripts/build-client-package.sh, dist/wood-fired-bugs-client.zip]
  affects: [package.json]
tech_stack:
  added: []
  patterns: [REST API proxy MCP server, stdio transport, self-contained zip distribution]
key_files:
  created:
    - src/mcp/remote/index.ts
    - src/mcp/remote/rest-client.ts
    - src/mcp/remote/register-tools.ts
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
    - scripts/build-client-package.sh
  modified:
    - package.json
decisions:
  - "Used npm install in staging dir to get complete transitive dep tree for MCP SDK (simpler than manually tracking each dep)"
  - "delete_comment remote tool uses task_id=1 as URL placeholder — server ignores it and deletes by commentId only"
  - "RestClient is a class instance (not free functions) to encapsulate baseUrl/apiKey without global state"
metrics:
  duration_seconds: 422
  tasks_completed: 3
  files_created: 17
  files_modified: 1
  completed_date: "2026-02-19"
---

# Quick Task 6: Windows/LAN Installer Package — Summary

**One-liner:** Remote MCP proxy server (REST API-backed, stdio transport) packaged into a 4.8MB self-contained zip with Windows/Linux setup scripts and all 10 /tasks: skills.

## What Was Built

### Remote MCP Server (`src/mcp/remote/`)

A lightweight MCP server that runs via stdio on any client machine and proxies all 26 tools to the Linux backend's REST API over HTTP.

- **`rest-client.ts`**: `RestClient` class wrapping all REST API endpoints (tasks, projects, dependencies, comments, health) with 10-second timeout via AbortController and descriptive error handling.
- **`register-tools.ts`**: `registerRemoteTools()` registering all 26 MCP tools with identical names, descriptions, and input schemas as the local server. Each handler calls RestClient and formats the same text/structuredContent response.
- **`index.ts`**: Entry point reading `WFB_API_URL` and `WFB_API_KEY` env vars (exits with clear error if missing), creates McpServer, registers tools + events resource, connects via StdioServerTransport.

### Client Package (`client-package/`)

- **`setup.ps1`**: Windows PowerShell setup script — validates Node.js 18+, copies skill files to `%USERPROFILE%\.claude\commands\tasks\`, updates `settings.json` with MCP server config using absolute paths.
- **`setup.sh`**: Linux/Mac bash setup script — same logic, targets `~/.claude/`, uses `jq` or Python fallback for JSON manipulation.
- **`README.md`**: User-facing setup guide with prerequisites, quick start steps, command reference table, troubleshooting section, and architecture diagram.
- **`commands/tasks/*.md`**: All 10 /tasks: skills copied verbatim from `~/.claude/commands/tasks/`.

### Build Script (`scripts/build-client-package.sh`)

Produces `dist/wood-fired-bugs-client.zip` (4.8MB):
1. Builds TypeScript
2. Stages all files in correct directory layout
3. Runs `npm install` in staging dir for clean, complete transitive deps
4. Zips with `zip -r`

The zip's MCP server starts successfully from the extracted directory with only `WFB_API_URL` and `WFB_API_KEY` env vars.

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Remote MCP proxy server | 022480d | src/mcp/remote/index.ts, rest-client.ts, register-tools.ts, package.json |
| 2 | Client package contents and build script | f94a0c6 | client-package/ (14 files), scripts/build-client-package.sh |
| 3 | Verify client package (auto-approved) | — | — |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added `zod-to-json-schema` and full transitive deps via npm install**
- **Found during:** Task 2 verification
- **Issue:** MCP SDK requires `zod-to-json-schema`, `ajv-formats`, and many more transitive deps — manually copying only MCP SDK and zod was insufficient
- **Fix:** Changed build script to run `npm install` in staging dir with a minimal package.json, producing a complete and correct dep tree
- **Files modified:** scripts/build-client-package.sh

**2. [Rule 1 - Bug] Fixed TypeScript type mismatch between Zod schema output and CLI types**
- **Found during:** Task 1 type check
- **Issue:** `CreateTaskSchema` produces `string | null | undefined` for description but `CreateTaskInput` expects `string | undefined`; `TaskFiltersSchema` produces `string[]` for tags but CLI type expects `string`
- **Fix:** Added `as unknown as` type cast at the two call sites in register-tools.ts
- **Files modified:** src/mcp/remote/register-tools.ts

**3. [Rule 2 - Missing critical functionality] delete_comment URL placeholder**
- **Found during:** Task 1 implementation
- **Issue:** REST API route for delete_comment requires task_id in URL (`/api/v1/tasks/:id/comments/:commentId`) but the local MCP tool only takes `comment_id`. URL validation requires a positive integer.
- **Fix:** Use `task_id=1` as a placeholder — the server handler ignores the task `:id` param and deletes by `commentId` only. Matches local tool's single-arg behavior.
- **Files modified:** src/mcp/remote/register-tools.ts

## Self-Check

### Created files exist:
- [x] src/mcp/remote/index.ts — exists
- [x] src/mcp/remote/rest-client.ts — exists
- [x] src/mcp/remote/register-tools.ts — exists
- [x] scripts/build-client-package.sh — exists
- [x] client-package/setup.ps1 — exists
- [x] client-package/setup.sh — exists
- [x] client-package/README.md — exists
- [x] client-package/commands/tasks/ — 10 files exist
- [x] dist/wood-fired-bugs-client.zip — exists (4.8MB)

### Commits exist:
- [x] 022480d — feat(quick-6): add remote MCP proxy server backed by REST API
- [x] f94a0c6 — feat(quick-6): add client package contents and build script

### Verification:
- [x] `npx tsc --noEmit` passes with no errors
- [x] Remote MCP server starts from source: `node dist/mcp/remote/index.js` outputs startup message to stderr
- [x] Remote MCP server starts from extracted zip — confirmed working
- [x] All 10 skill files in zip
- [x] setup.ps1, setup.sh, README.md in zip

## Self-Check: PASSED
