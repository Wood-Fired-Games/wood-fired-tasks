# Architecture Research: CLI/MCP Parity Integration

**Domain:** Task tracking CLI/MCP extension
**Researched:** 2026-02-13
**Confidence:** HIGH

## Integration Context

Wood Fired Bugs has a well-established layered architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                   Client Interfaces Layer                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │   CLI    │  │   REST   │  │   MCP    │                   │
│  │  (HTTP)  │  │   API    │  │ (Direct) │                   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                   │
│       │ HTTP        │             │                          │
├───────┴─────────────┴─────────────┴──────────────────────────┤
│                     Service Layer                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │   Task   │  │ Project  │  │Dependency│  │ Comment  │     │
│  │ Service  │  │ Service  │  │ Service  │  │ Service  │     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
│       │             │              │             │           │
├───────┴─────────────┴──────────────┴─────────────┴───────────┤
│                   Repository Layer                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐     │
│  │   Task   │  │ Project  │  │Dependency│  │ Comment  │     │
│  │   Repo   │  │   Repo   │  │   Repo   │  │   Repo   │     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘     │
│       │             │              │             │           │
├───────┴─────────────┴──────────────┴─────────────┴───────────┤
│                     Database Layer                            │
│  ┌─────────────────────────────────────────────────────┐     │
│  │              SQLite (better-sqlite3)                 │     │
│  └─────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

**Key architectural decisions:**
- **CLI → REST → Service**: CLI is HTTP client, decoupled from backend
- **MCP → Service**: MCP directly calls services (no HTTP overhead)
- **Shared schemas**: Zod schemas shared between REST and MCP
- **Separate types**: CLI has its own type definitions (decoupled)

## New Components for v1.1

### CLI Command Structure

**Location:** `src/cli/commands/`

**Current state:**
- create.ts (task creation)
- list.ts (task listing)
- update.ts (task updates)

**New structure needed:**

```
src/cli/commands/
├── tasks/
│   ├── create.ts          # Existing: tasks create
│   ├── list.ts            # Existing: tasks list
│   ├── update.ts          # Existing: tasks update
│   ├── get.ts             # NEW: tasks get <id>
│   └── delete.ts          # NEW: tasks delete <id>
├── projects/
│   ├── create.ts          # NEW: tasks project create
│   ├── list.ts            # NEW: tasks project list
│   ├── get.ts             # NEW: tasks project get <id>
│   ├── update.ts          # NEW: tasks project update <id>
│   └── delete.ts          # NEW: tasks project delete <id>
├── dependencies/
│   ├── add.ts             # NEW: tasks dep add <task-id> <blocks-id>
│   ├── list.ts            # NEW: tasks dep list <task-id>
│   └── remove.ts          # NEW: tasks dep remove <task-id> <blocks-id>
└── comments/
    ├── add.ts             # NEW: tasks comment add <task-id>
    ├── list.ts            # NEW: tasks comment list <task-id>
    └── delete.ts          # NEW: tasks comment delete <comment-id>
```

**Rationale for folder structure:**
- Each resource type gets its own folder
- Commands are organized by noun (resource) then verb (action)
- Mirrors REST API organization (`/api/v1/projects`, `/api/v1/tasks/:id/comments`)
- Enables better file organization as CLI grows

### CLI Entry Point Changes

**File:** `src/cli/bin/tasks.ts`

**Current:**
```typescript
program.addCommand(createCommand);
program.addCommand(listCommand);
program.addCommand(updateCommand);
```

**New pattern (Commander.js subcommands):**
```typescript
// Top-level commands (backwards compatible)
program.addCommand(createCommand);    // tasks create
program.addCommand(listCommand);      // tasks list
program.addCommand(updateCommand);    // tasks update

// Resource group commands
const projectCommand = new Command('project')
  .description('Manage projects');
projectCommand.addCommand(createProjectCommand);
projectCommand.addCommand(listProjectsCommand);
// ... more project commands
program.addCommand(projectCommand);

const depCommand = new Command('dep')
  .description('Manage task dependencies')
  .alias('dependency');
depCommand.addCommand(addDependencyCommand);
// ... more dependency commands
program.addCommand(depCommand);

const commentCommand = new Command('comment')
  .description('Manage task comments');
commentCommand.addCommand(addCommentCommand);
// ... more comment commands
program.addCommand(commentCommand);
```

**Source:** [Commander.js nested subcommands pattern](https://maxschmitt.me/posts/nested-subcommands-commander-node-js)

### Global Options Pattern

**Challenge:** Add `--json` flag to all commands for machine-readable output

**Solution (Commander.js global options):**

```typescript
// src/cli/bin/tasks.ts
program
  .name('tasks')
  .description('Wood Fired Bugs - Task management CLI')
  .version('1.0.0')
  .option('--json', 'Output results as JSON', false);  // Global option

// Commands can access via program.opts()
// or inherit automatically through subcommands
```

**Alternative solution (per-command):** Add `.option('--json', 'Output as JSON')` to each command individually.

**Recommendation:** Global option at program level, then each command checks `program.parent?.opts().json` to determine output format.

**Source:** [Commander.js global options discussion](https://github.com/tj/commander.js/issues/476)

### API Client Extensions

**Location:** `src/cli/api/client.ts`

**Current functions:**
- createTask()
- listTasks()
- getTask()
- updateTask()

**New functions needed:**

```typescript
// Projects
export async function createProject(data: CreateProjectInput): Promise<ProjectResponse>
export async function listProjects(): Promise<ProjectResponse[]>
export async function getProject(id: number): Promise<ProjectResponse>
export async function updateProject(id: number, data: UpdateProjectInput): Promise<ProjectResponse>
export async function deleteProject(id: number): Promise<void>

// Dependencies (nested under tasks)
export async function addDependency(taskId: number, blocksTaskId: number): Promise<DependencyResponse>
export async function listDependencies(taskId: number): Promise<DependencyListResponse>
export async function removeDependency(taskId: number, blocksTaskId: number): Promise<void>

// Comments (nested under tasks)
export async function addComment(taskId: number, data: CreateCommentInput): Promise<CommentResponse>
export async function listComments(taskId: number): Promise<CommentResponse[]>
export async function deleteComment(commentId: number): Promise<void>
```

**Pattern follows existing conventions:**
- Returns typed responses
- Throws ApiClientError on failure
- Uses apiRequest() helper with 10s timeout
- Maps to REST endpoints: `/api/v1/projects`, `/api/v1/tasks/:id/comments`, etc.

### CLI Type Definitions

**Location:** `src/cli/api/types.ts`

**Current types:**
- TaskResponse
- ProjectResponse (already exists)
- CreateTaskInput
- UpdateTaskInput
- TaskFilters
- ApiErrorResponse

**New types needed:**

```typescript
// Project types (CreateProjectInput might exist, verify)
export interface CreateProjectInput {
  name: string;
  description?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
}

// Dependency types
export interface DependencyResponse {
  id: number;
  task_id: number;
  blocks_task_id: number;
  created_at: string;
}

export interface DependencyListResponse {
  blocks: DependencyResponse[];      // Tasks this task blocks
  blocked_by: DependencyResponse[];  // Tasks blocking this task
}

// Comment types
export interface CommentResponse {
  id: number;
  task_id: number;
  author: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface CreateCommentInput {
  author: string;
  content: string;
}
```

**Rationale:** CLI types mirror REST API responses but remain decoupled from server types. This allows CLI to evolve independently.

### Output Formatters

**Location:** `src/cli/output/formatters.ts`

**Current formatters:**
- formatStatus(status: string): string
- formatPriority(priority: string): string
- formatTaskTable(tasks: TaskResponse[]): string
- formatTaskDetail(task: TaskResponse): string

**New formatters needed:**

```typescript
// Project formatters
export function formatProjectTable(projects: ProjectResponse[]): string
export function formatProjectDetail(project: ProjectResponse): string

// Dependency formatters
export function formatDependencyTree(deps: DependencyListResponse): string
export function formatDependencyList(deps: DependencyResponse[]): string

// Comment formatters
export function formatCommentList(comments: CommentResponse[]): string
export function formatCommentDetail(comment: CommentResponse): string

// JSON formatter (global)
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
```

**Pattern:** Each resource gets table and detail formatters. Use `cli-table3` for tables, chalk for colors.

**Source:** [CLI best practices for --json flag](https://github.com/lirantal/nodejs-cli-apps-best-practices)

### MCP Tool Structure

**Location:** `src/mcp/tools/`

**Current files:**
- task-tools.ts (6 tools: create, get, update, list, delete, get_subtasks)
- dependency-tools.ts (3 tools: add, remove, get_dependencies)
- comment-tools.ts (3 tools: add, get_comments, delete)

**New file needed:**
- project-tools.ts (5 tools: create, get, update, list, delete)

**Registration pattern:**

```typescript
// src/mcp/tools/project-tools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProjectService } from '../../services/project.service.js';
import { CreateProjectSchema } from '../../schemas/task.schema.js';
import { z } from 'zod';
import { convertToMcpError } from '../errors.js';

export function registerProjectTools(
  server: McpServer,
  projectService: ProjectService
): void {
  server.registerTool(
    'create_project',
    {
      description: 'Create a new project',
      inputSchema: CreateProjectSchema,
    },
    async (args) => {
      try {
        const project = projectService.createProject(args);
        return {
          content: [
            {
              type: 'text',
              text: `Project created: "${project.name}" (ID: ${project.id})`,
            },
          ],
          structuredContent: project as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );

  // Additional tools: get_project, update_project, list_projects, delete_project
}
```

**Then update:** `src/mcp/server.ts`

```typescript
import { registerProjectTools } from './tools/project-tools.js';

export function createMcpServer(
  taskService: TaskService,
  projectService: ProjectService,
  dependencyService: DependencyService,
  commentService: CommentService
): McpServer {
  const server = new McpServer({
    name: 'wood-fired-bugs',
    version: '1.0.0',
  });

  // Register all tools
  registerTaskTools(server, taskService, projectService);
  registerProjectTools(server, projectService);  // NEW
  registerDependencyTools(server, dependencyService);
  registerCommentTools(server, commentService);

  return server;
}
```

**Pattern:** One tool file per resource, registerXxxTools() function, shares Zod schemas from `src/schemas/`.

## Architectural Patterns

### Pattern 1: Command File Structure

**What:** Each CLI command is a separate file exporting a Commander.js Command instance.

**When to use:** Always, for all new commands.

**Example:**
```typescript
// src/cli/commands/projects/create.ts
import { Command } from 'commander';
import { createProject } from '../../api/client.js';
import { formatProjectDetail } from '../../output/formatters.js';
import { handleError } from '../../output/error-handler.js';
import chalk from 'chalk';
import type { CreateProjectInput } from '../../api/types.js';

export const createProjectCommand = new Command('create')
  .description('Create a new project')
  .requiredOption('-n, --name <name>', 'Project name')
  .option('-d, --description <text>', 'Project description')
  .action(async (options) => {
    try {
      const input: CreateProjectInput = {
        name: options.name,
      };
      if (options.description) {
        input.description = options.description;
      }

      const project = await createProject(input);

      // Check for global --json flag
      const parentOpts = this.parent?.opts();
      if (parentOpts?.json) {
        console.log(JSON.stringify(project, null, 2));
        return;
      }

      console.log(chalk.green('Project created successfully'));
      console.log('');
      console.log(formatProjectDetail(project));
    } catch (error) {
      handleError(error);
    }
  });
```

**Trade-offs:**
- Pro: Clean separation, easy to test, follows existing pattern
- Pro: Commander.js automatically inherits options from parent
- Con: More files, but organized by folder

### Pattern 2: JSON Output Handling

**What:** Commands check for global `--json` flag and output raw JSON instead of formatted text.

**When to use:** All commands that return data.

**Example:**
```typescript
.action(async (options) => {
  try {
    const result = await someApiCall();

    // Check global --json flag from parent program
    if (this.parent?.opts().json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Otherwise, use formatted output
    console.log(formatSomeTable(result));
  } catch (error) {
    handleError(error);
  }
});
```

**Trade-offs:**
- Pro: Machine-readable output for scripting
- Pro: Industry standard (npm, git, gh all support --json)
- Con: Requires checking flag in every command action

**Source:** [CLI best practices: enable JSON output](https://github.com/lirantal/nodejs-cli-apps-best-practices)

### Pattern 3: MCP Tool Registration

**What:** Group related MCP tools in separate files with `registerXxxTools()` function.

**When to use:** When adding 3+ tools for a new resource type.

**Example:**
```typescript
// src/mcp/tools/project-tools.ts
export function registerProjectTools(
  server: McpServer,
  projectService: ProjectService
): void {
  server.registerTool('create_project', { ... }, async (args) => { ... });
  server.registerTool('get_project', { ... }, async (args) => { ... });
  server.registerTool('list_projects', { ... }, async (args) => { ... });
  server.registerTool('update_project', { ... }, async (args) => { ... });
  server.registerTool('delete_project', { ... }, async (args) => { ... });
}
```

**Trade-offs:**
- Pro: Mirrors existing pattern (task-tools.ts, dependency-tools.ts, comment-tools.ts)
- Pro: Clean separation of concerns
- Con: None, this is the established pattern

### Pattern 4: Interactive Prompts (Future)

**What:** For complex inputs, use interactive prompts instead of many flags.

**When to use:** When command requires 5+ inputs or conditional logic.

**Library recommendation:** `enquirer` (preferred) or `@inquirer/prompts`

**Example (future use):**
```typescript
import { prompt } from 'enquirer';

export const createTaskInteractive = new Command('create-interactive')
  .description('Create a task with interactive prompts')
  .action(async () => {
    try {
      const answers = await prompt([
        { type: 'input', name: 'title', message: 'Task title:' },
        { type: 'select', name: 'priority', message: 'Priority:', choices: ['low', 'medium', 'high', 'urgent'] },
        // ... more prompts
      ]);

      const task = await createTask(answers);
      console.log(formatTaskDetail(task));
    } catch (error) {
      handleError(error);
    }
  });
```

**Trade-offs:**
- Pro: Better UX for complex inputs
- Pro: Enquirer is lightweight (~4ms load time)
- Con: Not needed for v1.1 (all commands have simple inputs)
- Con: Requires new dependency

**Source:** [Enquirer vs Inquirer comparison](https://npm-compare.com/enquirer,inquirer,prompt,prompt-sync,prompts,readline-sync)

**Recommendation:** Defer interactive prompts until v1.2+. Current flag-based approach is sufficient.

## Data Flow

### CLI Request Flow

```
User Command
    ↓
Commander.js Parser
    ↓
Command Action Handler
    ↓
API Client Function (HTTP fetch)
    ↓
REST API Endpoint (Fastify)
    ↓
Service Layer (Zod validation)
    ↓
Repository Layer (SQL queries)
    ↓
SQLite Database
    ↓
Repository → Service → API → HTTP Response
    ↓
API Client (parse JSON)
    ↓
Format Output (table or JSON)
    ↓
Console Output
```

### MCP Request Flow

```
MCP Client (Claude, etc.)
    ↓
MCP Server (stdio transport)
    ↓
Tool Handler (registerTool)
    ↓
Service Layer (Zod validation)
    ↓
Repository Layer (SQL queries)
    ↓
SQLite Database
    ↓
Repository → Service → Tool Response
    ↓
MCP Client
```

### Key Differences

| Aspect | CLI | MCP |
|--------|-----|-----|
| Transport | HTTP (fetch) | stdio (process communication) |
| Service access | Via REST API | Direct function calls |
| Type safety | CLI types (decoupled) | Service types (shared schemas) |
| Validation | REST API validates | Service validates |
| Error handling | ApiClientError + HTTP codes | convertToMcpError() |
| Output format | Formatted text or JSON | Structured MCP response |

## Integration Points

### New Components Summary

| Component | Type | Location | Purpose |
|-----------|------|----------|---------|
| Project commands | CLI | `src/cli/commands/projects/*.ts` | Project CRUD operations |
| Dependency commands | CLI | `src/cli/commands/dependencies/*.ts` | Dependency management |
| Comment commands | CLI | `src/cli/commands/comments/*.ts` | Comment management |
| Task commands (new) | CLI | `src/cli/commands/tasks/*.ts` | Additional task operations (get, delete) |
| Project tools | MCP | `src/mcp/tools/project-tools.ts` | MCP project tools |
| API client extensions | Shared | `src/cli/api/client.ts` | HTTP client functions |
| Type definitions | CLI | `src/cli/api/types.ts` | CLI type interfaces |
| Formatters | CLI | `src/cli/output/formatters.ts` | Output formatting |
| Main program | CLI | `src/cli/bin/tasks.ts` | Command registration |
| MCP server | MCP | `src/mcp/server.ts` | Tool registration |

### Modified Components

| Component | Change | Reason |
|-----------|--------|--------|
| `src/cli/bin/tasks.ts` | Add subcommand groups (project, dep, comment) | Organize commands by resource |
| `src/cli/bin/tasks.ts` | Add global `--json` option | Machine-readable output |
| `src/mcp/server.ts` | Import and register project tools | Enable MCP project operations |
| `src/cli/api/client.ts` | Add 12+ new API functions | Support new CLI commands |
| `src/cli/api/types.ts` | Add dependency and comment types | Type safety for new features |
| `src/cli/output/formatters.ts` | Add formatters for projects, deps, comments | Consistent output formatting |

### No Changes Needed

These components work as-is:

- `src/services/` - Already implements all operations
- `src/repositories/` - Already has all data access
- `src/schemas/` - Already defines all Zod schemas
- `src/api/routes/` - Already exposes all REST endpoints
- `src/db/` - Database layer complete
- `src/cli/config/env.ts` - Environment config sufficient
- `src/cli/output/error-handler.ts` - Error handling sufficient

## Build Order

Recommended implementation sequence:

### Phase 1: Foundation (Build first)
1. Add new types to `src/cli/api/types.ts`
2. Add new API client functions to `src/cli/api/client.ts`
3. Add new formatters to `src/cli/output/formatters.ts`

### Phase 2: CLI Commands (Build second)
4. Create command folder structure (`src/cli/commands/projects/`, etc.)
5. Move existing commands to `src/cli/commands/tasks/`
6. Implement project commands
7. Implement dependency commands
8. Implement comment commands
9. Implement additional task commands (get, delete)

### Phase 3: Integration (Build third)
10. Update `src/cli/bin/tasks.ts` with subcommand groups
11. Add global `--json` option handling

### Phase 4: MCP Tools (Build fourth)
12. Create `src/mcp/tools/project-tools.ts`
13. Update `src/mcp/server.ts` to register project tools

### Phase 5: Testing (Build last)
14. Test all CLI commands with formatted output
15. Test all CLI commands with `--json` output
16. Test all MCP tools
17. Update documentation

**Rationale for ordering:**
- Foundation first: API client and types needed by all commands
- Commands second: Core functionality
- Integration third: Ties commands together
- MCP fourth: Independent from CLI, can be done in parallel
- Testing last: Validates everything works together

**Dependencies:**
- Phases 1-3 are sequential (each depends on previous)
- Phase 4 (MCP) can be done in parallel with Phase 2-3
- Phase 5 requires all previous phases

## Anti-Patterns

### Anti-Pattern 1: Direct Service Access from CLI

**What people do:** Import service classes into CLI commands for direct calls.

**Why it's wrong:**
- Breaks the architectural boundary (CLI should be HTTP client)
- Creates tight coupling between CLI and server
- Requires database connection in CLI process
- Makes CLI unusable if server changes implementation

**Do this instead:** Always call REST API via `src/cli/api/client.ts`. Let the server handle all business logic.

### Anti-Pattern 2: Duplicate Validation Logic

**What people do:** Add Zod validation or business logic in CLI commands.

**Why it's wrong:**
- Duplicates validation that exists in services
- CLI validation can get out of sync with server
- Harder to maintain (two places to update)

**Do this instead:** Let CLI commands be thin wrappers. Pass user input to API client, let server validate.

**Example (wrong):**
```typescript
// DON'T DO THIS
.action(async (options) => {
  // Validating in CLI
  const schema = z.object({ name: z.string().min(1) });
  const validated = schema.parse(options);  // ❌ Duplicate validation
  await createProject(validated);
});
```

**Example (correct):**
```typescript
// DO THIS
.action(async (options) => {
  // Just pass through, let server validate
  await createProject({ name: options.name });  // ✅ Server validates
});
```

### Anti-Pattern 3: Adding MCP Tools to Existing Tool Files

**What people do:** Add all new tools to `task-tools.ts` instead of creating `project-tools.ts`.

**Why it's wrong:**
- Violates single responsibility principle
- Makes files large and hard to navigate
- Doesn't scale as project grows

**Do this instead:** Create separate tool files per resource type (`project-tools.ts`, `dependency-tools.ts`, etc.).

### Anti-Pattern 4: Hardcoded Output Formatting

**What people do:** Put formatting logic directly in command action handlers.

**Why it's wrong:**
- Duplicates formatting across commands
- Hard to change output style consistently
- Mixing concerns (command logic + presentation)

**Do this instead:** Extract all formatting to `src/cli/output/formatters.ts`. Commands call formatters.

**Example (wrong):**
```typescript
// DON'T DO THIS
.action(async () => {
  const projects = await listProjects();
  // ❌ Formatting in action handler
  projects.forEach(p => console.log(`${p.id}: ${p.name}`));
});
```

**Example (correct):**
```typescript
// DO THIS
.action(async () => {
  const projects = await listProjects();
  // ✅ Use formatter
  console.log(formatProjectTable(projects));
});
```

### Anti-Pattern 5: Git-Style Subcommand Executables

**What people do:** Use Commander's git-style subcommands (separate executables).

**Why it's wrong:**
- Adds complexity (multiple entry points)
- Harder to share code between commands
- TypeScript build becomes more complex
- Not needed for this project size

**Do this instead:** Use action handlers with `.addCommand()` for all subcommands.

**Source:** [Commander.js subcommand documentation](https://github.com/tj/commander.js)

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Current (v1.1) | Monorepo with shared code. CLI commands in folders by resource. Single `tasks` binary. |
| v1.2-v2.0 | Add interactive prompts (enquirer) for complex commands. Add config file support (.tasksrc). Add command aliases. |
| v2.0+ | Consider splitting CLI into separate package. Add plugin system for custom commands. Add shell completions (bash, zsh). |

### Scaling Priorities

1. **First bottleneck:** Too many top-level commands.
   - **Fix:** Use subcommand groups (already planned: `tasks project create`)

2. **Second bottleneck:** Inconsistent output formats across commands.
   - **Fix:** Centralize formatters (already designed: `src/cli/output/formatters.ts`)

3. **Third bottleneck:** Complex multi-step operations requiring many flags.
   - **Fix:** Add interactive prompts with enquirer (defer to v1.2+)

## Files to Create

### CLI Commands (15 new files)

```
src/cli/commands/tasks/get.ts
src/cli/commands/tasks/delete.ts
src/cli/commands/projects/create.ts
src/cli/commands/projects/list.ts
src/cli/commands/projects/get.ts
src/cli/commands/projects/update.ts
src/cli/commands/projects/delete.ts
src/cli/commands/dependencies/add.ts
src/cli/commands/dependencies/list.ts
src/cli/commands/dependencies/remove.ts
src/cli/commands/comments/add.ts
src/cli/commands/comments/list.ts
src/cli/commands/comments/delete.ts
```

### MCP Tools (1 new file)

```
src/mcp/tools/project-tools.ts
```

### No New Folders

All new files fit into existing folder structure. Just reorganize `src/cli/commands/` into subfolders.

## Verification Checklist

Before marking integration complete:

- [ ] All CLI commands use api-client.ts (no direct service access)
- [ ] All CLI commands support `--json` flag
- [ ] All CLI types decoupled from server types
- [ ] All MCP tools follow registerXxxTools() pattern
- [ ] All formatters extracted to formatters.ts
- [ ] All REST endpoints have corresponding CLI commands
- [ ] All REST endpoints have corresponding MCP tools
- [ ] Command organization mirrors REST API structure
- [ ] No duplicate validation logic in CLI
- [ ] Error handling consistent across all commands

## Sources

- [Commander.js nested subcommands](https://maxschmitt.me/posts/nested-subcommands-commander-node-js)
- [Commander.js official repository](https://github.com/tj/commander.js)
- [Commander.js global options discussion](https://github.com/tj/commander.js/issues/476)
- [CLI architecture patterns](https://clig.dev/)
- [Node.js CLI best practices](https://github.com/lirantal/nodejs-cli-apps-best-practices)
- [Enquirer vs Inquirer comparison](https://npm-compare.com/enquirer,inquirer,prompt,prompt-sync,prompts,readline-sync)
- [CLI --json flag best practices](https://devcenter.heroku.com/articles/cli-style-guide)

---
*Architecture research for: Wood Fired Bugs CLI/MCP Parity Integration*
*Researched: 2026-02-13*
