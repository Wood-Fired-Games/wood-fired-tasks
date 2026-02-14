---
phase: quick-2
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/mcp/__tests__/dependency-tools.test.ts
  - src/mcp/__tests__/comment-tools.test.ts
  - src/mcp/__tests__/e2e-regression.test.ts
autonomous: true
must_haves:
  truths:
    - "All 3 MCP dependency tools (add_dependency, remove_dependency, get_dependencies) have passing tests"
    - "All 3 MCP comment tools (add_comment, get_comments, delete_comment) have passing tests"
    - "E2E regression test exercises full workflow through MCP: project creation -> task lifecycle -> dependencies -> comments -> completion"
    - "All 10 skill files pass structural validation (valid frontmatter, referenced MCP tools exist)"
    - "All existing 361 tests continue to pass (no regressions)"
  artifacts:
    - path: "src/mcp/__tests__/dependency-tools.test.ts"
      provides: "MCP dependency tool test coverage"
      min_lines: 150
    - path: "src/mcp/__tests__/comment-tools.test.ts"
      provides: "MCP comment tool test coverage"
      min_lines: 150
    - path: "src/mcp/__tests__/e2e-regression.test.ts"
      provides: "Cross-cutting E2E regression tests and skill file validation"
      min_lines: 150
  key_links:
    - from: "src/mcp/__tests__/dependency-tools.test.ts"
      to: "src/mcp/tools/dependency-tools.ts"
      via: "MCP client callTool"
      pattern: "callTool.*add_dependency|remove_dependency|get_dependencies"
    - from: "src/mcp/__tests__/comment-tools.test.ts"
      to: "src/mcp/tools/comment-tools.ts"
      via: "MCP client callTool"
      pattern: "callTool.*add_comment|get_comments|delete_comment"
    - from: "src/mcp/__tests__/e2e-regression.test.ts"
      to: "src/mcp/server.ts"
      via: "Full MCP server with all tools"
      pattern: "create_project.*create_task.*update_task"
---

<objective>
Create comprehensive automated tests to close MCP tool coverage gaps and add E2E regression testing.

Purpose: The MCP dependency-tools and comment-tools have zero MCP-level test coverage despite being registered in the server. Skill files (v1.2 addition) have no validation tests. No cross-cutting E2E test exercises the full task lifecycle through MCP. This plan closes all four gaps.

Output: 3 new test files adding ~40+ new test cases, bringing total coverage from 361 to ~400+ tests.
</objective>

<execution_context>
@/home/stuart/.claude/get-shit-done/workflows/execute-plan.md
@/home/stuart/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/mcp/__tests__/task-tools.test.ts (pattern: MCP test setup with InMemoryTransport, ToolResult interface, beforeEach/afterEach lifecycle)
@src/mcp/__tests__/project-tools.test.ts (pattern: identical setup, good reference for structuredContent assertions)
@src/mcp/tools/dependency-tools.ts (3 tools: add_dependency, remove_dependency, get_dependencies)
@src/mcp/tools/comment-tools.ts (3 tools: add_comment, get_comments, delete_comment)
@src/mcp/server.ts (createMcpServer factory - all services needed)
@skills/tasks/create-task.md (skill file structure reference: frontmatter with name, description, disable-model-invocation)
@vitest.config.ts (globals: true, fileParallelism: false)
</context>

<tasks>

<task type="auto">
  <name>Task 1: MCP dependency-tools and comment-tools test suites</name>
  <files>src/mcp/__tests__/dependency-tools.test.ts, src/mcp/__tests__/comment-tools.test.ts</files>
  <action>
Create two test files following the EXACT pattern from task-tools.test.ts:
- Same imports: vitest, createTestApp, createMcpServer, Client, InMemoryTransport
- Same ToolResult interface definition
- Same beforeEach (createTestApp, create test project, createMcpServer with all 5 args, InMemoryTransport.createLinkedPair, server.connect, client.connect)
- Same afterEach (close transports, close db)

**dependency-tools.test.ts** — Test all 3 tools:

`add_dependency`:
- Creates dependency between two tasks (verify text contains "Dependency created", structuredContent has dependency object with id, task_id, blocks_task_id, created_at)
- Returns error when task_id does not exist (expect isError: true)
- Returns error when blocks_task_id does not exist (expect isError: true)
- Returns error for self-dependency (task_id === blocks_task_id)
- Returns error for duplicate dependency

`remove_dependency`:
- Removes an existing dependency (verify text contains "no longer blocks")
- Returns error when dependency does not exist (expect isError: true)

`get_dependencies`:
- Returns blocks and blocked_by for a task with dependencies (create tasks A, B, C; A blocks B, C blocks B; call get_dependencies for B; verify structuredContent has blocks=[] and blocked_by with A and C)
- Returns empty arrays for task with no dependencies
- Handles task that blocks others (create A blocks B; get_dependencies for A; verify blocks has B, blocked_by is empty)

**comment-tools.test.ts** — Test all 3 tools:

`add_comment`:
- Adds comment to existing task (verify text contains "Comment added by", structuredContent has comment object with id, task_id, author, content, created_at, updated_at)
- Returns error for non-existent task_id (expect isError: true)
- Validates required fields: empty author returns error, empty content returns error

`get_comments`:
- Returns comments in chronological order (add 3 comments, verify structuredContent.comments has length 3 and text says "Found 3 comment(s)")
- Returns empty array for task with no comments (verify text contains "Found 0 comment(s)")
- Returns error for non-existent task (expect isError: true)

`delete_comment`:
- Deletes existing comment (verify text contains "deleted successfully", then get_comments returns 0)
- Returns error for non-existent comment_id (expect isError: true)

IMPORTANT: Both test files need tasks created via `app.taskService.createTask()` in the test setup (not via MCP), since these tools operate on existing tasks. Create 2-3 tasks in beforeEach for dependency tests.
  </action>
  <verify>
Run `npx vitest run src/mcp/__tests__/dependency-tools.test.ts src/mcp/__tests__/comment-tools.test.ts` — all tests pass. Then run full suite `npx vitest run` — all 361+ tests pass with zero failures.
  </verify>
  <done>
dependency-tools.test.ts has 10+ tests covering add_dependency (5 cases: success, missing task, missing blocks_task, self-dep, duplicate), remove_dependency (2 cases: success, not found), get_dependencies (3 cases: with deps, no deps, blocks others). comment-tools.test.ts has 8+ tests covering add_comment (3 cases: success, bad task, validation), get_comments (3 cases: multiple, empty, bad task), delete_comment (2 cases: success, not found). All pass alongside existing suite.
  </done>
</task>

<task type="auto">
  <name>Task 2: E2E regression suite with skill file validation</name>
  <files>src/mcp/__tests__/e2e-regression.test.ts</files>
  <action>
Create a single comprehensive test file with two describe blocks:

**Block 1: "E2E Regression: Full Task Lifecycle"** — Uses the same MCP InMemoryTransport test pattern.

Test: "complete project workflow through MCP"
1. create_project with name "Regression Test Project" — verify success
2. create_task with title "Implement feature", project_id from step 1, priority "high", created_by "regression-test" — verify success, capture task1_id
3. create_task with title "Write tests", same project, priority "medium", created_by "regression-test" — capture task2_id
4. add_dependency: task2 blocks task1 (tests must be written before feature ships) — verify dependency created
5. add_comment on task1: author "tester", content "Starting work on this feature" — verify comment added
6. update_task task1 status to "in_progress" — verify success
7. get_task task1 — verify status is "in_progress", priority is "high"
8. get_dependencies task1 — verify blocked_by contains task2
9. get_comments task1 — verify 1 comment exists
10. update_task task2 status to "in_progress" then "done" — verify success
11. remove_dependency task2 blocks task1 — verify removed
12. update_task task1 status to "done" — verify success
13. list_tasks with status "done" — verify both tasks appear
14. delete_task task2 — verify deleted
15. delete_project — verify deleted (or skip if cascading not supported; just verify project existed)

This single test exercises ALL tool categories (task, project, dependency, comment) in one realistic workflow.

Test: "handles errors gracefully across tool boundaries"
- Create project, create task, try add_dependency with non-existent blocks_task_id — verify isError true
- Try add_comment on non-existent task — verify isError true
- Try update_task with invalid status transition — verify isError true
- All errors should have meaningful text content (not empty strings)

**Block 2: "Skill File Validation"** — Does NOT need MCP transport. Uses fs/path to read skill files directly.

Import `fs` and `path` from node builtins. Define SKILLS_DIR as path to `skills/tasks/`.

Test: "all skill files have valid frontmatter"
- Read all .md files from skills/tasks/
- For each file, parse the YAML frontmatter between `---` delimiters
- Assert: `name` field exists and is a non-empty string
- Assert: `description` field exists and is a non-empty string
- Assert: `disable-model-invocation` field exists and is a boolean (false)
- Use `describe.each` or a loop with meaningful assertion messages that include the filename

Test: "all skill files reference valid MCP tool names"
- Define the set of known MCP tool names: create_task, get_task, update_task, list_tasks, delete_task, list_subtasks, get_subtasks, create_project, get_project, update_project, list_projects, delete_project, add_dependency, remove_dependency, get_dependencies, add_comment, get_comments, delete_comment, check_health
- For each skill file, extract all `wood-fired-bugs:TOOL_NAME` references from the content
- Assert each referenced tool name exists in the known tools set
- This catches skill files that reference tools that were renamed or removed

Test: "skill file count matches expected (10 files)"
- Assert exactly 10 .md files exist in skills/tasks/
- Catches accidental deletion or addition without corresponding test updates

Test: "each skill file has workflow steps"
- For each skill file, assert it contains at least one "## " heading (H2 section)
- Assert it contains numbered steps (regex: /^\d+\.\s/m)
- This validates the files are actual workflow documents, not empty stubs

NOTE on installers: Do NOT test install.sh or install.ps1 execution (they modify system state like ~/.claude.json). The skill file validation tests above cover the key v1.2 deliverable — that all 10 skill files are structurally valid and reference real tools. Installer testing is better left to manual smoke tests or CI with Docker isolation.
  </action>
  <verify>
Run `npx vitest run src/mcp/__tests__/e2e-regression.test.ts` — all tests pass. Then run full suite `npx vitest run` — all tests pass (should now be ~380+ total). Verify skill validation catches a real problem by temporarily checking what happens if a tool name is wrong in the assertion (it would fail — confirms the test is actually validating).
  </verify>
  <done>
e2e-regression.test.ts contains: (1) a full lifecycle regression test exercising project + task + dependency + comment tools in sequence, (2) a cross-boundary error handling test, (3) skill frontmatter validation across all 10 files, (4) MCP tool reference validation for skill files, (5) skill file count assertion, (6) workflow structure validation. Full test suite passes with 380+ tests total, zero failures.
  </done>
</task>

</tasks>

<verification>
1. `npx vitest run` — ALL tests pass (zero failures), total count is 380+
2. `npx vitest run src/mcp/__tests__/dependency-tools.test.ts` — isolated run passes
3. `npx vitest run src/mcp/__tests__/comment-tools.test.ts` — isolated run passes
4. `npx vitest run src/mcp/__tests__/e2e-regression.test.ts` — isolated run passes
5. No TypeScript errors: `npx tsc --noEmit` passes (or at least no new errors in test files)
</verification>

<success_criteria>
- 3 new test files created, all passing
- MCP dependency-tools: 10+ test cases covering all 3 tools (happy path + error cases)
- MCP comment-tools: 8+ test cases covering all 3 tools (happy path + error cases)
- E2E regression: 1 full lifecycle test (15 steps), 1 error boundary test
- Skill validation: 4 tests validating all 10 skill files (frontmatter, tool refs, count, structure)
- Total test count: 380+ (up from 361)
- Existing 361 tests still pass (no regressions introduced)
</success_criteria>

<output>
After completion, create `.planning/quick/2-create-comprehensive-automated-tests-for/2-SUMMARY.md`
</output>
