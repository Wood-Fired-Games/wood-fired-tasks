---
phase: 12-skill-file-authoring
plan: 04
subsystem: skills
tags: [skills, orchestration, project-status, aggregation]
dependency_graph:
  requires:
    - wood-fired-bugs MCP server (list_projects, list_tasks tools)
  provides:
    - /tasks:project-status command for project overview
  affects:
    - Claude Code skills interface
tech_stack:
  added: []
  patterns:
    - Multi-tool orchestration (list_projects → list_tasks per project)
    - Task aggregation and grouping by status
    - Completion percentage calculation
key_files:
  created:
    - skills/tasks/project-status.md
  modified: []
decisions:
  - summary: "Use text labels like 'ATTENTION:' instead of emojis for accessibility"
    rationale: "Skill authoring best practices require no emojis"
  - summary: "Support project filtering via $ARGUMENTS for single-project view"
    rationale: "Allows users to focus on specific project without showing all"
metrics:
  duration_minutes: 0.7
  tasks_completed: 1
  files_created: 1
  files_modified: 0
  tests_added: 0
  commits: 1
  completed_date: 2026-02-14
---

# Phase 12 Plan 04: Project Status Skill Summary

**One-liner:** Project overview skill aggregating task counts by status across all projects with completion percentages and blocked task highlights.

## What Was Built

Created `skills/tasks/project-status.md` - a Claude Code skill that provides comprehensive project overview with task breakdowns.

**Core workflow:**
1. Calls `wood-fired-bugs:list_projects` to get all projects
2. For each project, calls `wood-fired-bugs:list_tasks` with project_id filter
3. Groups tasks by status (open, in_progress, done, blocked, closed)
4. Calculates completion percentage: (done + closed) / total * 100
5. Formats output with per-project status breakdown
6. Highlights projects needing attention (blocked tasks) and nearly complete (>80%)
7. Shows overall statistics across all projects

**Features:**
- Multi-tool orchestration pattern (most complex skill so far)
- Project filtering via $ARGUMENTS for focused view
- Empty state handling with helpful message
- Accessibility-focused (text labels instead of emojis)

**YAML frontmatter:**
- name: project-status
- description: Third-person with trigger phrases (status, progress, overview, dashboard, summary)
- disable-model-invocation: false (requires Claude to process and aggregate data)

## Deviations from Plan

None - plan executed exactly as written.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 5c6736f | Create project-status skill file with aggregation workflow |

## Verification Results

All verification criteria met:
- [x] File exists at skills/tasks/project-status.md
- [x] Valid YAML frontmatter with required fields
- [x] References both list_projects and list_tasks (fully qualified)
- [x] Under 100 lines (64 lines)
- [x] Third-person description with trigger phrases
- [x] Orchestrates list_projects followed by list_tasks per project
- [x] Includes per-project status breakdown and completion percentage
- [x] Highlights blocked tasks and high-completion projects
- [x] No emojis (uses "ATTENTION:" instead)

## Impact

**Capabilities Added:**
- `/tasks:project-status` command for project dashboard view
- Task aggregation and status grouping across all projects
- Completion tracking and progress visibility
- Blocked task detection for attention management

**Integration Points:**
- wood-fired-bugs:list_projects
- wood-fired-bugs:list_tasks

**User Experience:**
Users can now ask "show me project status" or "what's the project dashboard" and get:
- All projects with task counts by status
- Completion percentages
- Flagged blocked tasks needing attention
- Overall project health at a glance

## Next Steps

This completes Plan 04. Phase 12 is now complete (4/4 plans finished).

**Ready for:** Phase 13 (Installer) or final milestone verification.

## Self-Check

Verifying claimed artifacts exist:

**Files:**
- FOUND: skills/tasks/project-status.md

**Commits:**
- FOUND: 5c6736f

## Self-Check: PASSED

All claimed artifacts verified successfully.
