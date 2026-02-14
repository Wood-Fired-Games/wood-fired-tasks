# Phase 12: Skill File Authoring - Research

**Researched:** 2026-02-13
**Domain:** Claude Code skill authoring with MCP tool integration
**Confidence:** HIGH

## Summary

Phase 12 creates 10 Claude Code workflow skills under the `/tasks:*` namespace that wrap the verified MCP server from Phase 11. Each skill is a markdown file in `~/.claude/commands/tasks/` that uses MCP tools via fully qualified names (`wood-fired-bugs:tool_name`).

The MCP server provides 25 tools across 5 categories: tasks (7), projects (5), dependencies (3), comments (3), and health (1). Skills will orchestrate these low-level tools into user-facing workflows like "log a bug", "pick up a task", and "view my work".

**Primary recommendation:** Use strict YAML frontmatter (name + description), keep skill bodies under 500 lines, reference MCP tools by fully qualified names, and test each skill with real usage before moving to the next.

## MCP Server Tool Inventory

### Task Tools (7 tools)
| Tool Name | Parameters | Purpose |
|-----------|------------|---------|
| `create_task` | title, description?, priority, project_id, parent_task_id?, estimated_minutes?, assignee?, created_by, due_date?, tags? | Create new task (status always 'open') |
| `get_task` | id (number) | Retrieve task by ID with full details |
| `update_task` | id, updates (partial: title?, description?, status?, priority?, parent_task_id?, estimated_minutes?, assignee?, due_date?, tags?) | Update existing task |
| `list_tasks` | filters (partial: project_id?, status?, assignee?, tags?, due_before?, due_after?, search?) | List tasks with optional filters |
| `delete_task` | id (number) | Delete task by ID |
| `list_subtasks` | task_id (number) | List all subtasks of a parent task |
| `get_subtasks` | task_id (number) | Get all subtasks (same as list_subtasks) |

### Project Tools (5 tools)
| Tool Name | Parameters | Purpose |
|-----------|------------|---------|
| `create_project` | name, description? | Create new project |
| `get_project` | id (number) | Retrieve project by ID |
| `list_projects` | (empty object) | List all projects |
| `update_project` | id, updates (partial: name?, description?) | Update existing project |
| `delete_project` | id (number) | Delete project by ID |

### Dependency Tools (3 tools)
| Tool Name | Parameters | Purpose |
|-----------|------------|---------|
| `add_dependency` | task_id, blocks_task_id | Create dependency (task_id blocks blocks_task_id) |
| `remove_dependency` | task_id, blocks_task_id | Remove dependency relationship |
| `get_dependencies` | task_id | Get all dependencies (blocks + blocked_by) |

### Comment Tools (3 tools)
| Tool Name | Parameters | Purpose |
|-----------|------------|---------|
| `add_comment` | task_id, author, content | Add comment to task |
| `get_comments` | task_id | Get all comments for task in chronological order |
| `delete_comment` | comment_id | Delete comment by ID |

### Health Tools (1 tool)
| Tool Name | Parameters | Purpose |
|-----------|------------|---------|
| `check_health` | (empty object) | Check service health, database connectivity, version |

### Type Constraints
- **Task Statuses**: 'open', 'in_progress', 'done', 'closed', 'blocked'
- **Task Priorities**: 'low', 'medium', 'high', 'urgent'
- **Valid Status Transitions**:
  - `open` → `in_progress`, `blocked`, `closed`
  - `in_progress` → `done`, `blocked`, `open`
  - `blocked` → `open`, `in_progress`
  - `done` → `closed`, `open`
  - `closed` → `open`

## Claude Code Skill File Format

### File Structure
```
~/.claude/commands/tasks/
├── log-bug.md              # SKILL-01
├── create-task.md          # SKILL-02
├── my-work.md              # SKILL-03
├── show-task.md            # SKILL-04
├── search.md               # SKILL-05
├── pick-up.md              # SKILL-06
├── done.md                 # SKILL-07
├── blocked.md              # SKILL-08
├── add-comment.md          # SKILL-09
└── project-status.md       # SKILL-10
```

Skills in `~/.claude/commands/tasks/` create the `/tasks:*` namespace automatically.

### YAML Frontmatter

**Required fields:**
```yaml
---
name: skill-name
description: What skill does and when to use it (third person, includes triggers)
---
```

**Optional fields:**
- `argument-hint`: Shown during autocomplete (e.g., `[task-id]`, `[title] [description]`)
- `disable-model-invocation`: Set `true` to prevent Claude auto-triggering (user-only invocation)
- `user-invocable`: Set `false` to hide from `/` menu (Claude-only invocation)
- `allowed-tools`: Tools Claude can use without asking permission when skill is active

**Naming rules:**
- Max 64 characters
- Lowercase letters, numbers, hyphens only
- No XML tags, no reserved words ("anthropic", "claude")

**Description rules:**
- Max 1024 characters
- Non-empty, no XML tags
- **MUST be third person** (system prompt injection)
- Include BOTH what it does AND when to use it
- Example: "Creates a bug report task with high priority. Use when user reports a bug, mentions an issue, or asks to log a problem."

### Markdown Body

**Best practices:**
- Keep under 500 lines (token budget optimization)
- Use imperative/infinitive form throughout
- Reference MCP tools with fully qualified names: `wood-fired-bugs:tool_name`
- For workflows with side effects: set `disable-model-invocation: true`
- For reference knowledge: set `user-invocable: false`

**String substitutions:**
- `$ARGUMENTS`: All arguments passed to skill
- `$ARGUMENTS[N]` or `$N`: Specific argument by 0-based index
- `${CLAUDE_SESSION_ID}`: Current session ID

**Example structure:**
```markdown
---
name: log-bug
description: Creates a bug report task with high priority. Use when user reports a bug, mentions an issue, or asks to log a problem.
argument-hint: [title] [description]
disable-model-invocation: false
---

Create a bug report task using the following workflow:

1. Use `wood-fired-bugs:create_task` with:
   - title: $ARGUMENTS[0] (or extracted from $ARGUMENTS)
   - description: $ARGUMENTS[1] or extracted text
   - priority: 'high'
   - project_id: (get from context or ask user)
   - created_by: 'user' (or from session context)
   - tags: ['bug']

2. Confirm task created with ID and title
```

## Skill-to-Tool Mapping

### SKILL-01: /tasks:log-bug
**MCP tools needed:**
- `wood-fired-bugs:create_task` (priority='high', tags=['bug'])

**Workflow:**
1. Parse title and optional description from arguments
2. Get project_id (from context or prompt)
3. Call create_task with high priority
4. Confirm creation

### SKILL-02: /tasks:create-task
**MCP tools needed:**
- `wood-fired-bugs:create_task`

**Workflow:**
1. Parse arguments for title, project, priority, assignee
2. Validate priority enum ('low'|'medium'|'high'|'urgent')
3. Call create_task with parameters
4. Confirm creation

### SKILL-03: /tasks:my-work
**MCP tools needed:**
- `wood-fired-bugs:list_tasks` (filter by assignee)

**Workflow:**
1. Get current user from context
2. Call list_tasks with assignee filter
3. Format results grouped by status

### SKILL-04: /tasks:show-task
**MCP tools needed:**
- `wood-fired-bugs:get_task`
- `wood-fired-bugs:get_comments` (optional, for full context)
- `wood-fired-bugs:get_dependencies` (optional, for blockers)

**Workflow:**
1. Parse task ID from arguments
2. Call get_task
3. Optionally fetch comments and dependencies
4. Display formatted task details

### SKILL-05: /tasks:search
**MCP tools needed:**
- `wood-fired-bugs:list_tasks` (with search filter)

**Workflow:**
1. Extract search keyword from arguments
2. Call list_tasks with search parameter
3. Display matching tasks

### SKILL-06: /tasks:pick-up
**MCP tools needed:**
- `wood-fired-bugs:get_task` (verify exists)
- `wood-fired-bugs:update_task` (set assignee + status)

**Workflow:**
1. Parse task ID from arguments
2. Get current user from context
3. Call update_task with assignee=user, status='in_progress'
4. Confirm assignment and status change

### SKILL-07: /tasks:done
**MCP tools needed:**
- `wood-fired-bugs:update_task` (set status='done')

**Workflow:**
1. Parse task ID from arguments
2. Call update_task with status='done'
3. Confirm completion

### SKILL-08: /tasks:blocked
**MCP tools needed:**
- `wood-fired-bugs:update_task` (set status='blocked')
- `wood-fired-bugs:add_comment` (record reason)

**Workflow:**
1. Parse task ID and reason from arguments
2. Call update_task with status='blocked'
3. Call add_comment with reason as content
4. Confirm blocked status and reason recorded

### SKILL-09: /tasks:add-comment
**MCP tools needed:**
- `wood-fired-bugs:add_comment`

**Workflow:**
1. Parse task ID and comment text from arguments
2. Get current user from context
3. Call add_comment with task_id, author, content
4. Confirm comment added

### SKILL-10: /tasks:project-status
**MCP tools needed:**
- `wood-fired-bugs:list_projects`
- `wood-fired-bugs:list_tasks` (per project, grouped by status)

**Workflow:**
1. Call list_projects to get all projects
2. For each project, call list_tasks with project_id filter
3. Group tasks by status
4. Display summary with counts and breakdowns

## Architecture Patterns

### Pattern 1: Single MCP Tool Wrapper
**When to use:** Skill directly maps to one MCP tool (SKILL-07: done)

```markdown
---
name: done
description: Marks a task as complete. Use when user finishes a task or says 'mark done', 'complete', or 'finished'.
argument-hint: [task-id]
---

Mark task as done:

1. Call `wood-fired-bugs:update_task` with:
   - id: $ARGUMENTS[0]
   - updates: { status: 'done' }

2. Confirm task marked as done
```

### Pattern 2: Multi-Tool Workflow
**When to use:** Skill orchestrates multiple MCP tools (SKILL-08: blocked)

```markdown
---
name: blocked
description: Marks a task as blocked and records the reason. Use when user reports a blocker, dependency, or impediment.
argument-hint: [task-id] [reason]
---

Mark task as blocked and record reason:

1. Call `wood-fired-bugs:update_task` with:
   - id: $ARGUMENTS[0]
   - updates: { status: 'blocked' }

2. Call `wood-fired-bugs:add_comment` with:
   - task_id: $ARGUMENTS[0]
   - author: (current user)
   - content: "BLOCKED: $ARGUMENTS[1]"

3. Confirm task marked blocked and reason recorded
```

### Pattern 3: Aggregation Workflow
**When to use:** Skill queries multiple resources and formats results (SKILL-10: project-status)

```markdown
---
name: project-status
description: Shows project overview with task counts by status. Use when user asks about project status, progress, or overview.
---

Show project status overview:

1. Call `wood-fired-bugs:list_projects`

2. For each project:
   a. Call `wood-fired-bugs:list_tasks` with filter: { project_id: <id> }
   b. Group results by status

3. Display summary:
   - Project name
   - Total tasks
   - Breakdown: X open, Y in progress, Z done, W blocked

4. Optionally highlight projects with many blocked tasks
```

### Anti-Patterns to Avoid

**❌ Unqualified MCP tool names:**
```markdown
Use create_task to add a task  # WRONG - tool not found error
```

**✅ Fully qualified names:**
```markdown
Use wood-fired-bugs:create_task to add a task  # CORRECT
```

**❌ Hardcoded assumptions:**
```markdown
Set project_id to 1  # WRONG - project may not exist
```

**✅ Get from context or prompt:**
```markdown
Get project_id from context or ask user which project
```

**❌ Vague descriptions:**
```markdown
description: Manages tasks  # WRONG - too vague
```

**✅ Specific with triggers:**
```markdown
description: Marks a task as complete. Use when user finishes a task or says 'mark done', 'complete', or 'finished'.
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP tool discovery | Custom server introspection | Hardcode tool names from Phase 11 verification | Tool list is stable, discovery adds complexity |
| User identity | Custom auth system | Use `created_by` parameter with placeholder | Auth is Phase 14 concern, use simple placeholder now |
| Task validation | Custom validators in skill files | Trust MCP server's Zod schemas | Server already validates, duplication causes drift |
| Status transitions | Custom validation in skills | Document valid transitions, let server enforce | Server has VALID_STATUS_TRANSITIONS map |

**Key insight:** Skills orchestrate, servers enforce. Keep validation logic in the MCP server, keep workflow logic in skills.

## Common Pitfalls

### Pitfall 1: Tool Name Resolution Failures
**What goes wrong:** Skill references `create_task` instead of `wood-fired-bugs:create_task`, Claude cannot find tool

**Why it happens:** Documentation shows short names, MCP requires fully qualified names when multiple servers present

**How to avoid:** Always use format `<server-name>:<tool-name>`. Server name is `wood-fired-bugs` from MCP server registration

**Warning signs:** Tool invocation errors, "tool not found" messages during testing

### Pitfall 2: First-Person Descriptions
**What goes wrong:** Description says "I can help you create tasks", Claude misinterprets or ignores skill

**Why it happens:** Descriptions are injected into system prompt, inconsistent POV confuses model

**How to avoid:** Always use third person: "Creates tasks in a project. Use when..."

**Warning signs:** Skill doesn't trigger when expected, Claude doesn't suggest skill

### Pitfall 3: Over-Engineered Workflows
**What goes wrong:** Skill tries to handle every edge case, exceeds 500-line limit, bloats context

**Why it happens:** Attempting to be comprehensive without using progressive disclosure

**How to avoid:**
- Keep main skill simple and direct
- Handle 80% case in main skill
- For advanced features: note them in skill but don't implement
- Trust Claude to adapt based on context

**Warning signs:** Skill file exceeds 300 lines, nested conditionals, extensive error handling

### Pitfall 4: Missing `created_by` Parameter
**What goes wrong:** `create_task` fails with "created_by is required" error

**Why it happens:** Schema requires `created_by` (min 1 char), skill doesn't provide it

**How to avoid:** Always include `created_by` parameter, use placeholder "user" for now (auth comes in Phase 14)

**Warning signs:** Task creation errors mentioning "created_by"

### Pitfall 5: Invalid Status Transitions
**What goes wrong:** Skill tries to transition `open` → `done` directly, server may reject (depends on Phase 11 implementation)

**Why it happens:** Not following VALID_STATUS_TRANSITIONS map from task.ts

**How to avoid:**
- Document valid transitions in skill for Claude's reference
- Let server enforce, but guide Claude to use valid paths
- For "done" skill, check current status and go through `in_progress` if needed

**Warning signs:** Status update errors, tasks stuck in wrong status

## Code Examples

### Example 1: Simple Single-Tool Skill (SKILL-07)

```markdown
---
name: done
description: Marks a task as complete (status 'done'). Use when user finishes a task or says 'mark done', 'complete', or 'finished'.
argument-hint: [task-id]
disable-model-invocation: false
---

Mark task as done:

1. Validate input:
   - Task ID: $ARGUMENTS[0] (required, must be positive integer)

2. Update task status:
   ```
   Call: wood-fired-bugs:update_task
   Parameters:
   {
     "id": <task-id>,
     "updates": {
       "status": "done"
     }
   }
   ```

3. Confirm completion:
   - Display: "Task <id> marked as done: <title>"
   - Include updated status in response

**Valid status transitions to 'done':**
- in_progress → done (normal completion)
- blocked → open → in_progress → done (if currently blocked)
- done → done (idempotent, no error)

**Note:** Tasks in 'open' status should typically move to 'in_progress' first, but 'open → done' is technically valid if the task was completed without being picked up.
```

### Example 2: Multi-Tool Workflow (SKILL-06)

```markdown
---
name: pick-up
description: Assigns a task to the current user and sets status to 'in_progress'. Use when user wants to start working on a task, pick up a task, or claim a task.
argument-hint: [task-id]
disable-model-invocation: false
---

Pick up a task (assign to self and start):

1. Validate input:
   - Task ID: $ARGUMENTS[0] (required, positive integer)

2. Get current user:
   - Use session context if available
   - Otherwise use placeholder: "user"

3. Update task:
   ```
   Call: wood-fired-bugs:update_task
   Parameters:
   {
     "id": <task-id>,
     "updates": {
       "assignee": <current-user>,
       "status": "in_progress"
     }
   }
   ```

4. Confirm assignment:
   - Display: "Task <id> assigned to <user> and set to 'in_progress'"
   - Show task title and priority
   - Mention estimated time if present

**Valid status transitions:**
- open → in_progress (normal pickup)
- blocked → in_progress (unblocking and starting)

**Note:** If task is already 'in_progress' or 'done', inform user of current status before updating.
```

### Example 3: Aggregation Workflow (SKILL-10)

```markdown
---
name: project-status
description: Shows project overview with task counts by status. Use when user asks about project status, progress, overview, or summary.
disable-model-invocation: false
---

Show project status overview:

1. Get all projects:
   ```
   Call: wood-fired-bugs:list_projects
   Parameters: {}
   ```

2. For each project, get task breakdown:
   ```
   Call: wood-fired-bugs:list_tasks
   Parameters:
   {
     "project_id": <project-id>
   }
   ```

3. Group tasks by status:
   - Count tasks in each status: open, in_progress, done, closed, blocked
   - Calculate completion percentage: (done + closed) / total

4. Format output:
   ```
   Project: <name>
   Total tasks: <count>
   - Open: <count>
   - In Progress: <count>
   - Done: <count>
   - Blocked: <count> (⚠️ if > 0)
   - Closed: <count>
   Completion: <percentage>%
   ```

5. Highlight issues:
   - ⚠️ Projects with >20% tasks blocked
   - ✓ Projects with >80% completion

**Optional enhancements:**
- Filter by project ID if specified in arguments
- Show recently updated tasks
- Include assignee distribution
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `.claude/commands/` with implicit namespace | `.claude/commands/<namespace>/` for explicit namespacing | Claude Code 2025+ | Skills in `commands/tasks/` create `/tasks:*` commands automatically |
| Skill descriptions as summaries | Skill descriptions with triggers | 2025 | Better skill discovery requires both "what" and "when" in description |
| Progressive disclosure optional | Progressive disclosure recommended | 2025 | 500-line limit makes splitting files into SKILL.md + references/ necessary for complex skills |
| Short MCP tool names | Fully qualified MCP tool names | MCP SDK 2025 | Multi-server environments require `server:tool` format |

**Deprecated/outdated:**
- `.claude/commands/skill.md` (flat structure): Still works but lacks supporting files capability. Migrate to `.claude/commands/namespace/skill.md` for progressive disclosure.
- First-person skill descriptions: Causes skill discovery issues with system prompt injection.

## Open Questions

1. **User identity source**
   - What we know: Skills need `created_by` and `author` parameters for tasks and comments
   - What's unclear: Where to get current user identity (Phase 14 covers auth)
   - Recommendation: Use placeholder "user" for now, document where to inject real identity later

2. **Error handling verbosity**
   - What we know: MCP server returns structured errors via convertToMcpError
   - What's unclear: How much error detail to include in skill instructions
   - Recommendation: Document happy path in skills, let Claude handle errors naturally. Don't over-specify error handling.

3. **Skill invocation defaults**
   - What we know: Skills default to user + Claude invocation
   - What's unclear: Which skills should be user-only (disable-model-invocation: true)?
   - Recommendation: Start with all skills Claude-invokable, restrict only if Claude over-triggers during testing

## Sources

### Primary (HIGH confidence)
- `/home/stuart/wood-fired-bugs/src/mcp/server.ts` - MCP server registration (25 tools verified)
- `/home/stuart/wood-fired-bugs/src/mcp/tools/task-tools.ts` - Task tool implementations (7 tools)
- `/home/stuart/wood-fired-bugs/src/mcp/tools/project-tools.ts` - Project tool implementations (5 tools)
- `/home/stuart/wood-fired-bugs/src/mcp/tools/dependency-tools.ts` - Dependency tool implementations (3 tools)
- `/home/stuart/wood-fired-bugs/src/mcp/tools/comment-tools.ts` - Comment tool implementations (3 tools)
- `/home/stuart/wood-fired-bugs/src/mcp/tools/health-tools.ts` - Health tool implementations (1 tool)
- `/home/stuart/wood-fired-bugs/src/schemas/task.schema.ts` - Zod schemas for validation
- `/home/stuart/wood-fired-bugs/src/types/task.ts` - Type definitions and status transitions
- https://code.claude.com/docs/en/skills - Official Claude Code skill documentation
- https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices - Official skill authoring best practices

### Secondary (MEDIUM confidence)
- https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md - Example skill file format from official skills repository

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Official documentation verified with codebase inspection
- Architecture: HIGH - MCP tool inventory complete, skill-to-tool mapping documented
- Pitfalls: HIGH - Derived from official best practices and codebase constraints

**Research date:** 2026-02-13
**Valid until:** 2026-03-15 (30 days for stable domain)
