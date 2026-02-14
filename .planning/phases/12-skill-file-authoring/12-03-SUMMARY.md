---
phase: 12-skill-file-authoring
plan: 03
subsystem: claude-skills
tags: [skill-authoring, task-management, status-transitions, comments]
dependency-graph:
  requires: [wood-fired-bugs-mcp-server]
  provides: [task-done-skill, task-blocked-skill, task-comment-skill]
  affects: [slash-commands, task-workflows]
tech-stack:
  added: []
  patterns: [multi-tool-workflow, argument-parsing, status-validation]
key-files:
  created:
    - skills/tasks/done.md
    - skills/tasks/blocked.md
    - skills/tasks/add-comment.md
  modified: []
decisions: []
metrics:
  duration-minutes: 1.4
  tasks-completed: 3
  files-created: 3
  commits: 3
  completed-date: 2026-02-14
---

# Phase 12 Plan 03: Task Status & Comment Skills Summary

**One-liner:** Three Claude Code skills enabling task completion, blocker tracking with reasons, and comment addition via slash commands.

## What Was Built

Created three skill files in `skills/tasks/` directory:

1. **done.md** - Marks tasks complete via `wood-fired-bugs:update_task`
   - Single-tool workflow (update_task with status: done)
   - Documents valid status transitions (open/in_progress → done)
   - 43 lines

2. **blocked.md** - Marks tasks blocked AND records blocking reason
   - Multi-tool workflow (update_task + add_comment)
   - Requires blocking reason from user
   - Records reason as "BLOCKED: <reason>" comment
   - Documents valid status transitions (open/in_progress → blocked)
   - 50 lines

3. **add-comment.md** - Adds comments to tasks
   - Single-tool workflow (add_comment)
   - Supports notes, feedback, and context annotation
   - Uses 'user' as author placeholder
   - 42 lines

## Task Breakdown

| Task | Name                          | Commit  | Files                         |
|------|-------------------------------|---------|-------------------------------|
| 1    | Create done skill file        | 24918ce | skills/tasks/done.md          |
| 2    | Create blocked skill file     | 9bb7976 | skills/tasks/blocked.md       |
| 3    | Create add-comment skill file | a10d62f | skills/tasks/add-comment.md   |

## Technical Implementation

### Skill Architecture Pattern

All three skills follow consistent structure:
- **YAML frontmatter**: name, description (with trigger phrases), argument-hint, disable-model-invocation
- **Workflow sections**: numbered steps with validation, tool calls, confirmation
- **Error handling**: user-friendly messages for missing/invalid inputs
- **Documentation**: usage examples and expected behavior

### Multi-tool Workflow (blocked.md)

The blocked skill demonstrates multi-tool orchestration:
1. Validates task ID
2. Extracts blocking reason (required from user)
3. Calls `wood-fired-bugs:update_task` to change status
4. Calls `wood-fired-bugs:add_comment` to record reason with "BLOCKED:" prefix
5. Confirms both operations

This pattern ensures blocking reasons are always captured and traceable.

### Tool Reference Compliance

All MCP tool invocations use fully qualified names:
- `wood-fired-bugs:update_task` (done.md, blocked.md)
- `wood-fired-bugs:add_comment` (blocked.md, add-comment.md)

No bare tool names used - ensures proper MCP routing.

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

All success criteria met:
- All three files exist in skills/tasks/ directory ✓
- Each file has valid YAML frontmatter with required fields ✓
- All MCP tool references use fully qualified names ✓
- No file exceeds 100 lines (max: 50) ✓
- Descriptions are third-person with trigger phrases ✓
- blocked skill uses two tools (update_task + add_comment) ✓
- done and add-comment each use one tool ✓
- Status transition documentation included where applicable ✓

## Impact

### User Workflows Enabled

Users can now:
- Mark tasks complete via `/tasks:done <task-id>`
- Flag blockers with reasons via `/tasks:blocked <task-id> <reason>`
- Add context via `/tasks:add-comment <task-id> <comment>`

### Integration Points

- **MCP Server**: Relies on wood-fired-bugs:update_task and wood-fired-bugs:add_comment tools
- **Slash Commands**: Three new /tasks:* commands available in Claude Code
- **Task Lifecycle**: Supports critical status transitions (done, blocked) and annotation

## Self-Check: PASSED

**Files created:**
- FOUND: skills/tasks/done.md
- FOUND: skills/tasks/blocked.md
- FOUND: skills/tasks/add-comment.md

**Commits verified:**
- FOUND: 24918ce (done skill)
- FOUND: 9bb7976 (blocked skill)
- FOUND: a10d62f (add-comment skill)

All claimed artifacts exist and commits are in git history.
