# Phase 4: MCP Server - Research

**Researched:** 2026-02-13
**Domain:** Model Context Protocol (MCP) server implementation with TypeScript SDK, stdio transport, Zod validation
**Confidence:** MEDIUM-HIGH

## Summary

Phase 4 implements an MCP server that exposes Wood Fired Bugs task management functionality as native MCP tools, enabling Claude Code and other MCP clients to interact with tasks without HTTP knowledge. The implementation uses the @modelcontextprotocol/sdk TypeScript package (v1.x recommended for production; v2 anticipated Q1 2026) with stdio transport for local process-spawned integrations.

MCP servers register "tools" (functions callable by LLMs) with Zod schemas for input validation. The SDK validates inputs before calling handlers, automatically rejecting invalid data with structured error responses. This phase leverages existing Phase 1 infrastructure (TaskService, ProjectService, Zod schemas) by wrapping service calls in MCP tool handlers, ensuring validation logic is truly shared between REST API and MCP interfaces.

The primary transport for this use case is stdio (standard input/output), which is ideal for local integrations like Claude Desktop and CLI tools. Streamable HTTP is available for remote/networked scenarios but adds complexity not needed for this phase. Error handling uses McpError with ErrorCode enums to return structured, agent-readable responses that distinguish validation failures from business logic errors.

**Primary recommendation:** Use @modelcontextprotocol/sdk v1.x with StdioServerTransport, share Zod schemas from Phase 1 (src/schemas/task.schema.ts), wrap TaskService calls in tool handlers with try-catch blocks that convert custom errors (ValidationError, NotFoundError, BusinessError) to McpError responses.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @modelcontextprotocol/sdk | 1.x (v2 in Q1 2026) | MCP server/client libraries | Official TypeScript SDK for MCP, stdio/HTTP transports, tool/resource/prompt registration |
| zod | 4.x (compatible with 3.25+) | Input validation | Required peer dependency for MCP SDK; already used in Phase 1 for shared schemas |
| TypeScript | 5.7+ | Type safety | Matches Phase 1 setup; MCP SDK requires ES2022 target |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @modelcontextprotocol/node | latest | Node.js HTTP middleware | Only if implementing Streamable HTTP transport (not needed for stdio) |
| @modelcontextprotocol/express | latest | Express.js integration | Only if adding HTTP transport to existing Express REST API |
| vitest | latest | Testing framework | Already in Phase 1; use for MCP server unit/integration tests |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| stdio transport | Streamable HTTP | HTTP adds network complexity, session management, multiple client support - unnecessary for local Claude Desktop integration |
| Official SDK | Custom JSON-RPC implementation | SDK handles protocol compliance, serialization, error formats - custom would miss edge cases |
| Shared Zod schemas | Duplicate validation | Duplicating schemas violates DRY and breaks MCP-02 requirement for shared validation |

**Installation:**
```bash
npm install @modelcontextprotocol/sdk zod@4
# Zod 3.25+ also works due to SDK compatibility
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── mcp/
│   ├── server.ts              # MCP server initialization
│   ├── tools/                 # MCP tool handlers
│   │   ├── task-tools.ts      # create_task, get_task, update_task, list_tasks
│   │   └── project-tools.ts   # (future) project management tools
│   ├── errors.ts              # Error conversion utilities (custom -> McpError)
│   └── index.ts               # MCP server entry point (stdio transport)
├── schemas/                   # SHARED with REST API
│   └── task.schema.ts         # CreateTaskSchema, UpdateTaskSchema, TaskFiltersSchema
├── services/                  # SHARED with REST API
│   ├── task.service.ts        # Business logic layer
│   └── errors.ts              # ValidationError, NotFoundError, BusinessError
└── index.ts                   # createApp() - shared initialization
```

### Pattern 1: MCP Server Initialization with stdio
**What:** Create McpServer instance, register tools, connect stdio transport
**When to use:** Server entry point for local process-spawned integration (Claude Desktop)
**Example:**
```typescript
// Source: https://modelcontextprotocol.io/docs/develop/build-server
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "wood-fired-bugs",
  version: "1.0.0",
});

// Register tools (see Pattern 2)
registerTaskTools(server, taskService);

// Connect stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Server running on stdio"); // Use stderr, never stdout
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
```

### Pattern 2: Tool Registration with Shared Zod Schemas
**What:** Register MCP tool using existing Zod schema from Phase 1, handler wraps service call
**When to use:** Every MCP tool that corresponds to a REST API endpoint
**Example:**
```typescript
// Source: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md
import { CreateTaskSchema } from "../schemas/task.schema.js";
import type { TaskService } from "../services/task.service.js";

export function registerTaskTools(server: McpServer, taskService: TaskService) {
  server.registerTool(
    "create_task",
    {
      description: "Create a new task in a project",
      inputSchema: CreateTaskSchema, // SHARED schema from Phase 1
    },
    async (input) => {
      try {
        // TaskService.createTask() already validates with same schema
        const task = taskService.createTask(input);

        return {
          content: [
            {
              type: "text",
              text: `Task created successfully: ${task.title} (ID: ${task.id})`,
            },
          ],
          structuredContent: task, // Optional: structured data for agents
        };
      } catch (error) {
        // See Pattern 4 for error handling
        throw convertToMcpError(error);
      }
    }
  );
}
```

### Pattern 3: List/Query Tool with Filters
**What:** Tool that accepts optional filter parameters, returns array of results
**When to use:** list_tasks tool with project_id, status, assignee filters
**Example:**
```typescript
// Source: MCP best practices + Phase 1 TaskFiltersSchema
import { TaskFiltersSchema } from "../schemas/task.schema.js";

server.registerTool(
  "list_tasks",
  {
    description: "List tasks with optional filters",
    inputSchema: TaskFiltersSchema.partial(), // All filters optional
  },
  async (filters) => {
    try {
      const tasks = taskService.listTasks(filters);

      if (tasks.length === 0) {
        return {
          content: [
            { type: "text", text: "No tasks found matching filters." },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${tasks.length} task(s):\n${tasks.map(t =>
              `- [${t.id}] ${t.title} (${t.status})`
            ).join("\n")}`,
          },
        ],
        structuredContent: tasks,
      };
    } catch (error) {
      throw convertToMcpError(error);
    }
  }
);
```

### Pattern 4: Error Conversion (Custom Errors → McpError)
**What:** Convert Phase 1 custom errors (ValidationError, NotFoundError, BusinessError) to structured McpError responses
**When to use:** All tool handlers wrapping service calls
**Example:**
```typescript
// Source: https://mcpcat.io/guides/error-handling-custom-mcp-servers/
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ValidationError, NotFoundError, BusinessError } from "../services/errors.js";

export function convertToMcpError(error: unknown): McpError {
  if (error instanceof ValidationError) {
    return new McpError(
      ErrorCode.InvalidParams,
      `Validation failed: ${JSON.stringify(error.fieldErrors)}`,
      { fieldErrors: error.fieldErrors }
    );
  }

  if (error instanceof NotFoundError) {
    return new McpError(
      ErrorCode.InvalidRequest,
      error.message,
      { entity: error.entity, id: error.id }
    );
  }

  if (error instanceof BusinessError) {
    return new McpError(
      ErrorCode.InvalidRequest,
      error.message
    );
  }

  // Unknown errors - log to stderr but return generic message to client
  console.error("Unexpected error:", error);
  return new McpError(
    ErrorCode.InternalError,
    "An internal error occurred"
  );
}
```

### Pattern 5: Testing MCP Tools with In-Memory Pattern
**What:** Test MCP tools by passing server instance directly to client, eliminating subprocess issues
**When to use:** Unit and integration tests for MCP tools
**Example:**
```typescript
// Source: https://mcpcat.io/guides/writing-unit-tests-mcp-servers/
import { describe, it, beforeEach, expect } from "vitest";
import { createTestApp } from "../index.js"; // Uses :memory: database
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTaskTools } from "./mcp/tools/task-tools.js";

describe("MCP Task Tools", () => {
  let server: McpServer;
  let taskService: TaskService;

  beforeEach(async () => {
    const app = await createTestApp();
    taskService = app.taskService;

    server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerTaskTools(server, taskService);
  });

  it("should create task via MCP tool", async () => {
    // In-memory testing: call tool handler directly
    const result = await server.callTool("create_task", {
      title: "Test task",
      project_id: 1,
      created_by: "test"
    });

    expect(result.content[0].text).toContain("Task created successfully");
    expect(result.structuredContent).toHaveProperty("id");
  });

  it("should reject invalid task via MCP tool", async () => {
    await expect(
      server.callTool("create_task", { title: "" }) // Missing required fields
    ).rejects.toThrow(McpError);
  });
});
```

### Anti-Patterns to Avoid

- **Using console.log() in stdio servers:** Writes to stdout, corrupts JSON-RPC messages. Always use console.error() for logging.
- **Duplicating validation schemas:** MCP tools must use same Zod schemas as REST API to satisfy MCP-02. Never recreate schemas.
- **Missing await on server.connect():** If connect() isn't awaited, server exits before transport is ready. Host won't respond.
- **Throwing raw errors from handlers:** Unhandled exceptions don't provide structured error codes. Always convert to McpError.
- **Forgetting to build TypeScript:** Claude Desktop runs compiled .js files. Missing `npm run build` breaks server startup.
- **Using Streamable HTTP for local integration:** stdio is simpler, faster, and recommended for Claude Desktop. HTTP adds unnecessary complexity.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON-RPC protocol compliance | Custom message serialization, request/response handling | @modelcontextprotocol/sdk McpServer | SDK handles protocol versions, message framing, error formats, capability negotiation - custom misses edge cases |
| Input validation for MCP tools | Tool-specific validation functions, manual type checking | Shared Zod schemas from Phase 1 | Requirement MCP-02 mandates shared validation logic. Duplicating schemas breaks DRY and risks drift |
| Error response formatting | Manual error object construction with codes/messages | McpError with ErrorCode enum + conversion utility | SDK error types ensure JSON-RPC 2.0 compliance, agent-readable structure, proper error categorization |
| Transport layer (stdio/HTTP) | Custom stdin/stdout handling, HTTP server setup | StdioServerTransport, StreamableHTTPTransport | Transports handle message framing, connection lifecycle, protocol handshake - reimplementing introduces bugs |
| Schema to JSON Schema conversion | Manual zodToJsonSchema() calls | SDK automatic conversion | SDK converts Zod schemas to JSON Schema for tool definitions automatically; manual conversion unnecessary |

**Key insight:** MCP SDK abstracts JSON-RPC 2.0 protocol, transport management, and schema conversion. The value is in writing tool handlers that correctly wrap existing business logic (TaskService), not in reimplementing protocol mechanics. Shared validation schemas are the critical integration point between MCP and REST interfaces.

## Common Pitfalls

### Pitfall 1: Missing server.connect() or Exit Before Connection
**What goes wrong:** Server starts but Claude Desktop shows "connection failed" or no response, MCP tools not available
**Why it happens:** If `await server.connect(transport)` is missing, commented out, or code exits before this line, transport never establishes connection. Server appears to run but isn't listening.
**How to avoid:** Ensure main() function calls `await server.connect(transport)` and keeps process alive (no process.exit(), no immediate return). For stdio, server keeps running until stdin closes.
**Warning signs:** Server script exits immediately, no error logs in Claude logs, tools not visible in Claude Desktop connectors menu

**Source:** https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/

### Pitfall 2: console.log() Corruption in stdio Transport
**What goes wrong:** Claude Desktop shows "Invalid JSON received" or "Unexpected token" errors, server appears broken
**Why it happens:** stdio transport uses stdout for JSON-RPC messages. console.log() writes to stdout, inserting non-protocol text into message stream, breaking JSON parsing on client side.
**How to avoid:** NEVER use console.log() in stdio servers. Use console.error() which writes to stderr. Configure logging libraries to write to stderr or files, not stdout.
**Warning signs:** "Invalid JSON received" in Claude logs, intermittent connection failures, errors correlate with logging statements

**Source:** https://modelcontextprotocol.io/docs/develop/build-server

### Pitfall 3: Forgetting TypeScript Build Step
**What goes wrong:** Claude Desktop can't find server, shows "command not found" or "module not found" errors
**Why it happens:** Claude Desktop runs compiled JavaScript (.js files), not TypeScript (.ts files). Missing `npm run build` or pointing config to src/ instead of build/ means TypeScript source is referenced but uncompiled.
**How to avoid:** Always run `npm run build` before testing. Point Claude Desktop config to build/index.js, not src/index.ts. Add build step to package.json and document in README.
**Warning signs:** "Cannot find module" errors referencing .ts files, server works in development but fails in Claude Desktop

**Source:** https://modelcontextprotocol.io/docs/develop/build-server

### Pitfall 4: Zod Schema Version Mismatch (v3 vs v4)
**What goes wrong:** Runtime errors like "z.object is not a function" or "schema validation failed" despite correct code
**Why it happens:** MCP SDK uses Zod v4 internally but is compatible with Zod v3.25+. If project installs Zod v3.24 or earlier, API differences cause runtime failures. Multiple Zod versions in node_modules can also conflict.
**How to avoid:** Install Zod 4.x explicitly (`npm install zod@4`). If using Zod 3.x, ensure >=3.25. Run `npm ls zod` to check for version conflicts. Use package.json to enforce single version.
**Warning signs:** Zod-related runtime errors, "duplicate identifier" TypeScript errors, schema definitions work in tests but fail in MCP tools

**Source:** https://github.com/modelcontextprotocol/typescript-sdk

### Pitfall 5: Unstructured Error Responses Breaking Agent Understanding
**What goes wrong:** Agent sees errors but can't distinguish validation failures from not-found vs internal errors, retries pointlessly or gives up too soon
**Why it happens:** Throwing raw Error objects or returning generic "error occurred" messages loses error categorization. Agent needs ErrorCode to decide whether to retry, request different input, or abort.
**How to avoid:** Always convert custom errors to McpError with appropriate ErrorCode (InvalidParams for validation, InvalidRequest for business logic, InternalError for unexpected). Include details field with actionable context.
**Warning signs:** Agent makes same invalid request repeatedly, agent doesn't retry transient errors, vague "something went wrong" messages in Claude

**Source:** https://mcpcat.io/guides/error-handling-custom-mcp-servers/

### Pitfall 6: Tool Handler Failures Crashing Server
**What goes wrong:** Single invalid request or unexpected error crashes entire MCP server, disconnecting all tools
**Why it happens:** Unhandled promise rejections or uncaught exceptions in async tool handlers propagate to top level, crashing Node.js process. SDK doesn't catch these automatically.
**How to avoid:** Wrap all tool handler logic in try-catch blocks. Convert known errors to McpError (see Pattern 4). Catch unknown errors, log to stderr with stack trace, return generic McpError(InternalError). Add process-level handlers for uncaughtException/unhandledRejection as last resort.
**Warning signs:** Server stops responding after first error, Claude Desktop shows "connection lost", server process exits unexpectedly

**Source:** https://www.mcpevals.io/blog/debugging-mcp-servers-tips-and-best-practices

## Code Examples

Verified patterns from official sources:

### Complete MCP Server Entry Point
```typescript
// Source: https://modelcontextprotocol.io/docs/develop/build-server
// src/mcp/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp } from "../index.js";
import { registerTaskTools } from "./tools/task-tools.js";

async function main() {
  // Initialize application (database, services)
  const app = await createApp("./data/tasks.db");

  // Create MCP server
  const server = new McpServer({
    name: "wood-fired-bugs",
    version: "1.0.0",
  });

  // Register tools
  registerTaskTools(server, app.taskService, app.projectService);

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (never stdout in stdio transport)
  console.error("Wood Fired Bugs MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
```

### Tool Handlers with Service Integration
```typescript
// Source: MCP patterns + Phase 1 service layer
// src/mcp/tools/task-tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TaskService } from "../../services/task.service.js";
import type { ProjectService } from "../../services/project.service.js";
import { CreateTaskSchema, UpdateTaskSchema, TaskFiltersSchema } from "../../schemas/task.schema.js";
import { z } from "zod";
import { convertToMcpError } from "../errors.js";

export function registerTaskTools(
  server: McpServer,
  taskService: TaskService,
  projectService: ProjectService
) {
  // CREATE TASK
  server.registerTool(
    "create_task",
    {
      description: "Create a new task in a project",
      inputSchema: CreateTaskSchema,
    },
    async (input) => {
      try {
        const task = taskService.createTask(input);
        return {
          content: [
            {
              type: "text",
              text: `Task created: ${task.title} (ID: ${task.id}, Status: ${task.status})`,
            },
          ],
          structuredContent: task,
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );

  // GET TASK
  server.registerTool(
    "get_task",
    {
      description: "Get a task by ID",
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
    },
    async ({ id }) => {
      try {
        const task = taskService.getTask(id);
        return {
          content: [
            {
              type: "text",
              text: `Task: ${task.title}\nStatus: ${task.status}\nPriority: ${task.priority}\nDescription: ${task.description || "No description"}`,
            },
          ],
          structuredContent: task,
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );

  // UPDATE TASK
  server.registerTool(
    "update_task",
    {
      description: "Update an existing task",
      inputSchema: z.object({
        id: z.number().int().positive(),
        updates: UpdateTaskSchema,
      }),
    },
    async ({ id, updates }) => {
      try {
        const task = taskService.updateTask(id, updates);
        return {
          content: [
            {
              type: "text",
              text: `Task ${task.id} updated: ${task.title} (${task.status})`,
            },
          ],
          structuredContent: task,
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );

  // LIST TASKS
  server.registerTool(
    "list_tasks",
    {
      description: "List tasks with optional filters (project_id, status, assignee, tags, due_before, due_after, search)",
      inputSchema: TaskFiltersSchema,
    },
    async (filters) => {
      try {
        const tasks = taskService.listTasks(filters);

        if (tasks.length === 0) {
          return {
            content: [
              { type: "text", text: "No tasks found matching filters." },
            ],
          };
        }

        const taskList = tasks.map(t =>
          `- [${t.id}] ${t.title} (${t.status}, priority: ${t.priority})`
        ).join("\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${tasks.length} task(s):\n${taskList}`,
            },
          ],
          structuredContent: tasks,
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );
}
```

### Error Conversion Utility
```typescript
// Source: https://www.mcpevals.io/blog/mcp-error-codes
// src/mcp/errors.ts
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ValidationError, NotFoundError, BusinessError } from "../services/errors.js";

export function convertToMcpError(error: unknown): McpError {
  // Known custom errors from Phase 1
  if (error instanceof ValidationError) {
    return new McpError(
      ErrorCode.InvalidParams,
      "Validation failed",
      { fieldErrors: error.fieldErrors }
    );
  }

  if (error instanceof NotFoundError) {
    return new McpError(
      ErrorCode.InvalidRequest,
      error.message,
      { entity: error.entity, id: error.id }
    );
  }

  if (error instanceof BusinessError) {
    return new McpError(
      ErrorCode.InvalidRequest,
      error.message
    );
  }

  // Unknown errors - log full details to stderr, return generic to client
  console.error("Unexpected error in MCP tool handler:", error);
  if (error instanceof Error) {
    console.error("Stack trace:", error.stack);
  }

  return new McpError(
    ErrorCode.InternalError,
    "An internal error occurred. Please try again or contact support."
  );
}
```

### Claude Desktop Configuration
```json
// Source: https://modelcontextprotocol.io/docs/develop/build-server
// ~/.config/Claude/claude_desktop_config.json (Linux)
// ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
// %APPDATA%\Claude\claude_desktop_config.json (Windows)
{
  "mcpServers": {
    "wood-fired-bugs": {
      "command": "node",
      "args": [
        "/absolute/path/to/wood-fired-bugs/build/mcp/index.js"
      ]
    }
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| HTTP+SSE transport | Streamable HTTP transport | 2025 Q4 | HTTP+SSE deprecated, Streamable HTTP is single-endpoint modern standard for remote MCP |
| MCP SDK v1.x | MCP SDK v2 (pre-alpha) | Q1 2026 expected | v1.x recommended for production until v2 stable; breaking changes anticipated |
| Zod v3 | Zod v4 | 2024 | MCP SDK uses Zod v4 internally but compatible with v3.25+; prefer v4 for new projects |
| Custom validation in tools | Shared Zod schemas | Best practice 2025+ | MCP tools should reuse existing validation schemas to satisfy DRY and ensure consistency |

**Deprecated/outdated:**
- **HTTP+SSE transport:** Legacy transport maintained for backwards compatibility only. New implementations should use stdio (local) or Streamable HTTP (remote).
- **Manual zodToJsonSchema() conversion:** SDK handles automatic conversion of Zod schemas to JSON Schema for tool definitions. Manual conversion unnecessary.
- **Zod v3.24 and earlier:** MCP SDK requires Zod v3.25+ for compatibility. Use Zod v4 to avoid peer dependency warnings.

## Open Questions

1. **MCP SDK v2 migration timeline**
   - What we know: v2 is pre-alpha on main branch, v1.x recommended for production, stable v2 expected Q1 2026
   - What's unclear: Breaking changes in v2, migration path from v1 to v2, when to adopt v2 for this project
   - Recommendation: Build Phase 4 on v1.x (stable, production-ready). Monitor v2 release notes. Plan migration task after v2 stable release.

2. **Testing MCP tools with in-memory pattern**
   - What we know: In-memory testing pattern passes server instance directly to client, eliminating subprocess issues
   - What's unclear: Whether official SDK provides test utilities or if we need custom test client setup
   - Recommendation: Use vitest with direct tool handler invocation for unit tests (server.callTool()). For integration tests, consider MCP Inspector or building minimal test client with @modelcontextprotocol/client.

3. **Structured content vs text content balance**
   - What we know: Tools can return both text (for user display) and structuredContent (for agent processing)
   - What's unclear: Best practices for when to include structuredContent vs text-only, whether agents prefer structured data
   - Recommendation: Return both text (human-readable summary) and structuredContent (full object) for create/update/get operations. Text-only for lists if array is in text. Monitor agent behavior and adjust.

4. **Error detail verbosity for agents**
   - What we know: McpError supports optional data field for additional error context
   - What's unclear: How much detail agents need (field-level errors, stack traces, suggestions), risk of information leakage
   - Recommendation: Include fieldErrors for validation, entity/id for not-found, generic message for internal errors. Never expose stack traces or internal paths to client. Log full details to stderr.

## Sources

### Primary (HIGH confidence)
- [Model Context Protocol TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk) - Official SDK repository, docs, examples
- [Build an MCP server - Model Context Protocol](https://modelcontextprotocol.io/docs/develop/build-server) - Official tutorial with TypeScript examples
- [MCP TypeScript SDK server documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) - Server API reference
- [@modelcontextprotocol/sdk npm package](https://www.npmjs.com/package/@modelcontextprotocol/sdk) - Package information, peer dependencies

### Secondary (MEDIUM confidence)
- [MCP Transport Protocols: stdio vs SSE vs StreamableHTTP](https://mcpcat.io/guides/comparing-stdio-sse-streamablehttp/) - Transport comparison and use cases
- [Error Handling in MCP Servers - Best Practices Guide](https://mcpcat.io/guides/error-handling-custom-mcp-servers/) - Error handling patterns, McpError usage
- [Add Custom Tools to TypeScript MCP Servers](https://mcpcat.io/guides/adding-custom-tools-mcp-server-typescript/) - Tool registration patterns
- [Unit Testing MCP Servers - Complete Testing Guide](https://mcpcat.io/guides/writing-unit-tests-mcp-servers/) - In-memory testing pattern
- [MCP Error Codes](https://www.mcpevals.io/blog/mcp-error-codes) - ErrorCode enum reference
- [Implementing model context protocol (MCP): Tips, tricks and pitfalls](https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/) - Common mistakes and solutions
- [Debugging Model Context Protocol (MCP) Servers](https://www.mcpevals.io/blog/debugging-mcp-servers-tips-and-best-practices) - Debugging strategies
- [MCP Server Transports: STDIO, Streamable HTTP & SSE](https://docs.roocode.com/features/mcp/server-transports) - Transport details and configuration

### Tertiary (LOW confidence - marked for validation)
- Various Medium blog posts on MCP server development - General guidance, verify patterns against official docs
- GitHub issues in typescript-sdk repository - Known bugs, workarounds, feature requests

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - @modelcontextprotocol/sdk is official, Zod v4 requirement verified in package.json peer dependencies
- Architecture patterns: MEDIUM-HIGH - Patterns verified via official docs and examples, but MCP is newer technology (2024-2025) with fewer production case studies
- Error handling: MEDIUM-HIGH - McpError and ErrorCode documented in official SDK, conversion pattern from secondary sources but logical
- Testing patterns: MEDIUM - In-memory pattern documented in community guides, official SDK examples show testing but less comprehensive
- stdio vs HTTP transport: HIGH - Official docs clearly state stdio for local, Streamable HTTP for remote
- Shared validation requirement: HIGH - MCP-02 explicit requirement, Zod schema reuse verified as standard TypeScript pattern

**Research date:** 2026-02-13
**Valid until:** ~2026-02-27 (14 days - MCP SDK v2 anticipated Q1 2026, technology evolving rapidly, may need refresh for v2 migration)
