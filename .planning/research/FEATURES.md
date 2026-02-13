# Feature Research: CLI/MCP Interface Patterns

**Domain:** Task Management CLI and MCP Tool UX
**Researched:** 2026-02-13
**Confidence:** HIGH

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **CLI: Subcommand organization** | Industry standard (git, docker, gh) uses noun-verb or verb-noun patterns | LOW | Already have `tasks create/list/update`, need to add: `tasks delete`, `tasks project <action>`, `tasks deps <action>`, etc. |
| **CLI: --json output flag** | Required for scripting, piping to jq, agent consumption | LOW | Add to all commands. Return valid JSON to stdout, errors to stderr |
| **CLI: --help on all commands** | Users expect --help to show usage, options, examples | LOW | Commander.js provides this automatically |
| **CLI: Error messages to stderr** | Exit code 0 = success, 1+ = error. Errors go to stderr, output to stdout | LOW | Already implemented in error-handler.ts |
| **CLI: Status/priority color coding** | Visual differentiation (red=urgent/blocked, yellow=medium/in_progress, green=done) | LOW | Already implemented in formatters.ts (status: blue/yellow/green/gray/red, priority: red/yellow/gray) |
| **CLI: Table truncation** | Long titles/descriptions shouldn't break table layout | LOW | Already truncates titles to 45 chars in formatters.ts |
| **CLI: Interactive prompts for missing required fields** | If user forgets a required field, prompt instead of erroring | MEDIUM | Need to detect TTY, check if field missing, prompt with validation, respect --no-input flag |
| **MCP: snake_case tool names** | MCP standard: alphanumeric + underscore/dash/dot, prefer snake_case | LOW | Already using snake_case (create_task, get_dependencies, etc.) |
| **MCP: Consistent parameter naming** | Same concepts use same parameter names across tools (task_id not id in one and task_id in another) | LOW | Already consistent: task_id, project_id, blocks_task_id |
| **MCP: Structured content + text summary** | Return both human-readable text and structured data for agents | LOW | Already implemented: all tools return content array + structuredContent |

### Differentiators (Competitive Advantage)

Features that set the product apart. Not required, but valuable.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **CLI: Progressive disclosure in --help** | Show common options first, --verbose for full docs | MEDIUM | Commander.js supports this via .addHelpText(). Show 5-7 most common flags, note "use --verbose for all options" |
| **CLI: Smart defaults from context** | Infer project_id from current directory .wfb-project file | MEDIUM | If no --project flag, check for .wfb-project in cwd. Makes CLI feel contextual |
| **CLI: Suggest corrections on typos** | "Did you mean 'tasks list'?" when user types 'tasks ls' | LOW | Use string distance algorithm on unknown commands |
| **MCP: Rich error context in structuredContent** | Include error_code, validation_failures array in MCP errors | LOW | Extend convertToMcpError() to include structured error details |
| **CLI: --format flag** | Support --format=json/table/plain for different consumption modes | MEDIUM | --format=table (default, colored), --format=plain (no colors, for grep), --format=json (alias for --json) |
| **CLI: Confirmation prompts for destructive actions** | Require --force or interactive Y/N for delete operations | LOW | Prevents accidental deletions, standard practice (rm -i, git branch -D) |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **CLI: Arbitrary command abbreviations** | Convenience (like git co for checkout) | Prevents adding new commands (if 'ls' = 'list', can't add 'list-something' later) | Explicit aliases in shell config (~/.bashrc), not CLI itself |
| **CLI: --verbose on every command** | Debugging output | Pollutes normal usage, users forget to turn it off, breaks scripting | Use DEBUG=wfb:* environment variable, keeps verbose output opt-in |
| **MCP: Single "do_everything" tool** | Seems simpler than many tools | Agents can't discover capabilities, poor error messages, hard to validate | Keep tools granular: one tool = one operation |
| **CLI: Auto-update checking** | Keep users on latest version | Network I/O on every command = slow startup, privacy concerns | Document manual update process, check on explicit `tasks version --check-update` only |
| **CLI: Pagination in table output** | Handle 1000+ task lists | Adds complexity, users can pipe to `less` or use filters | Encourage filtering (--status, --project, --search) instead of paginating everything |

## Feature Dependencies

```
[CLI: Interactive prompts]
    └──requires──> [TTY detection]
    └──requires──> [--no-input flag]

[CLI: --json output]
    └──required-by──> [Agent CLI consumption]
    └──required-by──> [jq piping]

[CLI: Subcommand structure]
    └──enables──> [Future expansion without breaking changes]

[MCP: Structured error context]
    └──enhances──> [Agent error recovery]

[CLI: Smart defaults from context]
    └──optional-enhances──> [Project-scoped workflow]

[CLI: --format flag]
    └──conflicts──> [Single responsibility - use --json instead]
```

### Dependency Notes

- **Interactive prompts require TTY detection:** Don't prompt if stdin is not a TTY (piped input, cron jobs). Must provide --no-input flag to disable prompts and error on missing fields instead.
- **--json output required by agents:** Agents and scripts need machine-readable output. Must be valid JSON, not pretty-printed unless requested.
- **Subcommand structure enables expansion:** Using `tasks project create` allows adding `tasks project archive` later without breaking `tasks create`.
- **--format flag conflicts with single responsibility:** Instead of --format=json/table/plain, use --json and --plain as separate flags. Simpler mental model.

## MVP Definition

### Launch With (v1.1 - Current Milestone)

Minimum viable additions to achieve CLI/MCP parity and basic polish.

- [x] **CLI: Subcommand structure for all REST endpoints** — Already have create/list/update, need: delete, project CRUD, deps, comments, subtasks, estimates, health
- [ ] **CLI: --json flag on all commands** — Essential for agent consumption and scripting
- [ ] **CLI: Interactive prompts for missing required fields** — Improves human UX when fields forgotten
- [ ] **CLI: Confirmation prompt on delete** — Prevent accidental data loss
- [ ] **MCP: Project CRUD tools (5 tools)** — Closes the parity gap with REST API
- [ ] **MCP: Health check tool** — Allows agents to verify service is running
- [ ] **MCP: List subtasks tool** — Already have get_subtasks, need list_subtasks for consistency

### Add After Validation (v1.x)

Features to add once core is working and user feedback is gathered.

- [ ] **CLI: Progressive disclosure in --help** — Add when help text becomes overwhelming (>15 flags)
- [ ] **CLI: Smart defaults from .wfb-project file** — Add when users report fatigue from typing --project repeatedly
- [ ] **CLI: Suggest corrections on typos** — Polish feature, add when core commands stable
- [ ] **CLI: --plain output format** — Add when users report issues piping colored output to grep/awk
- [ ] **MCP: Rich error context in structuredContent** — Add when agents need better error recovery

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] **CLI: Batch operations** — `tasks update --status done --ids 1,2,3` (wait for user demand)
- [ ] **CLI: Config file support** — `~/.wfbrc` for default flags (wait for repeated requests)
- [ ] **MCP: Batch tool execution** — Single tool that takes array of operations (wait for performance issues)
- [ ] **CLI: Shell completions** — Bash/zsh tab completion (polish feature, not critical)

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| **CLI: --json on all commands** | HIGH | LOW | P1 |
| **CLI: Delete command** | HIGH | LOW | P1 |
| **CLI: Project CRUD commands** | HIGH | LOW | P1 |
| **CLI: Dependency commands** | MEDIUM | LOW | P1 |
| **CLI: Comment commands** | MEDIUM | LOW | P1 |
| **CLI: Interactive prompts** | HIGH | MEDIUM | P1 |
| **CLI: Delete confirmation** | HIGH | LOW | P1 |
| **MCP: Project CRUD tools** | HIGH | LOW | P1 |
| **MCP: Health check tool** | MEDIUM | LOW | P1 |
| **CLI: Progressive disclosure** | LOW | MEDIUM | P2 |
| **CLI: Smart context defaults** | MEDIUM | MEDIUM | P2 |
| **CLI: Typo suggestions** | LOW | LOW | P2 |
| **CLI: --plain output** | MEDIUM | LOW | P2 |
| **MCP: Rich error context** | MEDIUM | MEDIUM | P2 |
| **CLI: Batch operations** | LOW | HIGH | P3 |
| **CLI: Config file** | LOW | MEDIUM | P3 |
| **CLI: Shell completions** | LOW | MEDIUM | P3 |

**Priority key:**
- P1: Must have for v1.1 (interface parity milestone)
- P2: Should have, add when user feedback indicates need
- P3: Nice to have, future consideration

## Command Structure Patterns

### Industry Standards Analysis

| Tool | Pattern | Example | Notes |
|------|---------|---------|-------|
| **Git** | verb-noun (sometimes noun-verb) | `git commit`, `git branch delete` | Inconsistent, but established |
| **Docker** | noun-verb | `docker container create`, `docker image ls` | Highly consistent, scales well |
| **GitHub CLI (gh)** | noun-verb | `gh pr create`, `gh issue list` | Modern standard, easy to discover |
| **Taskwarrior** | verb-only | `task add`, `task list`, `task delete` | Simple but doesn't scale to multiple entities |
| **Kubernetes (kubectl)** | verb-noun | `kubectl get pods`, `kubectl delete service` | Verb-first for action-oriented workflow |

**Recommendation for Wood Fired Bugs:**

Use **noun-verb pattern** like `gh` and Docker for consistency and scalability:

```bash
tasks task create        # Create a task
tasks task list          # List tasks
tasks task update <id>   # Update task
tasks task delete <id>   # Delete task

tasks project create     # Create project
tasks project list       # List projects

tasks deps add           # Add dependency
tasks deps list <id>     # List dependencies for task

tasks comments add       # Add comment
tasks comments list <id> # List comments for task
```

**Alternative (simpler for v1.1):**

Keep current flat structure, expand it:

```bash
tasks create              # Create task (current)
tasks list                # List tasks (current)
tasks update <id>         # Update task (current)
tasks delete <id>         # NEW
tasks show <id>           # NEW - detailed view

tasks project-create      # NEW
tasks project-list        # NEW
tasks project-update <id> # NEW
tasks project-delete <id> # NEW
tasks project-show <id>   # NEW

tasks deps-add <id> <blocks-id>      # NEW
tasks deps-remove <id> <blocks-id>   # NEW
tasks deps-list <id>                 # NEW

tasks comment-add <id> "text"        # NEW
tasks comment-list <id>              # NEW
tasks comment-delete <comment-id>    # NEW
```

**Chosen approach:** Flat structure with hyphenated commands (simpler, no subcommand parser changes needed).

## JSON Output Format

### Standard Envelope

All --json output uses consistent structure:

```json
{
  "success": true,
  "data": { ... },
  "metadata": {
    "timestamp": "2026-02-13T17:30:00Z",
    "version": "1.1.0"
  }
}
```

### Error Format

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid task status: 'invalid'",
    "details": {
      "field": "status",
      "valid_values": ["open", "in_progress", "done", "closed", "blocked"]
    }
  },
  "metadata": {
    "timestamp": "2026-02-13T17:30:00Z",
    "version": "1.1.0"
  }
}
```

### List Results

```json
{
  "success": true,
  "data": [
    { "id": 1, "title": "Task 1", ... },
    { "id": 2, "title": "Task 2", ... }
  ],
  "metadata": {
    "count": 2,
    "timestamp": "2026-02-13T17:30:00Z",
    "version": "1.1.0"
  }
}
```

**jq-friendly patterns:**

```bash
# Get all task IDs
tasks list --json | jq '.data[].id'

# Get tasks with high priority
tasks list --json | jq '.data[] | select(.priority == "high")'

# Count tasks by status
tasks list --json | jq 'group_by(.data[].status) | map({status: .[0].status, count: length})'
```

## Interactive Prompt Patterns

### When to Prompt

**Prompt when:**
- Required field missing AND stdin is TTY
- Destructive action (delete) AND no --force flag AND stdin is TTY

**Don't prompt when:**
- stdin is not TTY (piped input, cron, agent)
- --no-input flag is set
- --json flag is set (machine mode)

### Prompt Implementation

```typescript
import readline from 'readline';

// Check if stdin is TTY
const isTTY = process.stdin.isTTY;

// Prompt for missing field
async function promptForField(fieldName: string, required = true): Promise<string> {
  if (!isTTY) {
    if (required) {
      throw new Error(`${fieldName} is required when running non-interactively`);
    }
    return '';
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${fieldName}: `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Ctrl+C handling
process.on('SIGINT', () => {
  console.log('\nOperation cancelled');
  process.exit(130); // Standard exit code for SIGINT
});
```

### Confirmation Prompts

```typescript
async function confirm(message: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} ${suffix}: `, (answer) => {
      rl.close();
      const normalized = answer.toLowerCase().trim();
      if (normalized === '') {
        resolve(defaultYes);
      } else {
        resolve(normalized === 'y' || normalized === 'yes');
      }
    });
  });
}
```

**Usage:**

```bash
# With TTY
$ tasks delete 123
Delete task 123: "Implement feature X"? [y/N]: y
Task 123 deleted

# Force flag (no prompt)
$ tasks delete 123 --force
Task 123 deleted

# Non-TTY (error)
$ echo "123" | tasks delete
Error: task_id must be provided as argument when running non-interactively

# Correct non-TTY usage
$ echo "123" | xargs tasks delete --force
```

## Table Formatting Best Practices

### Responsive Width

Current implementation uses cli-table3 with wordWrap enabled. Considerations:

- **Fixed width columns:** Prevents table from breaking terminal width
- **Truncation with ellipsis:** Title truncated to 45 chars (already implemented)
- **Hide columns on narrow terminals:** Check process.stdout.columns, hide less critical columns if <80

```typescript
const terminalWidth = process.stdout.columns || 80;
const includeAssignee = terminalWidth >= 100;
const includeDueDate = terminalWidth >= 120;
```

### Color Coding Reference

**Status colors (already implemented):**
- open: blue (new work)
- in_progress: yellow (active)
- done: green (completed)
- closed: gray (archived)
- blocked: red (attention needed)

**Priority colors (already implemented):**
- urgent: red bold (immediate action)
- high: red (soon)
- medium: yellow (normal)
- low: gray (when possible)

**Best practice:** Use ANSI color codes via chalk, not terminal-specific codes. Respect NO_COLOR environment variable.

## MCP Tool Naming Conventions

### Official MCP Specification

- **Length:** 1-64 characters (inclusive)
- **Case:** Case-sensitive
- **Allowed:** Alphanumeric, underscore (_), dash (-), dot (.), forward slash (/)
- **Prohibited:** Spaces, commas, special characters
- **Recommendation:** snake_case for tool names

### Current Implementation (Already Compliant)

```
create_task           ✓ snake_case, descriptive
get_task              ✓ snake_case, follows CRUD pattern
update_task           ✓ snake_case, follows CRUD pattern
delete_task           ✓ snake_case, follows CRUD pattern
list_tasks            ✓ snake_case, plural for list operations
get_subtasks          ✓ snake_case, clear parent-child relationship
add_dependency        ✓ snake_case, verb_noun pattern
remove_dependency     ✓ snake_case, verb_noun pattern
get_dependencies      ✓ snake_case, plural for multiple items
add_comment           ✓ snake_case, verb_noun pattern
list_comments         ✓ snake_case, plural for list operations
delete_comment        ✓ snake_case, verb_noun pattern
```

### Naming Patterns to Follow

**CRUD operations:**
- create_[entity] (POST)
- get_[entity] (GET single)
- list_[entities] (GET collection)
- update_[entity] (PUT/PATCH)
- delete_[entity] (DELETE)

**Relationships:**
- add_[relationship] (create edge)
- remove_[relationship] (delete edge)
- get_[relationships] (list edges)

**Special operations:**
- check_health
- search_tasks (when search is primary operation)

### Tools to Add for v1.1

```
create_project        # POST /api/v1/projects
get_project           # GET /api/v1/projects/:id
list_projects         # GET /api/v1/projects
update_project        # PUT /api/v1/projects/:id
delete_project        # DELETE /api/v1/projects/:id
check_health          # GET /api/v1/health
```

## Competitor Feature Analysis

| Feature | Taskwarrior | GitHub CLI (gh) | Our Approach |
|---------|-------------|-----------------|--------------|
| **JSON output** | `task export` (always JSON) | `--json` flag on most commands | `--json` flag on all commands (v1.1) |
| **Interactive prompts** | No (all via flags) | Yes (`gh pr create` prompts for fields) | Yes, with --no-input escape hatch (v1.1) |
| **Delete confirmation** | No (immediate delete) | Yes (shows preview, asks Y/N) | Yes, unless --force (v1.1) |
| **Color coding** | Yes (extensive) | Yes (status-based colors) | Yes (status + priority colors, already in v1.0) |
| **Subcommand structure** | Flat (task add, task done) | Nested (gh pr create, gh issue list) | Flat with hyphens (tasks project-create) for simplicity |
| **Table truncation** | No (can overflow) | Yes (truncates to terminal width) | Yes (fixed 45 char title truncation, v1.0) |
| **--help quality** | Excellent (man page level) | Good (examples included) | Good (Commander.js auto-generates, can enhance with examples) |

## Sources

### CLI Best Practices
- [Command Line Interface Guidelines (clig.dev)](https://clig.dev/)
- [Taskwarrior Documentation](https://taskwarrior.org/docs/)
- [GitHub CLI Manual](https://cli.github.com/manual/)

### JSON Output Conventions
- [jq Manual](https://jqlang.org/manual/)
- [AWS CLI Output Formats](https://docs.aws.amazon.com/cli/v1/userguide/cli-usage-output-format.html)

### Interactive Prompt Patterns
- [Node.js prompts library](https://www.npmjs.com/package/prompts)
- [Command Line Interface Guidelines - Interactivity](https://clig.dev/)

### Table Formatting
- [cli-table3 Documentation](https://github.com/cli-table/cli-table3)
- [PowerShell Format-Table](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/format-table)

### MCP Conventions
- [Model Context Protocol Specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25)
- [SEP-986: Tool Name Format Specification](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/986)
- [MCP Server Naming Conventions (zazencodes.com)](https://zazencodes.com/blog/mcp-server-naming-conventions)

### Color Coding Standards
- [Project Management Color Conventions](https://www.linkedin.com/pulse/color-codes-project-management-irene)
- [RAG Status Color Scheme](https://www.schemecolor.com/order-of-priority.php)

---
*Feature research for: CLI/MCP Interface Parity and Polish*
*Researched: 2026-02-13*
*Confidence: HIGH (official sources + existing codebase analysis)*
