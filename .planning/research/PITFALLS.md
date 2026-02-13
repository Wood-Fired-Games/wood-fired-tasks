# Pitfalls Research: CLI/MCP Parity Expansion

**Domain:** Adding full CLI/MCP parity to existing task tracking service
**Context:** Subsequent milestone - expanding from 3 CLI commands to 18+, 12 MCP tools to 19+
**Researched:** 2026-02-13
**Confidence:** HIGH

## Critical Pitfalls

Mistakes that cause rewrites, breaking changes, or major integration failures when scaling interfaces.

### Pitfall 1: --json Flag Breaking Interactive Prompts

**What goes wrong:**
Adding `--json` output flag to all CLI commands without properly handling interactive prompts. When users run `tasks create --json`, the command prompts for missing required fields (interactively reading from stdin), but these prompts corrupt the JSON output stream. Scripts parsing JSON receive mixed plaintext prompts and JSON, causing parse failures.

**Why it happens:**
Interactive prompts are added to improve CLI UX for humans, but developers forget that `--json` mode targets machine consumption. The code checks `if (!options.title)` and calls `readline.question()`, writing prompt to stdout even when `--json` is active. All stdout writes (prompts, progress, debug messages) intermix with JSON output.

**Consequences:**
- Shell scripts fail with "unexpected token" when parsing JSON output
- CI/CD pipelines break when commands expect non-interactive execution
- `--json` flag becomes unreliable, defeating its purpose
- Mixed content on stdout: `"Enter task title: {"id": 123, ...`
- Inconsistent behavior: sometimes prompts, sometimes fails silently
- Users must remember to pass `--non-interactive` alongside `--json`

**Prevention:**
- Detect TTY vs. non-TTY stdin before prompting: `if (!process.stdin.isTTY) { throw error }`
- Auto-disable prompts when `--json` flag is present
- All prompts must write to stderr, not stdout (even in non-JSON mode)
- Fail fast with clear error if required fields missing in non-interactive mode
- Add `--non-interactive` flag that forces error-on-missing-fields behavior
- Test each command with `echo | tasks command --json` to verify no prompts leak
- Document: JSON mode always implies non-interactive mode

**Detection:**
- Run `echo | tasks create --json` and check if output is valid JSON
- Search codebase for `readline`, `prompt`, `inquirer` imports without TTY checks
- Test logs show "invalid JSON" errors when piping output to `jq`
- CI pipeline failures when shell scripts parse command output
- Manual testing works, automated testing fails

**Phase to address:**
Phase 1 (Core CLI Infrastructure) - Interactive prompt design must respect output mode from the start. Retrofitting is complex.

---

### Pitfall 2: Global Options Not Inherited by Subcommands

**What goes wrong:**
Adding global options like `--json`, `--quiet`, `--api-url` to the root program, but these options don't propagate to subcommands. Users run `tasks --json list` expecting JSON output, but the `list` subcommand doesn't receive the `--json` flag, outputting plain text tables instead. Each of 18 commands needs separate flag handling.

**Why it happens:**
Commander.js uses `.command()` which automatically copies inherited settings **only at creation time**. If global options are added to the root program after subcommands are registered, those options never reach subcommands. Using `.addCommand()` doesn't copy settings at all unless `.copyInheritedSettings()` is called explicitly. Developers assume flags "just work" globally but need manual propagation.

**Consequences:**
- Users must repeat flags per command: `tasks list --json` instead of `tasks --json list`
- Inconsistent behavior across commands (some inherit, some don't)
- Frustrating UX: global options don't work globally
- Documentation becomes complex explaining which flags work where
- Code duplication: every command redeclares same options
- Difficult to add new global option later (requires touching all commands)

**Prevention:**
- Add global options to root program **before** registering subcommands
- Use `.command()` for automatic inheritance (not `.addCommand()`)
- If using `.addCommand()`, call `.copyInheritedSettings()` explicitly for each
- Access global options via `.optsWithGlobals()` in action handlers
- Test global option propagation: verify `tasks --json list` works, not just `tasks list --json`
- Document: "Global flags must appear before command: `tasks --json list`"
- Create shared option factory function to ensure consistency

**Detection:**
- Run `tasks --json list` and verify JSON output (not plain text)
- Code review shows `.addCommand()` without `.copyInheritedSettings()`
- Help output shows global options but they don't affect subcommands
- Users report flags "not working" when placed before command name
- Test suite doesn't cover global flag positioning

**Phase to address:**
Phase 1 (Core CLI Infrastructure) - Global option architecture must be designed correctly upfront. Changing later requires modifying all commands.

---

### Pitfall 3: Async Action Handlers with .parse() Instead of .parseAsync()

**What goes wrong:**
Scaling from 3 to 18 commands means more async handlers (database queries, API calls). Using `.parse()` instead of `.parseAsync()` causes Node.js to exit before async handlers complete. Commands appear to succeed but database writes never commit, API calls never return, and users see no output or partial results.

**Why it happens:**
Commander.js supports async action handlers, but `.parse()` doesn't wait for promises. The CLI script calls `.parse(process.argv)`, action handler returns a promise, but Node.js exits immediately because `.parse()` returns synchronously. No error appears - the process exits with code 0 while async work is still pending. This works accidentally in synchronous commands (v1.0's 3 simple commands) but breaks when adding database/network operations.

**Consequences:**
- Commands exit before completing database writes
- Transactions started but never committed
- API responses never returned to user
- Silent failures: no error message, just incomplete execution
- Works in development with artificial delays, fails in production
- Difficult to debug: logs show handler started but not completed

**Prevention:**
- Always use `.parseAsync()` instead of `.parse()` if any handlers are async
- Wrap `.parseAsync()` in try/catch to handle rejections properly
- Set `process.exitCode = 1` on error, don't call `process.exit()` directly
- Add top-level error handler: `.parseAsync().catch(err => { console.error(err); process.exitCode = 1; })`
- Test with timeouts to verify completion: run command, verify database changes committed
- Add ESLint rule or code review checklist to flag `.parse()` usage
- Document: "All CLI commands must use .parseAsync() for consistency"

**Detection:**
- Commands exit immediately without showing expected output
- Database writes don't persist despite successful exit code
- Adding `await sleep(100)` at end of handler "fixes" the issue
- Code shows `.parse(process.argv)` instead of `.parseAsync(process.argv)`
- Integration tests fail intermittently due to timing issues

**Phase to address:**
Phase 1 (Core CLI Infrastructure) - Must be correct from the start for all commands. Subtle bug that's hard to catch in testing.

---

### Pitfall 4: Inconsistent Error Handling Between CLI and MCP

**What goes wrong:**
CLI commands and MCP tools use different error handling approaches. CLI throws exceptions that crash the process with stack traces. MCP tools return `isError: true` in responses. When adding 15 new CLI commands with same logic as MCP tools, error handling diverges. Users see inconsistent error messages, stack traces leak internal details, and automation breaks on unexpected output formats.

**Why it happens:**
CLI and MCP evolved separately. CLI uses `throw new Error()` or `handleError(error)` that prints to stderr. MCP uses structured error responses: `{ isError: true, content: [{type: 'text', text: error.message}] }`. When reusing service layer code across both interfaces, errors propagate differently. CLI developers add `console.error()` calls, MCP developers add `try/catch` with structured responses. Codebase splits into two error handling patterns.

**Consequences:**
- Same operation produces different error formats via CLI vs. MCP
- CLI error messages change unexpectedly when service layer throws different error types
- Stack traces expose internal paths, database structure, API keys in logs
- MCP errors are clean, CLI errors are verbose and scary
- Automation scripts must handle multiple error output formats
- Difficult to maintain: fixing error message requires changes in multiple places

**Prevention:**
- Create shared error type hierarchy: `TaskNotFoundError`, `ValidationError`, `DatabaseError`
- Implement central error formatter: `formatError(error, format: 'cli' | 'mcp' | 'json')`
- CLI handler wraps all errors: `catch (e) { console.error(formatError(e, 'cli')); process.exitCode = 1; }`
- MCP handler wraps all errors: `catch (e) { return { isError: true, content: formatError(e, 'mcp') }; }`
- Service layer throws typed errors, never logs directly (no console.log/error)
- JSON mode uses structured error format: `{ success: false, error: { code, message, details } }`
- Test error scenarios across all interfaces to verify consistency

**Detection:**
- Same error produces different messages via CLI and MCP
- Grep codebase for `console.error` shows usage in service layer
- Stack traces appear in CLI output but not in structured errors
- Error handling tests only cover one interface, not both
- Users report confusing error messages that don't match documentation

**Phase to address:**
Phase 1 (Core CLI Infrastructure) and Phase 2 (MCP Tool Expansion) - Error handling architecture must be unified before scaling both interfaces.

---

### Pitfall 5: Stdout Contamination in JSON Mode

**What goes wrong:**
Adding `--json` flag to 18 commands requires auditing all output paths. Progress indicators (`console.log('Creating task...')`), debug messages (`console.log('Query:', sql)`), and success messages (`console.log('Task created successfully')`) all write to stdout, breaking JSON parsability. A single stray `console.log()` corrupts the entire output stream.

**Why it happens:**
Developers add helpful messages during development: status updates, confirmations, debug output. These go to stdout by default. When `--json` flag is added later, these messages remain. Code has dozens of `console.log()` scattered throughout. Each new command adds more. No enforcement mechanism prevents stdout writes in JSON mode.

**Consequences:**
- JSON output contains plaintext messages: `Creating task...{"id": 123}`
- Shell scripts fail to parse output with `jq`: "invalid JSON"
- Intermittent failures: depends on which code path executes
- Works for simple cases, breaks when errors occur or edge cases trigger
- Testing with `jq` catches some but not all contamination
- Every new feature risks introducing new stdout writes

**Prevention:**
- Create output abstraction: `output.info()`, `output.success()`, `output.data()` instead of `console.log()`
- Output class checks `--json` flag: writes to stderr for messages, stdout only for JSON data
- Single point of JSON writing: `output.json(data)` at end of command handler
- Lint rule: prohibit `console.log` in CLI command files (enforce output abstraction)
- All informational messages to stderr: `console.error('Creating task...')` even in non-JSON mode
- Test each command: `tasks command --json | jq` must parse without errors
- Code review checklist: verify no direct stdout writes in command handlers

**Detection:**
- Run command with `--json | jq` and get parse error
- Search codebase for `console.log` in CLI command files
- Test logs show "unexpected token" when parsing JSON output
- Integration tests fail when validating JSON structure
- Manual testing works, but piping to `jq` fails

**Phase to address:**
Phase 1 (Core CLI Infrastructure) - Output abstraction must be established before adding 15 new commands. Retrofitting is expensive.

---

### Pitfall 6: MCP Tool Name Explosion Without Convention

**What goes wrong:**
Growing from 12 to 19+ MCP tools without naming conventions creates discovery chaos. Tools named inconsistently: `createTask`, `get_task`, `task-update`, `delete-task-by-id`, `listAllTasksWithFilters`. LLM agents cannot predict tool names. Developers can't find existing tools. Similar tools duplicate functionality with different names.

**Why it happens:**
No naming standard established with initial 12 tools. Different developers add tools over time with personal preferences. Some follow REST conventions (`GET /tasks` → `getTasks`), others use CRUD verbs (`createTask`), others use descriptive names (`listAllTasksWithFilters`). MCP spec allows 64 characters with underscores, dashes, dots, slashes - developers use all variations.

**Consequences:**
- LLM agents guess tool names incorrectly, wasting tokens on tool list inspection
- Difficult to discover what operations are available
- Similar functionality duplicated under different names: `getTask` vs. `task_get` vs. `fetchTaskById`
- Documentation nightmare: must explain naming variations
- Refactoring blocked by inconsistent naming (cannot batch rename)
- New developers confused about which naming style to follow

**Prevention:**
- Establish naming convention before tool proliferation: `{resource}_{action}` (e.g., `task_create`, `task_list`, `comment_add`)
- Use snake_case consistently (most common MCP pattern based on research)
- Group by resource first: `task_*`, `project_*`, `comment_*`, `dependency_*`
- Action verbs from standard set: create, get, list, update, delete, add, remove
- Avoid IDs in names: `task_get` (takes ID param) not `getTaskById`
- Document convention in `MCP_TOOL_NAMING.md` with examples
- Rename existing 12 tools to match convention before adding new ones
- Code review checklist: verify new tool follows naming convention

**Detection:**
- Tool list shows mixed naming styles: camelCase, snake_case, kebab-case
- Similar operations have different name patterns
- Tool descriptions explain what name means (indicates unclear naming)
- Grep shows `registerTool` calls with inconsistent name formats
- LLM chat logs show failed tool call attempts with wrong names

**Phase to address:**
Phase 2 (MCP Tool Expansion) - Naming convention must be established and existing tools renamed before adding 7+ new tools.

---

### Pitfall 7: Missing Schema Validation Causes Cryptic MCP Errors

**What goes wrong:**
Adding 7 new MCP tools with complex parameters. Forgetting to add proper Zod schema validation for all fields. LLM passes invalid arguments (wrong type, missing required field, extra field). Tool fails with JavaScript error deep in service layer: "Cannot read property 'id' of undefined". Error message doesn't explain what was wrong with input parameters.

**Why it happens:**
Zod schemas define both validation and TypeScript types. Developers copy existing tool registration, update description and logic, but forget to update schema. Schema copied from different tool has wrong required fields. MCP SDK's default validation mode is flexible, allowing extra fields. Service layer expects certain shape, receives different shape. Errors appear at usage point, not validation point.

**Consequences:**
- Cryptic errors: "Cannot read property 'x' of undefined" instead of "Missing required field: x"
- LLM receives unhelpful feedback, cannot self-correct
- Debugging requires reading stack traces to find parameter issue
- Same tool call fails intermittently based on which fields LLM includes
- No clear contract between tool schema and implementation expectations
- Wasted tokens as LLM retries with guessed parameter variations

**Prevention:**
- Every tool registration includes complete Zod schema with `.strict()` modifier
- Schema validation catches: wrong types, missing required fields, extra fields, invalid enums
- Use schema composition for common patterns: `TaskIdSchema`, `PaginationSchema`
- Error messages from schema failures are descriptive: Zod provides path and expected type
- Test each tool with invalid inputs: missing fields, wrong types, extra fields
- MCP SDK configured for strict validation: `inputSchema: TaskSchema.strict()`
- Code review checklist: verify schema matches service layer function signature
- Generate TypeScript types from Zod schemas to ensure consistency

**Detection:**
- MCP tool errors mention undefined properties or type mismatches
- Error messages don't clearly identify which parameter was invalid
- Same tool call works with some parameter combinations, fails with others
- Schema shows `.passthrough()` or no `.strict()` modifier
- Test coverage missing for invalid parameter scenarios

**Phase to address:**
Phase 2 (MCP Tool Expansion) - Schema validation must be comprehensive before deploying to LLM agents. Poor validation creates frustrating debugging cycles.

---

### Pitfall 8: Commander Option CamelCase/kebab-case Confusion

**What goes wrong:**
Adding 15+ CLI commands with many options. Developer defines option `--created-by <name>` but tries to access via `options.created-by` in action handler. JavaScript throws syntax error or returns undefined. Different commands use different access patterns: some use camelCase, some try kebab-case, some use bracket notation `options['created-by']`.

**Why it happens:**
Commander.js automatically normalizes kebab-case flags to camelCase properties. `--template-engine` becomes `options.templateEngine`. Developers don't realize this, try to access with original flag name. Works sometimes when flag has no hyphens (`--title` → `options.title`), fails with multi-word flags. Copy-paste code from different sources shows different access patterns.

**Consequences:**
- Options are undefined despite user passing them: `--due-date 2026-12-31` but `options.due-date` is undefined
- Inconsistent access patterns across commands confuse maintenance
- Intermittent bugs: works for single-word flags, fails for multi-word flags
- Error messages unhelpful: "undefined is not a valid date"
- TypeScript types don't prevent the error (using wrong key)

**Prevention:**
- Document Commander's automatic normalization in development guide
- Always access multi-word options via camelCase: `options.createdBy` not `options.created-by`
- Use TypeScript with properly typed `.opts()` return value
- Add ESLint rule to detect bracket notation with kebab-case strings: `options['created-by']`
- Code review checklist: verify option access uses camelCase
- Test option parsing: verify all flags accessible via correct property name
- Consider using single-word flags to avoid confusion: `--creator` instead of `--created-by`

**Detection:**
- Options passed by user but show as undefined in handler
- Code shows `options['created-by']` or `options.created_by` access patterns
- Error messages indicate missing data despite CLI showing option was passed
- Different commands access options inconsistently
- TypeScript doesn't catch access errors (using `any` or incorrect typing)

**Phase to address:**
Phase 1 (Core CLI Infrastructure) - Understanding Commander's normalization is critical before scaling to 18 commands with many options.

---

### Pitfall 9: No Test Coverage for --json Output Validation

**What goes wrong:**
Adding `--json` flag to all commands but testing only table/text output format. JSON output is manually tested ("looks good"), but no automated tests validate JSON structure, schema, or parseability. When refactoring, JSON output breaks but tests pass. Users discover broken JSON output in production.

**Why it happens:**
Existing tests focus on happy path: "does command execute without error?" JSON output testing requires additional assertions: parse JSON, validate schema, check specific fields. Developers assume "if the data is correct, JSON will be correct too." Snapshot testing captures output, but doesn't validate JSON structure. Tests don't pipe output to JSON parser.

**Consequences:**
- JSON output breaks silently during refactoring
- Shell scripts fail in production while test suite passes
- Invalid JSON structure ships: missing fields, wrong types, extra fields
- No contract enforcement for JSON output schema
- Manual testing required for every change
- CI doesn't catch JSON-specific regressions

**Prevention:**
- Every command test includes JSON mode variant: `describe('--json output', ...)`
- Assert JSON parseability: `expect(() => JSON.parse(output)).not.toThrow()`
- Validate JSON schema: define expected shape with Zod, validate output against it
- Test specific fields exist and have correct types: `expect(json.id).toBeTypeOf('number')`
- Use external validation: run `echo output | jq .id` in integration test
- Test error cases in JSON mode: errors should produce valid JSON with error structure
- Snapshot test JSON structure, not raw output (to catch unintended changes)
- Add coverage requirement: all commands must have JSON output tests

**Detection:**
- Test suite shows no assertions on JSON structure
- Commands have `--json` flag but tests don't use it
- JSON parsing failures in production logs but tests pass
- Manual testing required before release to verify JSON output
- Test files have no `JSON.parse()` or schema validation calls

**Phase to address:**
Phase 1 (Core CLI Infrastructure) - JSON testing patterns must be established before adding 15 new commands. Retrofitting tests is expensive.

---

### Pitfall 10: MCP Tool Proliferation Without Categorization

**What goes wrong:**
Growing to 19+ tools without logical grouping. MCP protocol returns flat list of 19 tools to LLM. Agent must inspect every tool's description to find relevant ones. Long tool descriptions needed to differentiate similar tools. Token waste on tool discovery. LLM chooses wrong tool because descriptions are similar.

**Why it happens:**
MCP protocol supports tags and categories, but developers focus on functionality, not discovery UX. All tools registered at same level. Tool descriptions become verbose trying to explain when to use each tool. No metadata to help LLM filter relevant tools. Assumption that "LLM is smart enough to figure it out."

**Consequences:**
- LLM must read all 19 tool descriptions to find relevant one
- Token waste: hundreds of tokens listing tools before every operation
- Wrong tool selected when descriptions are ambiguous
- Tool descriptions become paragraphs trying to differentiate
- Cannot efficiently answer "what task operations are available?"
- Adding more tools makes problem exponentially worse

**Prevention:**
- Group tools by resource: task operations, project operations, comment operations, dependency operations
- Use consistent tool prefixes for discovery: `task_*`, `project_*`, `comment_*`
- Implement tool tags if MCP SDK supports: `tags: ['task', 'read']` vs. `tags: ['task', 'write']`
- Consider separate MCP servers by domain (task server, project server) if tool count exceeds 25
- Tool descriptions: one sentence explaining action, not when to use it
- Provide separate "tool guide" resource for LLM to read when planning workflow
- Optimize tool discovery with consistent naming that LLMs can pattern-match
- Monitor LLM token usage for tool listing vs. actual work

**Detection:**
- Tool list endpoint returns 19+ tools in flat list
- Tool descriptions longer than one sentence
- LLM chat logs show entire tool list repeated before each operation
- Similar tools with confusing descriptions: hard to choose correct one
- Token usage analysis shows high overhead for tool discovery
- MCP inspector shows tools without categorization metadata

**Phase to address:**
Phase 2 (MCP Tool Expansion) - Tool organization strategy must be designed before reaching 19+ tools. Reorganizing later is breaking change for LLM workflows.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems when scaling interfaces.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skipping --json testing | Faster test writing, smaller test suite | JSON output breaks silently, production failures | Never when adding machine-readable output |
| Manual output formatting in each command | Simple, no abstraction needed | Inconsistent formats, can't add --quiet globally | Only for MVP with 2-3 commands, not 18+ |
| Reusing service types in CLI | No type duplication, faster development | Breaking changes to internal types break CLI, tight coupling | Never - CLI types are API contract |
| Copy-pasting tool registration | Fast initial implementation | Inconsistent error handling, schema drift | Only acceptable if followed by refactor before phase complete |
| Console.log for all output | Works for simple cases | Cannot add --json flag later without rewrite | Never when JSON output is planned |
| Single error message format | Simpler error handling | Cannot distinguish user errors from bugs, poor UX | Acceptable for MVP, must refactor before scale |
| Global shared CLI state | Easy to pass options around | Untestable, race conditions, breaks parallel testing | Never - use dependency injection |
| No MCP tool versioning | Simpler deployment | Cannot deploy breaking changes without coordination | Acceptable for single-agent deployment only |

---

## Integration Gotchas

Common mistakes when connecting CLI, MCP, and service layer.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| CLI → Service Layer | Passing Commander options directly to service | Transform to service input types, validate at boundary |
| MCP → Service Layer | Passing Zod-validated args directly | Transform to service input types (MCP args ≠ service types) |
| CLI --json mode | Writing JSON with console.log() | Use single JSON.stringify() at end, validate with JSON.parse() |
| MCP error responses | Throwing exceptions | Return `{ isError: true, content: [...] }` with structured error |
| CLI exit codes | Calling process.exit() directly | Set process.exitCode, let process exit naturally |
| Shared validation logic | Duplicating Zod schemas | Define schemas in shared package, reuse across CLI/MCP/REST |
| API client in CLI | Hardcoded localhost URL | Read from env var with fallback, support custom --api-url flag |
| MCP stdio transport | Logging to stdout | Configure all loggers to stderr exclusively, test with MCP inspector |

---

## Performance Traps

Patterns that work at small scale but fail with 18+ commands or 19+ tools.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Loading all commands eagerly | Slow CLI startup (500ms+) | Lazy-load command modules, register on first use | >15 commands with heavy imports |
| No command result caching | Repeated API calls for same data | Cache results for duration of command execution | Commands with multiple service calls |
| Synchronous schema validation | Tool registration takes seconds | Use pre-compiled schemas, avoid re-validation | >20 tools with complex schemas |
| Table formatting with full dataset | Memory exhaustion, slow output | Stream table rows, paginate at CLI level | >1000 rows in table output |
| Full tool list in every MCP response | High token usage, slow responses | Client-side tool caching, incremental discovery | >25 tools |
| No CLI output buffering | Slow terminal rendering | Buffer output, flush once at end | Commands outputting >1000 lines |
| MCP tool schema re-validation | High latency per tool call | Validate once at registration, cache validated schemas | >50 tool calls/second |
| Rebuilding table formatters | CPU waste, memory leaks | Reuse formatter instances across commands | Commands called in loops |

---

## UX Pitfalls

Common user experience mistakes when scaling CLI and MCP interfaces.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Inconsistent flag names | --due-date in one command, --due in another, confusing muscle memory | Standardize flag names across all commands, document in style guide |
| No command aliases | Must type full command names, verbose for common operations | Add aliases: `tasks create` → `tasks new`, `tasks list` → `tasks ls` |
| Missing --help for flags | Users don't know what values are valid | Every flag includes description and example in --help output |
| Error without suggestion | "Invalid priority" without showing valid values | Include valid options in error: "Invalid priority 'urgent'. Valid: low, medium, high" |
| --json output without --pretty | Unreadable single-line JSON | Add --pretty flag for human-readable JSON with indentation |
| Silent truncation | Tables truncate without indication | Show truncation indicator: "... and 47 more rows (use --limit to show more)" |
| MCP tool names not discoverable | LLM must read all descriptions to find right tool | Use consistent naming pattern LLM can predict: {resource}_{action} |
| No progress indication | Long operations appear frozen | Show progress for operations >2 seconds, respect --quiet flag |
| Inconsistent date formats | Confusion parsing dates, timezone issues | ISO 8601 everywhere: 2026-02-13T15:30:00Z |
| Generic error codes | Cannot programmatically handle specific errors | Use specific exit codes: 1=general error, 2=invalid input, 3=not found |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces when scaling CLI/MCP.

- [ ] **--json flag added**: Often missing stderr/stdout separation - verify prompts/messages go to stderr, only JSON to stdout
- [ ] **Global options**: Often missing inheritance setup - verify `tasks --json list` works, not just `tasks list --json`
- [ ] **Interactive prompts**: Often missing TTY detection - verify `echo | tasks create --json` fails with clear error, doesn't hang
- [ ] **Async handlers**: Often missing .parseAsync() - verify commands complete before exit, database writes committed
- [ ] **Error handling**: Often missing consistent formatting - verify CLI and MCP return similar errors for same failure
- [ ] **MCP tool schemas**: Often missing .strict() validation - verify extra/invalid fields rejected with clear errors
- [ ] **Option access**: Often missing camelCase normalization - verify multi-word flags accessible via correct property name
- [ ] **JSON test coverage**: Often missing schema validation - verify tests parse JSON and assert on structure, not just snapshot
- [ ] **MCP tool naming**: Often missing convention adherence - verify all tools follow {resource}_{action} pattern
- [ ] **Output abstraction**: Often missing centralized output handling - verify no direct console.log in command handlers
- [ ] **Exit codes**: Often missing process.exitCode setting - verify commands set exitCode, don't call process.exit()
- [ ] **MCP logging**: Often missing stderr configuration - verify MCP server passes inspector test with no stdout pollution
- [ ] **Commander parsing**: Often missing error handling - verify .parseAsync() wrapped in try/catch with proper error output
- [ ] **Flag consistency**: Often missing standardization - verify similar flags named identically across commands

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| --json with prompts | LOW | Add TTY detection and --json auto-disables prompts, test with piping |
| Global options not inherited | MEDIUM | Refactor to add global options before subcommands, call .copyInheritedSettings() |
| .parse() instead of .parseAsync() | LOW | Replace .parse() with .parseAsync(), wrap in try/catch, verify async completion |
| Inconsistent error handling | MEDIUM | Extract error formatting layer, refactor CLI and MCP to use shared formatter |
| Stdout contamination | LOW-MEDIUM | Create output abstraction, replace all console.log with output.info(), test with jq |
| MCP tool naming chaos | HIGH | Define convention, rename all existing tools (breaking change), update documentation |
| Missing schema validation | LOW | Add .strict() to schemas, add tests with invalid inputs, verify error messages clear |
| CamelCase confusion | LOW | Fix option access to use camelCase, add TypeScript types to prevent recurrence |
| No JSON test coverage | MEDIUM | Write JSON tests for all commands, validate parseability and schema |
| Tool proliferation | MEDIUM-HIGH | Reorganize tools by resource, consider splitting into multiple MCP servers |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| --json prompts conflict | Phase 1: CLI Infrastructure | Test `echo \| tasks create --json` fails fast, `tasks create --json --title X` succeeds |
| Global option inheritance | Phase 1: CLI Infrastructure | Test `tasks --json list` produces JSON, verify all global flags work before command |
| .parse vs .parseAsync | Phase 1: CLI Infrastructure | All commands use .parseAsync, integration tests verify async completion |
| Error handling divergence | Phase 1: CLI Infrastructure | Same error produces consistent message via CLI --json and MCP tool |
| Stdout contamination | Phase 1: CLI Infrastructure | All commands with --json pass `\| jq` test, no stdout pollution |
| MCP tool naming | Phase 2: MCP Expansion | All tools follow {resource}_{action} convention, documented in naming guide |
| Schema validation | Phase 2: MCP Expansion | All tools reject invalid inputs with Zod errors, tests cover invalid cases |
| CamelCase confusion | Phase 1: CLI Infrastructure | Options accessed via camelCase, TypeScript types enforce correct access |
| JSON test coverage | Phase 1: CLI Infrastructure | All commands have JSON tests, CI fails if JSON output invalid |
| Tool proliferation | Phase 2: MCP Expansion | Tools organized by resource, discovery UX tested with token usage metrics |

---

## Sources

### Commander.js Best Practices
- [The Definitive Guide to Commander.js | Better Stack Community](https://betterstack.com/community/guides/scaling-nodejs/commander-explained/)
- [GitHub - tj/commander.js: node.js command-line interfaces made easy](https://github.com/tj/commander.js)
- [What is the best practice for organising large commander tool? · Issue #983](https://github.com/tj/commander.js/issues/983)
- [Async typescript functions as actions · Issue #806](https://github.com/tj/commander.js/issues/806)
- [Options shared by a root command and its subCommands · Issue #1426](https://github.com/tj/commander.js/issues/1426)

### CLI --json Output Best Practices
- [Flag deprecation warning should be send to stderr not stdout · Issue #5674](https://github.com/cli/cli/issues/5674)
- [BUG --json outputs errors to stdout instead of stderr · Issue #2150](https://github.com/npm/cli/issues/2150)
- [Deprecated warning message part of stdout instead of stderr · Issue #1896](https://github.com/forcedotcom/cli/issues/1896)
- [Command Line Interface Guidelines](https://clig.dev/)
- [Terraform validate - machine-readable JSON output](https://developer.hashicorp.com/terraform/cli/commands/validate)

### MCP SDK and Tool Design
- [Specification - Model Context Protocol](https://modelcontextprotocol.io/specification/2025-11-25)
- [Tools - Model Context Protocol](https://modelcontextprotocol.info/docs/concepts/tools/)
- [Error Handling in MCP Servers - Best Practices Guide](https://mcpcat.io/guides/error-handling-custom-mcp-servers/)
- [Add Custom Tools to TypeScript MCP Servers](https://mcpcat.io/guides/adding-custom-tools-mcp-server-typescript/)
- [MCP Best Practices: Architecture & Implementation Guide](https://modelcontextprotocol.info/docs/best-practices/)

### MCP Tool Naming Conventions
- [MCP Server Naming Conventions](https://zazencodes.com/blog/mcp-server-naming-conventions)
- [SEP-986: Specify Format for Tool Names · Issue #986](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/986)
- [Tool Naming Convention - ShotGrid MCP Server](https://pipeline-f26f1c83.mintlify.app/guides/tool-naming-convention)

### MCP Testing and Validation
- [MCP inspector - Visual testing tool for MCP servers](https://github.com/modelcontextprotocol/inspector)
- [Unit Testing MCP Servers - Complete Testing Guide](https://mcpcat.io/guides/writing-unit-tests-mcp-servers/)
- [MCP Tool Input Validation Testing](https://mcpcat.io/guides/validation-tests-tool-inputs/)
- [MCP JSON Schema Validation: Tools & Best Practices 2025](https://www.byteplus.com/en/topic/542256)

### CLI Testing Strategy
- [Testing in CI/CD: Unit, Integration, E2E Automation](https://dasroot.net/posts/2026/01/testing-ci-cd-unit-integration-e2e-automation/)
- [Integration tests on Node.js CLI: Part 4 — Mocking Services](https://medium.com/@zorrodg/%EF%B8%8F-integration-tests-on-node-js-cli-part-4-mocking-services-b6fba2d9d01b)
- [Unit and Integration Testing | anthropics/claude-code-sdk-python](https://deepwiki.com/anthropics/claude-code-sdk-python/5.1-unit-and-integration-testing)

### Terminal Compatibility
- [GitHub - chalk/chalk: Terminal string styling done right](https://github.com/chalk/chalk)
- [fix: Replace colors with chalk to fix infinite loop · Pull Request #250](https://github.com/cli-table/cli-table3/pull/250)
- [BUG Background color bleed in terminal from chalk usage · Issue #1341](https://github.com/anthropics/claude-code/issues/1341)

---

*Pitfalls research for: Wood Fired Bugs v1.1 - CLI/MCP Parity Expansion*
*Context: Scaling from 3 CLI commands to 18+, 12 MCP tools to 19+*
*Researched: 2026-02-13*
