---
phase: 12-skill-file-authoring
plan: 02
subsystem: Claude Code Skills
tags: [skills, task-workflows, mcp-integration]
dependency_graph:
  requires:
    - skills/tasks/ directory structure (from 12-01)
    - wood-fired-bugs MCP server tools (get_task, list_tasks, update_task, get_comments, get_dependencies)
  provides:
    - skills/tasks/show-task.md (task detail viewer)
    - skills/tasks/search.md (task search)
    - skills/tasks/pick-up.md (task assignment workflow)
  affects:
    - User workflows for task inspection and claiming
    - MCP tool usage patterns in Claude Code
tech_stack:
  added: []
  patterns:
    - Multi-tool workflows (show-task uses 3 tools)
    - Search filter patterns (list_tasks with search parameter)
    - State transition workflows (pick-up updates assignee + status)
key_files:
  created:
    - skills/tasks/show-task.md
    - skills/tasks/search.md
    - skills/tasks/pick-up.md
  modified: []
decisions:
  - decision: "Use placeholder 'user' for current user identity in pick-up skill"
    rationale: "Claude Code doesn't have built-in user identity resolution; skills documentation pattern uses placeholder approach"
    alternatives: ["Environment variable lookup", "Tool-based identity resolution"]
  - decision: "Include optional status check before pick-up to warn on reassignment"
    rationale: "Better UX to inform user if task is already in_progress or done before updating"
    alternatives: ["Direct update without check", "Mandatory confirmation prompt"]
  - decision: "Show-task fetches get_task, get_comments, get_dependencies in parallel"
    rationale: "Improves performance and demonstrates multi-tool coordination pattern"
    alternatives: ["Sequential fetching", "Single combined tool"]
metrics:
  duration_minutes: 1.6
  tasks_completed: 3
  files_created: 3
  commits: 3
  completed_date: 2026-02-14
---

# Phase 12 Plan 02: Task Retrieval & Action Skills Summary

Created three Claude Code skill files for task retrieval and workflow actions: show-task (detailed task viewer with comments/dependencies), search (keyword-based task finder), and pick-up (task assignment with status transition).

## Objective

Create skill files enabling users to view task details, search tasks by keyword, and claim tasks through `/tasks:*` slash commands.

## Tasks Completed

| Task | Name | Commit | Files Created | Lines |
|------|------|--------|---------------|-------|
| 1 | Create show-task skill file | 406c014 | skills/tasks/show-task.md | 60 |
| 2 | Create search skill file | 690c9f9 | skills/tasks/search.md | 47 |
| 3 | Create pick-up skill file | f08d010 | skills/tasks/pick-up.md | 51 |

**Total:** 3 tasks, 3 files created, 158 lines of skill documentation

## Implementation Details

### show-task.md (Multi-tool Workflow)
- **Purpose:** Displays comprehensive task details with related data
- **Tools Used:**
  - `wood-fired-bugs:get_task` (core task data)
  - `wood-fired-bugs:get_comments` (task comments)
  - `wood-fired-bugs:get_dependencies` (blocker/blocked-by relationships)
- **Features:**
  - Status indicators (✓ ○ ▶ ⏸)
  - Optional fields handling (due date, estimated time, tags)
  - Chronological comment display
  - Dependency relationship visualization
- **Line Count:** 60 (well under 100-line limit)

### search.md (Single-tool Workflow)
- **Purpose:** Searches tasks by keyword across titles and descriptions
- **Tools Used:**
  - `wood-fired-bugs:list_tasks` with search filter
- **Features:**
  - Compact result format (ID, status, priority, assignee)
  - Total count display
  - No-results handling with suggestions
  - Example output provided
- **Line Count:** 47 (under 50-line target)

### pick-up.md (State Transition Workflow)
- **Purpose:** Assigns task to user and transitions to in_progress
- **Tools Used:**
  - `wood-fired-bugs:update_task` (assignee + status)
  - `wood-fired-bugs:get_task` (optional status check)
- **Features:**
  - Valid status transition documentation
  - Current status warning before update
  - Confirmation message with context
  - Error handling for invalid IDs and not-found cases
- **Line Count:** 51 (under 60-line target)

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

All verification checks passed:

1. ✓ All three files exist in skills/tasks/ directory
2. ✓ Each file has valid YAML frontmatter with required fields (name, description, argument-hint)
3. ✓ All MCP tool references use fully qualified names (wood-fired-bugs:tool_name)
4. ✓ No skill file exceeds 100 lines (max was 60 lines)
5. ✓ Descriptions are third-person and include trigger phrases
6. ✓ show-task uses three tools (get_task, get_comments, get_dependencies)
7. ✓ pick-up updates both assignee and status in single update_task call
8. ✓ search uses list_tasks with search filter parameter

## Success Criteria Met

- ✓ skills/tasks/show-task.md displays full task details with comments and dependencies
- ✓ skills/tasks/search.md searches tasks by keyword via list_tasks search filter
- ✓ skills/tasks/pick-up.md assigns task to user and transitions to in_progress
- ✓ All three files have valid YAML frontmatter and follow skill authoring best practices

## Impact

**User Workflows Enabled:**
- `/tasks:show-task [id]` - View comprehensive task information
- `/tasks:search [keyword]` - Find tasks by content
- `/tasks:pick-up [id]` - Claim and start working on a task

**MCP Integration:**
- Demonstrates single-tool workflows (search)
- Demonstrates multi-tool coordination (show-task with 3 parallel fetches)
- Demonstrates state transition patterns (pick-up updating multiple fields)

**Documentation Quality:**
- All skills under target line counts
- Clear workflow steps with error handling
- Example outputs where helpful (search)
- Status transition tables (pick-up)

## Next Steps

Phase 12 Plan 03 will create additional skill files for task lifecycle workflows (status updates, commenting, dependencies).

## Self-Check

Verifying created files exist:

```bash
[ -f "skills/tasks/show-task.md" ] && echo "FOUND: skills/tasks/show-task.md"
[ -f "skills/tasks/search.md" ] && echo "FOUND: skills/tasks/search.md"
[ -f "skills/tasks/pick-up.md" ] && echo "FOUND: skills/tasks/pick-up.md"
```

Verifying commits exist:

```bash
git log --oneline --all | grep -q "406c014" && echo "FOUND: 406c014"
git log --oneline --all | grep -q "690c9f9" && echo "FOUND: 690c9f9"
git log --oneline --all | grep -q "f08d010" && echo "FOUND: f08d010"
```

**Self-Check: PASSED**

All files created and all commits verified.
