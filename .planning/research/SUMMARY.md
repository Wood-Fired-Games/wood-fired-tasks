# Project Research Summary

**Project:** Wood Fired Bugs - CLI/MCP Interface Parity Expansion
**Domain:** Task Management System Interface Extension
**Researched:** 2026-02-13
**Confidence:** HIGH

## Executive Summary

Wood Fired Bugs is a mature task tracking service with a well-architected REST API, MCP server, and CLI. The v1.1 milestone aims to achieve full CLI/MCP parity with all REST endpoints, expanding from 3 CLI commands to 18+ and 12 MCP tools to 19+. The research reveals that the existing architecture is sound and well-suited for this expansion - layered service design with clean separation between interfaces, shared Zod schemas, and proper abstraction boundaries.

The recommended approach is straightforward: extend the existing patterns rather than redesign. The CLI should remain an HTTP client calling the REST API (never direct service access), MCP tools should continue calling services directly, and all new commands/tools should follow established naming conventions. The stack is production-ready: Node.js 22 LTS, TypeScript 5.7+, Fastify 5.x for REST, Commander.js 14.x for CLI, and MCP TypeScript SDK 1.x. The only additions needed are @clack/prompts for interactive CLI experiences when required fields are missing.

Key risks center on maintaining consistency while scaling: ensuring all 18 commands support `--json` output without stdout contamination, establishing global option inheritance before adding subcommands, and enforcing MCP tool naming conventions (snake_case, resource_action pattern) before proliferation. The research identifies 10 critical pitfalls with clear prevention strategies, most of which must be addressed in Phase 1 (CLI Infrastructure) to avoid expensive retrofitting.

## Key Findings

### Recommended Stack

All core technologies are already in place and production-ready. Research confirms the current stack is optimal for this milestone with minimal additions needed.

**Core technologies:**
- **Node.js 22 LTS + TypeScript 5.7+**: Runtime environment - current LTS with native SQLite support, stable for production services
- **Fastify 5.7.4**: REST API framework - already implemented, 2.7x faster than Express with built-in schema validation
- **better-sqlite3 12.6.2**: SQLite driver - already implemented, 5-10x faster than alternatives, synchronous API perfect for local services
- **Commander.js 14.0.3**: CLI framework - already implemented, zero dependencies, clean subcommand syntax, 12M weekly downloads
- **MCP TypeScript SDK 1.x**: MCP server - already implemented, production-ready official SDK with Zod integration
- **@clack/prompts 1.0.1**: Interactive CLI prompts - NEW addition for missing required fields, 80% smaller than alternatives, beautiful UX

**No changes needed:** The existing stack handles everything required. The only addition is @clack/prompts for enhanced CLI UX when users forget required fields.

### Expected Features

The research identifies clear feature priorities based on CLI/MCP interface parity goals and industry standards.

**Must have (table stakes):**
- **CLI: --json output flag** - Essential for scripting, piping to jq, agent consumption; standard in git/docker/gh
- **CLI: Subcommand organization** - Industry standard pattern (gh pr create, docker container ls) for scalable command structure
- **CLI: Interactive prompts for missing fields** - Improves human UX while respecting non-interactive mode for scripts
- **CLI: Delete confirmation prompts** - Prevent accidental data loss (standard practice: rm -i, git branch -D)
- **MCP: snake_case tool naming** - MCP standard, enables LLM tool name prediction
- **MCP: Consistent parameter naming** - Same concepts use same names across tools (task_id everywhere, not mixed with id)
- **MCP: Project CRUD tools (5 tools)** - Closes parity gap with REST API

**Should have (competitive advantage):**
- **CLI: Smart defaults from context** - Infer project_id from .wfb-project file in current directory
- **CLI: Suggest corrections on typos** - "Did you mean 'tasks list'?" for better UX
- **MCP: Rich error context** - Include error_code and validation_failures array in structured errors
- **CLI: --format flag** - Support table/plain/json for different consumption modes

**Defer (v2+):**
- **CLI: Batch operations** - `tasks update --status done --ids 1,2,3` (wait for user demand)
- **CLI: Config file support** - ~/.wfbrc for default flags (wait for repeated requests)
- **CLI: Shell completions** - Bash/zsh tab completion (polish feature, not critical)
- **MCP: Batch tool execution** - Single tool that takes array of operations (wait for performance issues)

### Architecture Approach

Wood Fired Bugs uses a clean layered architecture that's ideal for interface expansion: CLI → HTTP → REST API → Service Layer → Repository Layer → SQLite. The CLI is intentionally decoupled as an HTTP client, while MCP calls services directly for performance. This separation allows each interface to evolve independently.

**Major components:**
1. **CLI Commands** - Organized in folders by resource (tasks/, projects/, dependencies/, comments/), each command is a separate file exporting Commander.js Command instance, all call REST API via client.ts
2. **API Client** - HTTP client functions in src/cli/api/client.ts, provides typed interfaces to REST endpoints, handles errors with ApiClientError, 10s timeout for all requests
3. **MCP Tools** - Grouped by resource in separate files (task-tools.ts, project-tools.ts, etc.), each file exports registerXxxTools() function, shares Zod schemas from src/schemas/
4. **Output Formatters** - Centralized in src/cli/output/formatters.ts, separates presentation from logic, supports table/detail views, handles color coding consistently
5. **Service Layer** - Already implements all operations, shared by REST API and MCP, validates with Zod schemas, no changes needed for v1.1
6. **Repository Layer** - Already has all data access methods, no changes needed for v1.1

**Build order:** Foundation (types, API client, formatters) → CLI Commands → Integration (subcommands, global options) → MCP Tools → Testing. Phases 1-3 are sequential, Phase 4 (MCP) can parallel Phase 2-3.

### Critical Pitfalls

Research identified 10 critical pitfalls specific to scaling CLI/MCP interfaces. Top 5 by impact:

1. **--json flag breaking interactive prompts** - Interactive prompts corrupt JSON output stream when users run `tasks create --json`. Prevention: Detect TTY vs. non-TTY, auto-disable prompts when --json is present, all prompts write to stderr not stdout, fail fast with clear error if required fields missing in non-interactive mode. Address in Phase 1.

2. **Global options not inherited by subcommands** - Commander.js doesn't automatically propagate global options like --json to subcommands unless configured correctly. Prevention: Add global options to root program before registering subcommands, use .command() for automatic inheritance or call .copyInheritedSettings() with .addCommand(), access via .optsWithGlobals() in handlers. Address in Phase 1.

3. **Async action handlers with .parse() instead of .parseAsync()** - Using .parse() causes Node.js to exit before async handlers complete, resulting in uncommitted database writes and no output. Prevention: Always use .parseAsync(), wrap in try/catch, set process.exitCode not process.exit(), add top-level error handler. Address in Phase 1.

4. **Stdout contamination in JSON mode** - Progress messages, debug output, and console.log() statements write to stdout, breaking JSON parseability. Prevention: Create output abstraction (output.info(), output.json()), write messages to stderr, single JSON.stringify() at end, test each command with `| jq`. Address in Phase 1.

5. **MCP tool name explosion without convention** - Growing to 19+ tools without naming standard creates discovery chaos for LLM agents. Prevention: Establish snake_case convention (resource_action pattern) before expansion, rename existing 12 tools to match, document in naming guide, enforce in code review. Address in Phase 2.

**Pattern:** All top pitfalls require architectural decisions in early phases. Retrofitting is expensive and breaks existing usage.

## Implications for Roadmap

Based on research, suggested phase structure mirrors the existing roadmap with validation from technical findings:

### Phase 1: Core CLI Infrastructure
**Rationale:** Foundation must be correct before adding 15+ commands. Output abstraction, global option handling, and async patterns affect every command. Building these correctly from the start avoids expensive retrofitting.

**Delivers:**
- Output abstraction layer (separates stdout for data, stderr for messages)
- Global --json flag with proper inheritance to all commands
- .parseAsync() pattern for all async handlers
- Interactive prompt system with TTY detection and --no-input flag
- Enhanced error handling with consistent formatting

**Addresses (from FEATURES.md):**
- CLI: --json output flag (table stakes)
- CLI: Interactive prompts for missing fields (table stakes)
- CLI: Error messages to stderr (table stakes)

**Avoids (from PITFALLS.md):**
- Pitfall 1: --json breaking prompts (critical)
- Pitfall 2: Global options not inherited (critical)
- Pitfall 3: Async handlers incomplete (critical)
- Pitfall 5: Stdout contamination (critical)

**Research flag:** Standard patterns, skip research-phase. Commander.js and @clack/prompts well-documented.

### Phase 2: CLI Command Expansion
**Rationale:** With infrastructure in place, can safely add 15 new commands following established patterns. Folder organization by resource enables parallel development and clear code navigation.

**Delivers:**
- Project CRUD commands (5 commands)
- Dependency management commands (3 commands)
- Comment management commands (3 commands)
- Additional task commands: get, delete (2 commands)
- Subcommand grouping (tasks project create, tasks dep add, etc.)

**Addresses (from FEATURES.md):**
- CLI: Subcommand organization (table stakes)
- CLI: Delete confirmation prompts (table stakes)
- All REST endpoint parity

**Uses (from STACK.md):**
- Commander.js subcommand patterns
- @clack/prompts for interactive flows
- Existing API client extensions

**Implements (from ARCHITECTURE.md):**
- Command folder structure (tasks/, projects/, dependencies/, comments/)
- API client extensions (12+ new functions)
- Output formatters (project, dependency, comment tables)

**Avoids (from PITFALLS.md):**
- Pitfall 8: Commander camelCase/kebab-case confusion (via TypeScript types)
- Pitfall 9: No JSON test coverage (via test pattern establishment)

**Research flag:** Standard patterns, skip research-phase. Established CLI patterns.

### Phase 3: MCP Tool Expansion
**Rationale:** Can proceed in parallel with Phase 2 since MCP and CLI are independent interfaces. Must establish naming convention before adding 7+ new tools to avoid discovery chaos.

**Delivers:**
- Project CRUD MCP tools (5 tools: create_project, get_project, list_projects, update_project, delete_project)
- Health check tool (check_health)
- List subtasks tool (list_subtasks for consistency)
- Updated tool registration in MCP server

**Addresses (from FEATURES.md):**
- MCP: Project CRUD tools (table stakes)
- MCP: Health check tool (table stakes)
- Complete MCP parity with REST endpoints

**Uses (from STACK.md):**
- MCP TypeScript SDK 1.x
- Shared Zod schemas from src/schemas/

**Implements (from ARCHITECTURE.md):**
- project-tools.ts file with registerProjectTools() function
- Tool naming convention: {resource}_{action} snake_case pattern
- Structured error responses via convertToMcpError()

**Avoids (from PITFALLS.md):**
- Pitfall 6: MCP tool name explosion (via convention enforcement)
- Pitfall 7: Missing schema validation (via .strict() Zod schemas)
- Pitfall 10: Tool proliferation without categorization (via consistent prefixes)

**Research flag:** Standard patterns, skip research-phase. MCP SDK well-documented, existing tool patterns established.

### Phase 4: Testing & Documentation
**Rationale:** Comprehensive testing validates all interfaces work correctly and consistently. JSON output testing particularly important since it's machine-consumed.

**Delivers:**
- JSON output tests for all 18 CLI commands
- MCP tool tests for all 19 tools
- Integration tests for CLI → REST → Service flow
- MCP inspector validation (no stdout pollution)
- Updated documentation for new commands/tools

**Avoids (from PITFALLS.md):**
- Pitfall 9: No JSON test coverage (via dedicated test suite)
- Verification checklist ensures all architectural boundaries respected

**Research flag:** Standard patterns, skip research-phase. Testing patterns established in existing codebase.

### Phase Ordering Rationale

- **Phase 1 first:** Infrastructure patterns affect all subsequent commands. Global options, output abstraction, and async handling must be correct before scaling to 18 commands. Retrofitting these is expensive and breaks existing usage.

- **Phases 2 & 3 parallel:** CLI and MCP are independent interfaces. Can develop simultaneously once Phase 1 infrastructure is ready. Both follow established patterns (CLI commands, MCP tools) with clear templates.

- **Phase 4 last:** Testing validates integration across all components. Cannot fully test until all commands/tools are implemented.

- **Dependencies:** Phase 1 → (Phase 2 || Phase 3) → Phase 4. Sequential execution for infrastructure, parallel for interface expansion, final testing.

**Architecture alignment:** Phase structure matches the existing layered architecture. Each phase respects the architectural boundaries: CLI commands stay as HTTP clients, MCP tools call services directly, no duplicate validation logic, centralized formatters.

**Pitfall mitigation:** This ordering addresses 9 of 10 critical pitfalls before they can manifest. Phase 1 handles the 5 most severe architectural pitfalls. Phase 2 and 3 address naming and testing gaps.

### Research Flags

**Phases with standard patterns (skip research-phase):**
- **Phase 1 (CLI Infrastructure):** Commander.js and @clack/prompts have excellent documentation, existing error-handler.ts provides pattern
- **Phase 2 (CLI Command Expansion):** Existing create.ts, list.ts, update.ts provide clear templates for new commands
- **Phase 3 (MCP Tool Expansion):** Existing task-tools.ts, dependency-tools.ts, comment-tools.ts provide clear templates for project-tools.ts
- **Phase 4 (Testing & Documentation):** Standard testing patterns, no novel integration challenges

**No phases need deeper research:** All work extends existing patterns with well-documented libraries. Research has already identified pitfalls and prevention strategies.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All core technologies verified via official docs, version compatibility confirmed, existing implementation proven |
| Features | HIGH | Feature priorities based on CLI best practices (clig.dev), competitor analysis (gh, taskwarrior), and MCP specification |
| Architecture | HIGH | Existing codebase analysis reveals clean layered design, extension points clear, no architectural changes needed |
| Pitfalls | HIGH | 10 critical pitfalls identified from Commander.js issues, MCP SDK docs, CLI best practices guides, all with prevention strategies |

**Overall confidence:** HIGH

All research areas are grounded in official documentation, established best practices, or existing codebase analysis. No speculative recommendations. The existing architecture is sound and well-suited for this expansion.

### Gaps to Address

**No significant gaps identified.** The research is comprehensive for the v1.1 milestone scope. Minor validation items:

- **@clack/prompts integration:** While library is well-documented (v1.0.1, Jan 2026), test interactive prompt flow with TTY detection and Ctrl+C handling before committing to implementation pattern
- **Commander.js global option inheritance:** Test `tasks --json list` vs `tasks list --json` early in Phase 1 to verify .optsWithGlobals() behavior matches research expectations
- **MCP tool naming convention:** Confirm snake_case preference aligns with LLM agent expectations (research shows this is MCP community standard, but validate with actual Claude usage)

All gaps are validation items, not knowledge gaps. Existing research provides clear implementation guidance.

## Sources

### Primary (HIGH confidence)
- [Fastify Official Documentation](https://fastify.dev/benchmarks/) - Performance benchmarks, v5 features, plugin architecture
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) - Official repository, v1.x production status, tool registration patterns
- [Commander.js Official Repository](https://github.com/tj/commander.js) - Subcommand documentation, global options, async handlers
- [Model Context Protocol Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25) - Tool naming format, schema validation requirements
- [Node.js SQLite Module](https://nodejs.org/api/sqlite.html) - Native support status in v22.5.0+
- [TypeScript 5.7+ Documentation](https://www.typescriptlang.org/docs/) - Native Node.js execution, module resolution
- [@clack/prompts npm](https://www.npmjs.com/package/@clack/prompts) - Version 1.0.1 verified, API documentation, bundle size

### Secondary (MEDIUM confidence)
- [Command Line Interface Guidelines (clig.dev)](https://clig.dev/) - Industry best practices for --json output, error handling, interactivity
- [The Definitive Guide to Commander.js](https://betterstack.com/community/guides/scaling-nodejs/commander-explained/) - Patterns and best practices
- [Commander.js GitHub Issues](https://github.com/tj/commander.js/issues) - Issue #476 (global options), #806 (async actions), #983 (organization), #1426 (option sharing)
- [MCP Best Practices Guide](https://modelcontextprotocol.info/docs/best-practices/) - Architecture and implementation patterns
- [MCP Error Handling Guide](https://mcpcat.io/guides/error-handling-custom-mcp-servers/) - Structured error response patterns
- [SEP-986: Tool Name Format](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/986) - Tool naming specification discussion
- [MCP Server Naming Conventions](https://zazencodes.com/blog/mcp-server-naming-conventions) - Community standards for snake_case
- [GitHub CLI Manual](https://cli.github.com/manual/) - Competitor analysis for subcommand patterns
- [Taskwarrior Documentation](https://taskwarrior.org/docs/) - Competitor analysis for CLI UX patterns
- [Node.js CLI Best Practices](https://github.com/lirantal/nodejs-cli-apps-best-practices) - JSON output, error handling, testing
- Existing codebase analysis - src/cli/, src/mcp/, src/services/, src/api/

### Tertiary (LOW confidence)
- [npm-compare: Interactive prompts](https://npm-compare.com/enquirer,inquirer,prompts,readline-sync) - @clack/prompts selected based on bundle size and UX, but comparison data from older sources

---
*Research completed: 2026-02-13*
*Ready for roadmap: yes*
