# Phase 11: MCP Server Verification - Research

**Researched:** 2026-02-13
**Domain:** MCP (Model Context Protocol) stdio transport compliance and verification
**Confidence:** HIGH

## Summary

Phase 11 focuses on verifying that the existing MCP server (built in Phases 4 and 9) is fully compliant with the stdio transport protocol. The primary concern is stdout pollution—any non-JSON-RPC output written to stdout will corrupt the protocol stream and cause connection failures (error -32000). The project already uses `console.error()` for all MCP server logging, which is the correct approach, but a comprehensive audit is needed to confirm zero stdout violations across all 25 tools.

The MCP server uses @modelcontextprotocol/sdk v1.26.0 (current stable) with Node.js stdio transport. The codebase has 102 TypeScript files with 85 instances of `console.*` usage across 26 files. The MCP entry point (`src/mcp/index.ts`) correctly uses `console.error()` for all logging, including startup messages and error handlers. However, some tool files (like `health-tools.ts`) also contain `console.error()` calls that need verification.

**Primary recommendation:** Audit all MCP-related files for stdout pollution, create automated tests that verify JSON-RPC-only stdout, and test end-to-end with Claude Code's `/mcp` command and MCP Inspector.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @modelcontextprotocol/sdk | 1.26.0 | MCP protocol implementation | Official TypeScript SDK from Anthropic, current stable release (v2 is pre-alpha) |
| Node.js | 16+ | Runtime environment | Required for @modelcontextprotocol/sdk |
| better-sqlite3 | 12.6.2 | Database for health checks | Already used in project |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @modelcontextprotocol/inspector | latest | Visual testing tool | Development/debugging only—verifies stdio compliance |
| vitest | 4.0.18 | Test framework | Already in project—use for automated verification tests |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| console.error() | Pino logger | Already have pino-pretty in devDeps for API server, but MCP server intentionally avoids it for simplicity. Console.error() is sufficient for stdio transport. |
| MCP Inspector | Manual stdio piping | Inspector provides better UX and protocol validation, but manual piping works for CI/CD automation |

**Installation:**
```bash
# Inspector for manual testing (dev only)
npx @modelcontextprotocol/inspector node dist/mcp/index.js

# No additional dependencies needed—server already uses correct SDK version
```

## Architecture Patterns

### Recommended Audit Structure
```
Phase 11 verification audit:
├── Code audit: grep console.log in src/mcp/
├── Automated tests: verify stdout is JSON-RPC only
├── Manual testing: MCP Inspector + Claude Code /mcp
└── Documentation: update README with stdio compliance notes
```

### Pattern 1: Stdio Transport Logging Discipline
**What:** All logging MUST go to stderr, stdout is reserved exclusively for JSON-RPC 2.0 messages
**When to use:** Every stdio-based MCP server (which this project is)
**Example:**
```typescript
// Source: https://modelcontextprotocol.io/docs/develop/build-server
// ❌ WRONG - Breaks protocol
console.log("Server started");

// ✅ CORRECT - Safe for stdio
console.error("Server started");

// ✅ CORRECT - Also safe
process.stderr.write("Debug info\n");
```

### Pattern 2: MCP Server Error Handling
**What:** Uncaught errors should log to stderr and exit with non-zero code
**When to use:** Global error handlers in MCP server entry point
**Example:**
```typescript
// Source: Existing src/mcp/index.ts (already correct)
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);  // ✅ stderr
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);  // ✅ stderr
  process.exit(1);
});
```

### Pattern 3: MCP Tool Error Logging
**What:** Tool handlers should use convertToMcpError() to convert domain errors, log unexpected errors to stderr
**When to use:** Inside tool handlers when catching errors
**Example:**
```typescript
// Source: Existing src/mcp/errors.ts (already correct)
export function convertToMcpError(error: unknown): McpError {
  if (error instanceof ValidationError) {
    return new McpError(ErrorCode.InvalidParams, 'Validation failed', { fieldErrors: error.fieldErrors });
  }

  // Unknown errors: log to stderr, return sanitized error
  console.error('Unexpected error in MCP handler:', error);  // ✅ stderr
  return new McpError(ErrorCode.InternalError, 'An internal error occurred');
}
```

### Pattern 4: Testing Stdio Compliance
**What:** Automated test that spawns MCP server and verifies stdout contains only JSON-RPC
**When to use:** CI/CD pipeline, pre-commit hooks
**Example:**
```typescript
// Pattern for verification test (to be implemented)
import { spawn } from 'child_process';

test('MCP server stdout contains only JSON-RPC', async () => {
  const server = spawn('node', ['dist/mcp/index.js']);

  let stdoutData = '';
  server.stdout.on('data', (data) => {
    stdoutData += data.toString();
  });

  // Send initialize request
  server.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialize',
    params: { protocolVersion: '1.0', capabilities: {} },
    id: 1
  }) + '\n');

  await new Promise(resolve => setTimeout(resolve, 500));

  // Every line on stdout should be valid JSON-RPC
  const lines = stdoutData.trim().split('\n');
  for (const line of lines) {
    const parsed = JSON.parse(line);  // Should not throw
    expect(parsed.jsonrpc).toBe('2.0');
  }

  server.kill();
});
```

### Anti-Patterns to Avoid
- **console.log() anywhere in MCP server code:** Corrupts JSON-RPC stream, causes error -32000
- **Startup banners to stdout:** Even a "Server ready" message breaks the protocol
- **Debug print statements:** Use stderr or remove entirely for production
- **Unconfigured logging libraries:** If adding a logger, ensure it writes to stderr/files only

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON-RPC transport | Custom stdio reader/writer | @modelcontextprotocol/sdk StdioServerTransport | SDK handles message framing, error handling, protocol versioning |
| MCP protocol validation | Manual tool registration | @modelcontextprotocol/sdk McpServer | SDK validates schemas, handles capability negotiation |
| Stdio compliance testing | Manual stdout inspection | @modelcontextprotocol/inspector | Inspector validates protocol compliance, provides visual debugging |

**Key insight:** The MCP SDK handles all the complex protocol details (message framing, capability negotiation, error codes). Your only job is to keep stdout clean and implement tool handlers.

## Common Pitfalls

### Pitfall 1: Stdout Pollution from Imported Libraries
**What goes wrong:** Third-party library writes to stdout during initialization
**Why it happens:** Libraries like some ORMs log startup messages to stdout by default
**How to avoid:**
- Audit all imports for stdout usage (especially database libraries, loggers)
- Set environment variables to disable logging (e.g., `NODE_ENV=production`)
- Test server startup with stdout inspection
**Warning signs:** Server works locally but fails with error -32000 in Claude Desktop/Claude Code

### Pitfall 2: Error Stack Traces to Stdout
**What goes wrong:** Unhandled errors print stack traces to stdout
**Why it happens:** Default Node.js behavior prints uncaught errors to stdout
**How to avoid:**
- Install global error handlers that log to stderr (already done in src/mcp/index.ts)
- Use try/catch in tool handlers with convertToMcpError() (already done)
- Test error paths to ensure they don't corrupt stdout
**Warning signs:** Server works for happy paths but crashes on errors

### Pitfall 3: Development vs Production Logging
**What goes wrong:** Debug logging enabled in development writes to stdout
**Why it happens:** Developers add console.log() for debugging and forget to remove it
**How to avoid:**
- Use grep/linting to detect console.log in MCP code
- Add pre-commit hook to block console.log in src/mcp/
- Use environment-based logging (stderr only)
**Warning signs:** Server works in production but breaks when NODE_ENV=development

### Pitfall 4: Health Check Database Errors
**What goes wrong:** Database health check failure logs error to stdout
**Why it happens:** Confusion about where to log errors
**How to avoid:**
- All error logging must use console.error() (stderr)
- Return error status in tool response, don't log to stdout
- Already implemented correctly in src/mcp/tools/health-tools.ts (uses console.error)
**Warning signs:** Health check tool returns error and server becomes unresponsive

## Code Examples

Verified patterns from official sources and existing codebase:

### MCP Server Entry Point (Correct)
```typescript
// Source: Existing src/mcp/index.ts
async function main() {
  const dbPath = process.env.DB_PATH || './data/tasks.db';
  const app = await createApp(dbPath);
  const server = createMcpServer(app.taskService, app.projectService, app.dependencyService, app.commentService, app.db);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // ✅ CORRECT - Log to stderr
  console.error('Wood Fired Bugs MCP Server running on stdio');
}

// ✅ CORRECT - Error handlers use stderr
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});
```

### Tool Error Handling (Correct)
```typescript
// Source: Existing src/mcp/errors.ts
export function convertToMcpError(error: unknown): McpError {
  if (error instanceof ValidationError) {
    return new McpError(ErrorCode.InvalidParams, 'Validation failed', { fieldErrors: error.fieldErrors });
  }

  // ✅ CORRECT - Log unexpected errors to stderr
  console.error('Unexpected error in MCP handler:', error);
  return new McpError(ErrorCode.InternalError, 'An internal error occurred');
}
```

### Health Check Tool (Correct)
```typescript
// Source: Existing src/mcp/tools/health-tools.ts
try {
  db.prepare('SELECT 1').get();
  return { content: [{ type: 'text', text: `Service Status: healthy\n...` }] };
} catch (error) {
  // ✅ CORRECT - Log error to stderr, return unhealthy status
  console.error('Database health check failed:', error);
  return { content: [{ type: 'text', text: `Service Status: unhealthy\n...` }] };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| console.log everywhere | console.error for stdio servers | MCP spec v1.0 (2024) | Strict stdout discipline required |
| Manual JSON-RPC handling | @modelcontextprotocol/sdk | SDK v1.0 (Dec 2024) | Simplified server development |
| Ad-hoc testing | MCP Inspector tool | Inspector released early 2025 | Visual protocol debugging |
| SDK v1.x (stable) | SDK v2.x (pre-alpha) | Q1 2026 (planned) | v1.26.0 recommended for production until v2 stable |

**Deprecated/outdated:**
- Manual stdout/stdin handling: Use SDK's StdioServerTransport instead
- Custom error codes: Use McpError with standard ErrorCode enum
- V0 protocol: All servers should use protocol version 1.0+

## Verification Strategy

### Code Audit Checklist
- [x] Entry point (src/mcp/index.ts): Uses console.error() only ✅
- [ ] Tool handlers (src/mcp/tools/*.ts): Verify console.error() only
- [ ] Error handlers (src/mcp/errors.ts): Uses console.error() only ✅
- [ ] Server factory (src/mcp/server.ts): No console output ✅
- [ ] Service layer (src/services/*.ts): No console output (not in MCP scope)
- [ ] Grep audit: Find all console.log instances, verify none in src/mcp/

### Automated Testing
- [ ] Create test that spawns MCP server and parses stdout
- [ ] Verify every line is valid JSON-RPC 2.0
- [ ] Test error paths to ensure no stack traces on stdout
- [ ] Test all 25 tools to verify no stdout pollution

### Manual Testing
- [ ] Test with MCP Inspector: `npx @modelcontextprotocol/inspector node dist/mcp/index.js`
- [ ] Verify tools list correctly
- [ ] Invoke each tool category (task, project, dependency, comment, health)
- [ ] Test with Claude Code `/mcp` command
- [ ] Verify no transport errors (error -32000)

## Testing Tools

### MCP Inspector
**What:** Official visual testing tool from Anthropic
**How to use:**
```bash
# Build server first
npm run build

# Launch inspector
npx @modelcontextprotocol/inspector node dist/mcp/index.js
```
**What it validates:**
- Protocol compliance (JSON-RPC 2.0 format)
- Tool discovery and invocation
- Request/response cycles
- Error handling
- Stdout cleanliness (implicitly—connection works = no stdout pollution)

### Claude Code Integration
**How to test:**
```bash
# In Claude Code CLI
claude mcp list              # Should show wood-fired-bugs server
/mcp                          # Check server status
/mcp use wood-fired-bugs      # Select server
# Then invoke tools naturally: "Create a task called 'test'"
```

**What it validates:**
- Real-world client integration
- Tool invocation end-to-end
- Error handling in production-like environment

### Manual Stdio Testing
**How to test:**
```bash
# Pipe JSON-RPC to server stdin, read stdout
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"1.0","capabilities":{}},"id":1}' | node dist/mcp/index.js

# Expected: Valid JSON-RPC response on stdout
# Expected: Startup message on stderr only
```

## Open Questions

1. **Should we add pre-commit hooks to block console.log in src/mcp/?**
   - What we know: Project already has husky/lint-staged infrastructure potential
   - What's unclear: Whether this adds too much friction to development workflow
   - Recommendation: Yes, add ESLint rule to disallow console.log in src/mcp/ directory

2. **Should health check tool test MCP server connectivity?**
   - What we know: Current health check tests database only
   - What's unclear: Whether MCP server should self-test its stdio transport
   - Recommendation: No—stdio transport can't self-test without breaking the protocol. Keep health check database-focused.

3. **Should we log successful tool invocations to stderr?**
   - What we know: Currently only errors are logged to stderr
   - What's unclear: Whether success logging helps debugging or adds noise
   - Recommendation: No for production, optional for development via environment variable

## Sources

### Primary (HIGH confidence)
- [Build an MCP server - Model Context Protocol](https://modelcontextprotocol.io/docs/develop/build-server) - Official MCP documentation on stdio logging requirements
- [@modelcontextprotocol/sdk - npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) - Current stable version is 1.26.0
- [GitHub - modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) - v1.26.0 is recommended for production
- [MCP Inspector - Model Context Protocol](https://modelcontextprotocol.io/docs/tools/inspector) - Official testing tool documentation
- Existing codebase audit (src/mcp/index.ts, src/mcp/errors.ts, src/mcp/tools/health-tools.ts)

### Secondary (MEDIUM confidence)
- [Fix MCP Error -32000: Connection Closed - Solutions Guide | MCPcat](https://mcpcat.io/guides/fixing-mcp-error-32000-connection-closed/) - Community documentation on stdout pollution
- [Understanding MCP Stdio transport | by Laurent Kubaski | Medium](https://medium.com/@laurentkubaski/understanding-mcp-stdio-transport-protocol-ae3d5daf64db) - Detailed transport explanation
- [Connect Claude Code to tools via MCP - Claude Code Docs](https://code.claude.com/docs/en/mcp) - Claude Code integration testing

### Tertiary (LOW confidence)
- None - all findings verified with official sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Using official SDK v1.26.0, verified via npm/GitHub
- Architecture: HIGH - Existing codebase already follows correct patterns
- Pitfalls: HIGH - Well-documented in official MCP docs and community resources
- Verification strategy: MEDIUM - Inspector tool is official, but automated testing patterns need validation

**Research date:** 2026-02-13
**Valid until:** 2026-03-13 (30 days - MCP SDK is stable, but v2 pre-alpha may affect recommendations)
