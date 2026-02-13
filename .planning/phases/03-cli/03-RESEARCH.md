# Phase 3: CLI - Research

**Researched:** 2026-02-13
**Domain:** Node.js CLI with Commander.js, table formatting, and REST API client integration
**Confidence:** HIGH

## Summary

Phase 3 builds a command-line interface for task management using Commander.js 14.x, enabling human-friendly terminal access to the REST API built in Phase 2. The CLI follows git-style subcommand architecture (tasks create, tasks list, tasks update) with Commander.js handling argument parsing, validation, and help generation.

Commander.js is the de facto standard for Node.js CLIs with 25M+ weekly downloads, powering Vue CLI, Create React App, and thousands of production tools. It provides declarative command definition, automatic help generation, TypeScript support, and option validation with minimal boilerplate.

Output formatting uses cli-table3 for aligned, readable tables and chalk (version 4.x for CommonJS/TypeScript compatibility) for terminal colors. The CLI calls the Phase 2 REST API via native fetch (Node.js 18+ built-in) with proper error handling, exit codes, and API key authentication from environment variables.

**Primary recommendation:** Use Commander.js 14.x with TypeScript, cli-table3 for tables, chalk 4.x for colors, native fetch for API calls, and dotenv for configuration. Structure as bin/tasks.ts entry point with src/commands/* for each subcommand, src/api/* for REST client, and src/output/* for formatting utilities. Test with Vitest by calling program.parseAsync() with mock arguments.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| commander | 14.0.3 | CLI framework, argument parsing | De facto standard (25M+ weekly), TypeScript native, auto help generation, git-style subcommands |
| cli-table3 | latest | Table formatting | Actively maintained fork of cli-table (19M+ weekly), TypeScript definitions, column spanning, word wrap |
| chalk | 4.x | Terminal colors and styling | Mature standard (85M+ weekly), Chalk 5 is ESM-only - use 4.x for TypeScript/CommonJS projects |
| dotenv | latest | Environment variable loading | Standard for .env files (45M+ weekly), Node 20.6+ has native --env-file but dotenv works across versions |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @types/node | latest | Node.js TypeScript types | Required for TypeScript projects to use fetch, process, etc. |
| tsx | latest | TypeScript execution during development | Run CLI during development without building: `tsx bin/tasks.ts` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| commander | oclif, yargs, cac | oclif is heavyweight (plugin system), yargs verbose API, cac smaller but less adopted |
| cli-table3 | table, console-table-printer | table more complex API, console-table-printer less popular (700K vs 19M weekly) |
| chalk 4.x | chalk 5.x, kleur | Chalk 5 requires ESM (incompatible with most TS setups), kleur faster but fewer features |
| fetch (native) | axios, got, node-fetch | axios adds 11KB, got complex API, node-fetch deprecated in favor of native fetch |

**Installation:**
```bash
npm install commander cli-table3 chalk@4 dotenv
npm install -D @types/node tsx
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── bin/
│   └── tasks.ts              # CLI entry point with shebang
├── commands/
│   ├── create.ts             # tasks create command
│   ├── list.ts               # tasks list command
│   ├── update.ts             # tasks update command
│   └── delete.ts             # tasks delete command
├── api/
│   ├── client.ts             # REST API client wrapper
│   └── types.ts              # API request/response types
├── output/
│   ├── formatters.ts         # Table and color formatting
│   └── error-handler.ts      # CLI error display
└── config/
    └── env.ts                # Environment variable loading
```

### Pattern 1: Shebang and npm bin Configuration
**What:** Make CLI executable via npm/npx by adding shebang and package.json bin field
**When to use:** All Node.js CLI tools intended for command-line use
**Example:**
```typescript
// Source: https://medium.com/netscape/a-guide-to-create-a-nodejs-command-line-package-c2166ad0452e
// bin/tasks.ts
#!/usr/bin/env node
import { program } from 'commander';
import { createCommand } from '../commands/create';
import { listCommand } from '../commands/list';

program
  .name('tasks')
  .description('Task management CLI')
  .version('1.0.0');

program.addCommand(createCommand);
program.addCommand(listCommand);

program.parse();
```

```json
// package.json
{
  "name": "wood-fired-bugs",
  "bin": {
    "tasks": "./dist/bin/tasks.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/bin/tasks.ts"
  }
}
```

**Why `#!/usr/bin/env node`:** Not all operating systems have node in `/usr/bin/node`, but all have env. On Windows, npm creates a .cmd wrapper automatically if shebang is present.

### Pattern 2: Git-Style Subcommand Architecture
**What:** Organize related commands under a main command with subcommands (tasks create, tasks list)
**When to use:** CLIs with multiple operations on the same domain (CRUD operations)
**Example:**
```typescript
// Source: https://github.com/tj/commander.js
// commands/create.ts
import { Command } from 'commander';
import { createTask } from '../api/client';

export const createCommand = new Command('create')
  .description('Create a new task')
  .requiredOption('-t, --title <title>', 'Task title')
  .requiredOption('-p, --project <id>', 'Project ID', parseInt)
  .option('-d, --description <desc>', 'Task description')
  .option('-s, --status <status>', 'Task status', 'open')
  .option('--priority <priority>', 'Priority level', 'medium')
  .option('-a, --assignee <user>', 'Assignee username')
  .option('--due <date>', 'Due date (ISO8601)')
  .action(async (options) => {
    try {
      const task = await createTask({
        title: options.title,
        project_id: options.project,
        description: options.description,
        status: options.status,
        priority: options.priority,
        assignee: options.assignee,
        due_date: options.due,
      });
      console.log(chalk.green(`✓ Task created: #${task.id} - ${task.title}`));
    } catch (error) {
      handleError(error);
      process.exitCode = 1;
    }
  });
```

### Pattern 3: REST API Client with Error Handling
**What:** Wrapper around fetch that handles auth, base URL, error responses, and network failures
**When to use:** All CLI-to-API communication - centralizes auth, error handling, retry logic
**Example:**
```typescript
// Source: https://nodejs.org/en/learn/command-line/run-nodejs-scripts-from-the-command-line + Node.js fetch API
// api/client.ts
import { env } from '../config/env';

interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

class ApiClientError extends Error {
  constructor(public statusCode: number, public apiError: ApiError) {
    super(apiError.message);
    this.name = 'ApiClientError';
  }
}

async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${env.API_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': env.API_KEY,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.json() as ApiError;
    throw new ApiClientError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
}

export async function createTask(data: CreateTaskInput): Promise<Task> {
  return apiRequest<Task>('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function listTasks(filters: TaskFilters): Promise<Task[]> {
  const params = new URLSearchParams(filters as any);
  return apiRequest<Task[]>(`/api/v1/tasks?${params}`);
}
```

### Pattern 4: Table Formatting with cli-table3
**What:** Display task lists as aligned, readable tables with headers and column widths
**When to use:** List and search commands that return multiple tasks
**Example:**
```typescript
// Source: https://github.com/cli-table/cli-table3
// output/formatters.ts
import Table from 'cli-table3';
import chalk from 'chalk';

export function formatTaskTable(tasks: Task[]): string {
  const table = new Table({
    head: [
      chalk.bold('ID'),
      chalk.bold('Title'),
      chalk.bold('Status'),
      chalk.bold('Priority'),
      chalk.bold('Project'),
      chalk.bold('Assignee'),
      chalk.bold('Due Date'),
    ],
    colWidths: [6, 40, 12, 10, 15, 15, 12],
    wordWrap: true,
    style: {
      head: [], // Don't add color - we use chalk.bold above
      border: ['gray'],
    },
  });

  tasks.forEach((task) => {
    table.push([
      task.id.toString(),
      task.title,
      formatStatus(task.status),
      formatPriority(task.priority),
      task.project?.name || '-',
      task.assignee || '-',
      task.due_date ? formatDate(task.due_date) : '-',
    ]);
  });

  return table.toString();
}

function formatStatus(status: string): string {
  const colors: Record<string, (text: string) => string> = {
    open: chalk.blue,
    in_progress: chalk.yellow,
    done: chalk.green,
    closed: chalk.gray,
    blocked: chalk.red,
  };
  return (colors[status] || chalk.white)(status);
}

function formatPriority(priority: string): string {
  const colors: Record<string, (text: string) => string> = {
    urgent: chalk.red.bold,
    high: chalk.red,
    medium: chalk.yellow,
    low: chalk.gray,
  };
  return (colors[priority] || chalk.white)(priority);
}
```

### Pattern 5: Environment Configuration with dotenv
**What:** Load API base URL and key from .env file, with fallback defaults
**When to use:** All configuration that varies between dev/production
**Example:**
```typescript
// Source: https://github.com/motdotla/dotenv
// config/env.ts
import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({ path: path.join(__dirname, '../../.env') });

interface Env {
  API_BASE_URL: string;
  API_KEY: string;
}

function loadEnv(): Env {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.error(chalk.red('Error: API_KEY not set in .env file'));
    console.error('Copy .env.example to .env and set your API key');
    process.exit(1);
  }

  return {
    API_BASE_URL: process.env.API_BASE_URL || 'http://localhost:3000',
    API_KEY: apiKey,
  };
}

export const env = loadEnv();
```

```bash
# .env.example
API_BASE_URL=http://localhost:3000
API_KEY=your-api-key-here
```

### Pattern 6: Exit Code Handling
**What:** Set process.exitCode instead of calling process.exit() to allow graceful cleanup
**When to use:** All error conditions - network failures, validation errors, API errors
**Example:**
```typescript
// Source: https://nodejs.org/api/process.html + https://betterstack.com/community/questions/how-to-exit-in-node-js/
// output/error-handler.ts
import chalk from 'chalk';
import { ApiClientError } from '../api/client';

export function handleError(error: unknown): void {
  if (error instanceof ApiClientError) {
    console.error(chalk.red(`API Error (${error.statusCode}): ${error.message}`));
    if (error.statusCode === 401) {
      console.error(chalk.yellow('Check that API_KEY is set correctly in .env'));
    }
  } else if (error instanceof Error) {
    console.error(chalk.red(`Error: ${error.message}`));
  } else {
    console.error(chalk.red('Unknown error occurred'));
  }

  // Set exit code but don't force exit - allows cleanup and pending I/O
  process.exitCode = 1;
}
```

**Why process.exitCode over process.exit():** Calling process.exit() forces immediate termination, skipping pending I/O operations like logging to stderr. Setting process.exitCode allows Node to exit naturally after completing async operations.

### Pattern 7: Option Validation
**What:** Validate and transform CLI options before API calls
**When to use:** Commands with enums, dates, or numeric IDs
**Example:**
```typescript
// Source: https://betterstack.com/community/guides/scaling-nodejs/commander-explained/
// commands/create.ts
const VALID_STATUSES = ['open', 'in_progress', 'done', 'closed', 'blocked'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export const createCommand = new Command('create')
  .requiredOption('-t, --title <title>', 'Task title')
  .requiredOption('-p, --project <id>', 'Project ID', parseInt)
  .option('-s, --status <status>', 'Task status', 'open')
  .option('--priority <priority>', 'Priority level', 'medium')
  .action(async (options) => {
    // Validate enum values
    if (!VALID_STATUSES.includes(options.status)) {
      console.error(chalk.red(
        `Invalid status "${options.status}". ` +
        `Valid: ${VALID_STATUSES.join(', ')}`
      ));
      process.exitCode = 1;
      return;
    }

    if (!VALID_PRIORITIES.includes(options.priority)) {
      console.error(chalk.red(
        `Invalid priority "${options.priority}". ` +
        `Valid: ${VALID_PRIORITIES.join(', ')}`
      ));
      process.exitCode = 1;
      return;
    }

    // Validate parsed number
    if (isNaN(options.project)) {
      console.error(chalk.red('Project ID must be a number'));
      process.exitCode = 1;
      return;
    }

    try {
      const task = await createTask(options);
      console.log(chalk.green(`✓ Created task #${task.id}`));
    } catch (error) {
      handleError(error);
    }
  });
```

### Anti-Patterns to Avoid

- **Using chalk 5.x with TypeScript:** Chalk 5 is ESM-only and breaks in most TypeScript build setups. Use chalk 4.x for CommonJS/TypeScript compatibility.
- **Calling process.exit() in commands:** Forces immediate exit, skips pending I/O. Use process.exitCode = 1 instead.
- **Installing axios for simple REST calls:** Native fetch (Node 18+) handles HTTP well. Axios adds 11KB and complexity for marginal benefit in CLI.
- **Forgetting shebang:** CLI won't execute without #!/usr/bin/env node. Required for npm bin to work on Unix/Mac.
- **Displaying raw JSON:** CLI users expect human-readable tables with colors, not JSON blobs. Use cli-table3 and chalk.
- **Hardcoding API URL/key:** Use .env with dotenv so CLI works in dev (localhost:3000) and production (LAN server) without code changes.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Argument parsing | Custom process.argv loop, regex matching | Commander.js commands and options | Handles short/long flags, type conversion, required vs optional, help generation, unknown option errors. Edge cases: flag ordering, -- delimiter, negatable booleans. |
| Table alignment | String padding with spaces | cli-table3 | Handles column width calculation, word wrapping, Unicode characters, border styles. Manual padding breaks with multi-byte chars (emoji, Chinese). |
| Terminal colors | ANSI escape codes (\x1b[31m) | chalk | Handles color depth detection (8/256/16M), terminal capability detection, nested styles, strip-ansi for tests. Raw codes break on dumb terminals. |
| HTTP client | Manual http/https module usage | Native fetch (Node 18+) | Handles redirects, gzip decompression, timeouts, SSL verification, error parsing. http module requires manual stream handling. |
| .env file parsing | fs.readFileSync + string splitting | dotenv | Handles comments, quoted values, escape sequences, multiline values, variable expansion. Custom parser misses edge cases (= in values, quotes). |
| Date formatting | Locale-specific date strings | ISO8601 pass-through (display with Intl.DateTimeFormat if needed) | API returns ISO8601, keep it simple. Locale formatting causes timezone bugs. |

**Key insight:** CLI tools have well-solved problems. Commander.js, cli-table3, and chalk have collectively handled millions of edge cases (Unicode, terminal capabilities, Windows compatibility) that took years to discover.

## Common Pitfalls

### Pitfall 1: ESM vs CommonJS Mismatch with chalk 5.x
**What goes wrong:** CLI fails to import chalk with "ERR_REQUIRE_ESM" error, build fails with TypeScript
**Why it happens:** Chalk 5 is pure ESM and requires type: "module" in package.json. Most Node.js/TypeScript projects use CommonJS. TypeScript compiles to CommonJS by default.
**How to avoid:** Use chalk 4.x for TypeScript/CommonJS projects. Only use chalk 5.x if project is pure ESM with "type": "module".
**Warning signs:** Import errors during development, "require() of ES Module" error at runtime

**Source:** https://github.com/chalk/chalk (README explicitly warns about this)

### Pitfall 2: Missing API Key Validation
**What goes wrong:** CLI makes API calls without auth, gets 401 errors, unclear error message
**Why it happens:** Developer forgets to check env.API_KEY exists before making requests
**How to avoid:** Validate required env vars at startup in config/env.ts, exit with clear error if missing
**Warning signs:** "401 Unauthorized" errors, CLI works locally but fails after npm install

**Source:** https://betterstack.com/community/guides/scaling-nodejs/node-environment-variables/

### Pitfall 3: Synchronous Errors Not Caught
**What goes wrong:** CLI crashes with unhandled exception instead of showing user-friendly error
**Why it happens:** Command action is async but validation before API call throws synchronously
**How to avoid:** Wrap all command logic in try-catch, or use async action handlers and catch rejected promises
**Warning signs:** Stack traces printed to console, non-zero exit without error message

**Source:** https://stackoverflow.com/questions/7310521/node-js-best-practice-exception-handling + Node.js error handling patterns

### Pitfall 4: CLI Output Mixed with Debug Logs
**What goes wrong:** Formatted tables interspersed with [DEBUG] logs, breaks table alignment
**Why it happens:** Libraries or API client log to stdout, mixing with user-facing output
**How to avoid:** Write user output to stdout, errors/warnings to stderr. Silence debug logs unless --verbose flag set.
**Warning signs:** Broken table borders, log lines appearing mid-table

**Source:** https://12factor.net/logs + CLI design conventions

### Pitfall 5: Not Handling Network Failures
**What goes wrong:** CLI hangs indefinitely or crashes with ECONNREFUSED when API server down
**Why it happens:** fetch() throws on network errors but no timeout or retry configured
**How to avoid:** Set fetch timeout with AbortController, catch fetch errors, show "Cannot reach API server" message
**Warning signs:** CLI hangs when API offline, unclear error messages for connection refused

**Source:** https://developer.mozilla.org/en-US/docs/Web/API/AbortController

### Pitfall 6: Binary Not Executable After npm install
**What goes wrong:** users run `tasks create` and get "command not found" even after npm install
**Why it happens:** Missing shebang in bin/tasks.ts or incorrect path in package.json bin field
**How to avoid:** Always add #!/usr/bin/env node as first line, test with npm link before publishing
**Warning signs:** Works in dev (tsx bin/tasks.ts) but fails after npm install -g

**Source:** https://medium.com/netscape/a-guide-to-create-a-nodejs-command-line-package-c2166ad0452e

### Pitfall 7: Forgetting to Build TypeScript Before Running
**What goes wrong:** CLI runs old code after changes, commands don't work as expected
**Why it happens:** package.json bin points to dist/bin/tasks.js but developer forgot to run tsc
**How to avoid:** Use npm scripts: "dev": "tsx src/bin/tasks.ts" for dev, "build": "tsc" before publish
**Warning signs:** Code changes don't take effect, old bugs reappear

**Source:** Standard TypeScript project conventions

## Code Examples

Verified patterns from official sources:

### Complete CLI Entry Point
```typescript
// Source: https://github.com/tj/commander.js
// bin/tasks.ts
#!/usr/bin/env node
import { program } from 'commander';
import { createCommand } from '../commands/create';
import { listCommand } from '../commands/list';
import { updateCommand } from '../commands/update';
import { deleteCommand } from '../commands/delete';

program
  .name('tasks')
  .description('Wood Fired Bugs task management CLI')
  .version('1.0.0');

// Register subcommands
program.addCommand(createCommand);
program.addCommand(listCommand);
program.addCommand(updateCommand);
program.addCommand(deleteCommand);

// Parse arguments
program.parse(process.argv);
```

### List Command with Filters and Table Output
```typescript
// Source: https://github.com/tj/commander.js + https://github.com/cli-table/cli-table3
// commands/list.ts
import { Command } from 'commander';
import { listTasks } from '../api/client';
import { formatTaskTable } from '../output/formatters';
import { handleError } from '../output/error-handler';
import chalk from 'chalk';

export const listCommand = new Command('list')
  .description('List tasks with optional filters')
  .option('-p, --project <id>', 'Filter by project ID', parseInt)
  .option('-s, --status <status>', 'Filter by status')
  .option('-a, --assignee <user>', 'Filter by assignee')
  .option('--search <query>', 'Search by title/description')
  .action(async (options) => {
    try {
      const filters: Record<string, any> = {};

      if (options.project) filters.project_id = options.project;
      if (options.status) filters.status = options.status;
      if (options.assignee) filters.assignee = options.assignee;
      if (options.search) filters.search = options.search;

      const tasks = await listTasks(filters);

      if (tasks.length === 0) {
        console.log(chalk.yellow('No tasks found'));
        return;
      }

      console.log(formatTaskTable(tasks));
      console.log(chalk.gray(`\n${tasks.length} task(s) found`));
    } catch (error) {
      handleError(error);
    }
  });
```

### Update Command
```typescript
// Source: https://github.com/tj/commander.js
// commands/update.ts
import { Command } from 'commander';
import { updateTask } from '../api/client';
import { handleError } from '../output/error-handler';
import chalk from 'chalk';

export const updateCommand = new Command('update')
  .description('Update a task by ID')
  .argument('<id>', 'Task ID', parseInt)
  .option('-t, --title <title>', 'New title')
  .option('-d, --description <desc>', 'New description')
  .option('-s, --status <status>', 'New status')
  .option('--priority <priority>', 'New priority')
  .option('-a, --assignee <user>', 'New assignee')
  .option('--due <date>', 'New due date (ISO8601)')
  .action(async (id, options) => {
    try {
      // Build updates object from provided options
      const updates: Record<string, any> = {};

      if (options.title) updates.title = options.title;
      if (options.description) updates.description = options.description;
      if (options.status) updates.status = options.status;
      if (options.priority) updates.priority = options.priority;
      if (options.assignee) updates.assignee = options.assignee;
      if (options.due) updates.due_date = options.due;

      if (Object.keys(updates).length === 0) {
        console.error(chalk.yellow('No updates specified. Use --help for options.'));
        process.exitCode = 1;
        return;
      }

      const task = await updateTask(id, updates);
      console.log(chalk.green(`✓ Updated task #${task.id}: ${task.title}`));
    } catch (error) {
      handleError(error);
    }
  });
```

### Testing CLI Commands with Vitest
```typescript
// Source: https://circleci.com/blog/testing-command-line-applications/ + https://vitest.dev/guide/
// commands/create.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { createCommand } from './create';
import * as apiClient from '../api/client';

describe('create command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create task with required options', async () => {
    const mockTask = {
      id: 1,
      title: 'Test task',
      project_id: 1,
      status: 'open',
      priority: 'medium',
    };

    vi.spyOn(apiClient, 'createTask').mockResolvedValue(mockTask);

    const program = new Command();
    program.addCommand(createCommand);

    await program.parseAsync([
      'node',
      'test',
      'create',
      '--title', 'Test task',
      '--project', '1',
    ]);

    expect(apiClient.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Test task',
        project_id: 1,
      })
    );
  });

  it('should fail without required title option', async () => {
    const program = new Command();
    program.addCommand(createCommand);

    await expect(
      program.parseAsync(['node', 'test', 'create', '--project', '1'])
    ).rejects.toThrow();
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| yargs | Commander.js | 2015-2020 | Commander more concise API, better TypeScript, lighter weight. Yargs still viable but verbose. |
| axios for CLI HTTP | Native fetch (Node 18+) | 2022 (Node 18 LTS) | No dependencies needed, fetch built into Node. Axios still useful for complex cases (interceptors). |
| cli-table (original) | cli-table3 | 2017 | Original unmaintained, cli-table3 active with TypeScript, row/column spanning, better word wrap. |
| chalk 5.x (ESM) | chalk 4.x for TypeScript | 2021 (chalk 5 release) | Chalk 5 pure ESM incompatible with most TS setups. Use 4.x until ESM adoption widespread. |
| dotenv alternatives | dotenv OR Node 20.6+ --env-file | 2023 (Node 20.6) | Native --env-file good but dotenv works across Node versions, more flexible. |
| Inquirer.js for prompts | Not needed for this phase | - | Phase 3 is non-interactive (flags only). Inquirer useful for interactive prompts if needed later. |

**Deprecated/outdated:**
- **cli-table (original):** Use cli-table3 instead (https://github.com/cli-table/cli-table3)
- **node-fetch:** Native fetch built into Node 18+, no need for external library
- **yargs:** Commander.js more concise, better maintained, lighter
- **Inquirer prompts for non-interactive CLIs:** Use flags and options, not interactive prompts (slower, breaks scripting)

## Open Questions

1. **Interactive prompts vs flags-only**
   - What we know: Commander.js supports both. Phase 3 requirements specify "single command" creation.
   - What's unclear: Should we add interactive mode (Inquirer.js) for users who prefer prompts?
   - Recommendation: Start flags-only for scriptability. Add interactive mode in Phase 6 if Stuart requests it.

2. **Filter syntax for list command**
   - What we know: API supports multiple filters (project, status, assignee, search)
   - What's unclear: Should filters combine with AND or OR? How to express complex queries?
   - Recommendation: All filters combine with AND (most common use case). Complex queries use direct API calls.

3. **Output format options**
   - What we know: Requirements specify "readable table" for list output
   - What's unclear: Should we support JSON output with --json flag for scripting?
   - Recommendation: Add --json flag to list/update commands for pipe-ability. Default to human-readable tables.

4. **Network timeout configuration**
   - What we know: fetch() doesn't timeout by default, needs AbortController
   - What's unclear: What timeout is reasonable? Should it be configurable?
   - Recommendation: Default 10s timeout via AbortController. Add TIMEOUT_MS to .env for tuning if needed.

## Sources

### Primary (HIGH confidence)
- [Commander.js GitHub](https://github.com/tj/commander.js) - Official repository, examples, TypeScript definitions
- [Commander.js npm](https://www.npmjs.com/package/commander) - Current version, installation
- [cli-table3 GitHub](https://github.com/cli-table/cli-table3) - Table formatting library
- [chalk GitHub](https://github.com/chalk/chalk) - Terminal colors, ESM vs CommonJS guidance
- [Node.js Official Docs - CLI](https://nodejs.org/en/learn/command-line/run-nodejs-scripts-from-the-command-line) - Shebang, bin configuration
- [Node.js Process API](https://nodejs.org/api/process.html) - Exit codes, exitCode vs exit()
- [dotenv GitHub](https://github.com/motdotla/dotenv) - Environment variable loading

### Secondary (MEDIUM confidence)
- [The Definitive Guide to Commander.js | Better Stack](https://betterstack.com/community/guides/scaling-nodejs/commander-explained/) - Patterns and examples
- [Building a TypeScript CLI with Node.js and Commander - LogRocket](https://blog.logrocket.com/building-typescript-cli-node-js-commander/) - Project structure
- [Testing Commander.js CLIs - CircleCI](https://circleci.com/blog/testing-command-line-applications/) - Testing strategies
- [A guide to creating a NodeJS command-line package | Medium](https://medium.com/netscape/a-guide-to-create-a-nodejs-command-line-package-c2166ad0452e) - npm bin setup
- [Axios vs Fetch: Which Should You Use in 2026? | IProyal](https://iproyal.com/blog/axios-vs-fetch/) - HTTP client comparison
- [Managing Environment Variables in Node.js | Better Stack](https://betterstack.com/community/guides/scaling-nodejs/node-environment-variables/) - dotenv best practices
- [Node.js Exit Codes - GeeksforGeeks](https://www.geeksforgeeks.org/node-js/node-js-exit-codes/) - Exit code conventions
- [Best Practices for Node.js Error-handling | Toptal](https://www.toptal.com/developers/nodejs/node-js-error-handling) - Error handling patterns

### Tertiary (LOW confidence - marked for validation)
- [cli-table vs cli-table3 comparison | npm trends](https://npmtrends.com/cli-table-vs-cli-table3-vs-table-vs-tty-table) - Download statistics, needs verification
- WebSearch results on CLI architecture patterns - General guidance, verify against primary sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Commander.js, cli-table3, chalk are verified via official GitHub repos and npm pages
- Architecture patterns: HIGH - Patterns verified from official Commander.js docs, Node.js docs, and established CLI conventions
- REST client approach: HIGH - Native fetch documented in Node.js official docs, AbortController pattern standard
- Testing: MEDIUM - Vitest patterns verified but Commander.js testing examples limited in official docs
- Error handling: HIGH - Node.js process.exitCode documented in official API docs
- Environment config: HIGH - dotenv official docs, Node.js --env-file documented

**Research date:** 2026-02-13
**Valid until:** ~2026-03-13 (30 days - stable ecosystem, Commander.js and chalk mature libraries)
