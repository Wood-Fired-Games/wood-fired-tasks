import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { createServer } from '../../api/server.js';
import { RestClient } from '../remote/rest-client.js';
import { seedAuth } from '../../api/__tests__/helpers/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';
import type { Task } from '../../types/task.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// The MCP SDK callTool returns a union of CallToolResult | CompatibilityCallToolResult.
// The index signature makes content/structuredContent resolve to unknown.
// This type represents the standard (non-compatibility) result shape we expect.
interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILLS_DIR = path.resolve(__dirname, '../../../skills/tasks');

// Known MCP tool names in the system. Keep in sync with the tools registered
// in src/mcp/tools/*.ts (server.ts wires them all up at startup).
const KNOWN_MCP_TOOLS = new Set([
  'create_task',
  'get_task',
  'update_task',
  'list_tasks',
  'delete_task',
  'claim_task',
  'list_subtasks',
  'get_subtasks',
  'create_project',
  'get_project',
  'update_project',
  'list_projects',
  'delete_project',
  'add_dependency',
  'remove_dependency',
  'get_dependencies',
  'add_comment',
  'get_comments',
  'delete_comment',
  'check_health',
  'wsjf_ranking',
  'wsjf_history',
  'rescore_project',
  'wsjf_health',
]);

describe('E2E Regression: Full Task Lifecycle', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;

  beforeEach(async () => {
    // Create in-memory test app
    app = await createTestApp();

    // Create MCP server
    const server = createMcpServer(
      app.taskService,
      app.projectService,
      app.dependencyService,
      app.commentService,
      app.db,
    );

    // Create paired in-memory transports
    [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    // Connect server to its transport
    await server.connect(serverTransport);

    // Create and connect client
    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
    app.dispose();
  });

  it('complete project workflow through MCP', async () => {
    // 1. create_project
    const createProjectResult = (await client.callTool({
      name: 'create_project',
      arguments: { name: 'Regression Test Project' },
    })) as ToolResult;

    expect(createProjectResult.isError).toBeFalsy();
    const projectId = (createProjectResult.structuredContent as { id: number }).id;
    expect(projectId).toBeDefined();

    // 2. create_task: "Implement feature" (high priority)
    const createTask1Result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Implement feature',
        project_id: projectId,
        priority: 'high',
        created_by: 'regression-test',
      },
    })) as ToolResult;

    expect(createTask1Result.isError).toBeFalsy();
    const task1Id = (createTask1Result.structuredContent as { id: number }).id;
    expect(task1Id).toBeDefined();

    // 3. create_task: "Write tests" (medium priority)
    const createTask2Result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Write tests',
        project_id: projectId,
        priority: 'medium',
        created_by: 'regression-test',
      },
    })) as ToolResult;

    expect(createTask2Result.isError).toBeFalsy();
    const task2Id = (createTask2Result.structuredContent as { id: number }).id;
    expect(task2Id).toBeDefined();

    // 4. add_dependency: task2 blocks task1 (tests must be written before feature ships)
    const addDepResult = (await client.callTool({
      name: 'add_dependency',
      arguments: {
        task_id: task2Id,
        blocks_task_id: task1Id,
      },
    })) as ToolResult;

    expect(addDepResult.isError).toBeFalsy();
    expect(addDepResult.content[0].text).toContain('Dependency created');

    // 5. add_comment on task1
    const addCommentResult = (await client.callTool({
      name: 'add_comment',
      arguments: {
        task_id: task1Id,
        author: 'tester',
        content: 'Starting work on this feature',
      },
    })) as ToolResult;

    expect(addCommentResult.isError).toBeFalsy();
    expect(addCommentResult.content[0].text).toContain('Comment added by');

    // 6. update_task task1 status to "in_progress"
    const updateTask1Result = (await client.callTool({
      name: 'update_task',
      arguments: {
        id: task1Id,
        updates: { status: 'in_progress' },
      },
    })) as ToolResult;

    expect(updateTask1Result.isError).toBeFalsy();

    // 7. get_task task1 - verify status is "in_progress", priority is "high"
    const getTask1Result = (await client.callTool({
      name: 'get_task',
      arguments: { id: task1Id },
    })) as ToolResult;

    expect(getTask1Result.isError).toBeFalsy();
    const task1Data = getTask1Result.structuredContent as {
      status: string;
      priority: string;
    };
    expect(task1Data.status).toBe('in_progress');
    expect(task1Data.priority).toBe('high');

    // 8. get_dependencies task1 - verify blocked_by contains task2
    const getDepsResult = (await client.callTool({
      name: 'get_dependencies',
      arguments: { task_id: task1Id },
    })) as ToolResult;

    expect(getDepsResult.isError).toBeFalsy();
    const depsData = getDepsResult.structuredContent as {
      blocked_by: Array<{ task_id: number }>;
    };
    expect(depsData.blocked_by).toHaveLength(1);
    expect(depsData.blocked_by[0].task_id).toBe(task2Id);

    // 9. get_comments task1 - verify 1 comment exists
    const getCommentsResult = (await client.callTool({
      name: 'get_comments',
      arguments: { task_id: task1Id },
    })) as ToolResult;

    expect(getCommentsResult.isError).toBeFalsy();
    const commentsData = getCommentsResult.structuredContent as {
      comments: unknown[];
    };
    expect(commentsData.comments).toHaveLength(1);

    // 10. update_task task2 status to "in_progress"
    const updateTask2InProgressResult = (await client.callTool({
      name: 'update_task',
      arguments: {
        id: task2Id,
        updates: { status: 'in_progress' },
      },
    })) as ToolResult;

    expect(updateTask2InProgressResult.isError).toBeFalsy();

    // 11. update_task task2 status to "done"
    const updateTask2DoneResult = (await client.callTool({
      name: 'update_task',
      arguments: {
        id: task2Id,
        updates: { status: 'done' },
      },
    })) as ToolResult;

    expect(updateTask2DoneResult.isError).toBeFalsy();

    // 12. remove_dependency task2 blocks task1
    const removeDepResult = (await client.callTool({
      name: 'remove_dependency',
      arguments: {
        task_id: task2Id,
        blocks_task_id: task1Id,
      },
    })) as ToolResult;

    expect(removeDepResult.isError).toBeFalsy();
    expect(removeDepResult.content[0].text).toContain('no longer blocks');

    // 13. update_task task1 status to "done"
    const updateTask1DoneResult = (await client.callTool({
      name: 'update_task',
      arguments: {
        id: task1Id,
        updates: { status: 'done' },
      },
    })) as ToolResult;

    expect(updateTask1DoneResult.isError).toBeFalsy();

    // 14. list_tasks with status "done" - verify both tasks appear
    const listDoneResult = (await client.callTool({
      name: 'list_tasks',
      arguments: { status: 'done' },
    })) as ToolResult;

    expect(listDoneResult.isError).toBeFalsy();
    // Pagination envelope: "Found 2 of 2 task(s)"
    expect(listDoneResult.content[0].text).toContain('Found 2 of 2 task(s)');

    // 15. delete_task task2
    const deleteTask2Result = (await client.callTool({
      name: 'delete_task',
      arguments: { id: task2Id },
    })) as ToolResult;

    expect(deleteTask2Result.isError).toBeFalsy();
    expect(deleteTask2Result.content[0].text).toContain('deleted');

    // Verify project still exists (cascading test)
    const getProjectResult = (await client.callTool({
      name: 'get_project',
      arguments: { id: projectId },
    })) as ToolResult;

    expect(getProjectResult.isError).toBeFalsy();
  });

  // ── Guaranteed-task-sizing gates over the stdio MCP surface (#995) ─────────
  // These prove the createTask gates (decompose contract, auto-size) behave
  // through the live stdio MCP transport — not just at the service layer. The
  // matching REST + remote-proxy assertions live in the suites below; the
  // cross-surface error-class parity is the point of task #995.

  it('stdio create_task with a decomp-* tag and no wsjf_submission is rejected (decompose gate)', async () => {
    const createProjectResult = (await client.callTool({
      name: 'create_project',
      arguments: { name: 'Decomp Gate Project (stdio)' },
    })) as ToolResult;
    const projectId = (createProjectResult.structuredContent as { id: number }).id;

    const result = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Sizeless decompose leaf',
        project_id: projectId,
        created_by: 'decompose-skill',
        // The decompose skill stamps every materialized leaf with a `decomp-*`
        // tag. Carrying it WITHOUT a `wsjf_submission` is the contract
        // violation the §1 Prong-A gate rejects (the failure class that minted
        // 114 sizeless tasks). No `wsjf` / `wsjf_submission` supplied.
        tags: ['decomp-batch-42'],
      },
    })) as ToolResult;

    // The MCP surface flattens the ValidationError to `MCP error -32602:
    // Validation failed: <field>: <detail>` — task #1603 folded the first
    // fieldErrors entries into the message itself so clients that render
    // only `content[0].text` (not the JSON-RPC error `data`) still see the
    // instructive detail, not just the useless "Validation failed" stub.
    // The full unabridged payload is still asserted via `details.wsjf_submission`
    // on the REST surface in the suite below.
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('MCP error');
      expect(result.content[0].text).toContain('Validation failed');
      expect(result.content[0].text).toContain('wsjf_submission:');
      expect(result.content[0].text).toContain("no 'wsjf_submission'");
    }

    // The gate is a hard reject — no sizeless task was persisted.
    const tasks = app.taskService.listTasks({ project_id: projectId });
    expect(tasks).toHaveLength(0);
  });

  it('stdio create_task without WSJF is auto-sized; get_task shows wsjf_job_size with source auto', async () => {
    const createProjectResult = (await client.callTool({
      name: 'create_project',
      arguments: { name: 'Auto-Size Project (stdio)' },
    })) as ToolResult;
    const projectId = (createProjectResult.structuredContent as { id: number }).id;

    // No `wsjf` / `wsjf_submission`. `estimated_minutes: 20` maps via
    // minutesToTier (>15, <=30) to tier 2.
    const createResult = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Plain WSJF-less task',
        project_id: projectId,
        created_by: 'tester',
        estimated_minutes: 20,
      },
    })) as ToolResult;
    expect(createResult.isError).toBeFalsy();
    const taskId = (createResult.structuredContent as { id: number }).id;

    const getResult = (await client.callTool({
      name: 'get_task',
      arguments: { id: taskId },
    })) as ToolResult;
    expect(getResult.isError).toBeFalsy();
    const taskData = getResult.structuredContent as {
      wsjf_job_size: number | null;
      wsjf_source: { jobSize?: string } | null;
      wsjf_value: number | null;
    };
    // Auto-sized: job size set to the minutes-derived tier with source 'auto',
    // while the three Cost-of-Delay components stay NULL (honestly unscored).
    expect(taskData.wsjf_job_size).toBe(2);
    expect(taskData.wsjf_source?.jobSize).toBe('auto');
    expect(taskData.wsjf_value).toBeNull();
  });

  it('handles errors gracefully across tool boundaries', async () => {
    // Create project and task for testing
    const createProjectResult = (await client.callTool({
      name: 'create_project',
      arguments: { name: 'Error Test Project' },
    })) as ToolResult;

    const projectId = (createProjectResult.structuredContent as { id: number }).id;

    const createTaskResult = (await client.callTool({
      name: 'create_task',
      arguments: {
        title: 'Test Task',
        project_id: projectId,
        created_by: 'tester',
      },
    })) as ToolResult;

    const taskId = (createTaskResult.structuredContent as { id: number }).id;

    // Try add_dependency with non-existent blocks_task_id
    const addDepResult = (await client.callTool({
      name: 'add_dependency',
      arguments: {
        task_id: taskId,
        blocks_task_id: 9999,
      },
    })) as ToolResult;

    expect(addDepResult.isError).toBe(true);
    expect(addDepResult.content[0].text).toBeTruthy();
    expect(addDepResult.content[0].text).toContain('MCP error');

    // Try add_comment on non-existent task
    const addCommentResult = (await client.callTool({
      name: 'add_comment',
      arguments: {
        task_id: 9999,
        author: 'tester',
        content: 'This should fail',
      },
    })) as ToolResult;

    expect(addCommentResult.isError).toBe(true);
    expect(addCommentResult.content[0].text).toBeTruthy();
    expect(addCommentResult.content[0].text).toContain('MCP error');

    // Try invalid status transition (open -> done without in_progress)
    const updateResult = (await client.callTool({
      name: 'update_task',
      arguments: {
        id: taskId,
        updates: { status: 'done' },
      },
    })) as ToolResult;

    expect(updateResult.isError).toBe(true);
    expect(updateResult.content[0].text).toBeTruthy();
    expect(updateResult.content[0].text).toContain('MCP error');
  });
});

describe('E2E Regression: guaranteed-task-sizing gates across REST + remote MCP (#995)', () => {
  let server: FastifyInstance;
  let restApp: App;
  let token: string;
  let baseUrl: string;
  let remoteClient: RestClient;
  let projectId: number;

  beforeAll(async () => {
    // Real Fastify server on an ephemeral loopback port — the exact pipe both
    // the REST surface (server.inject) and the remote MCP proxy (RestClient →
    // fetch) traverse in production. seedAuth mints a real PAT; RestClient
    // always authenticates via `Authorization: Bearer`.
    const result = await createServer({ dbPath: ':memory:' });
    server = result.server;
    restApp = result.app;
    baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
    token = seedAuth(restApp.db).token;
    remoteClient = new RestClient(baseUrl, token);
    projectId = restApp.projectService.createProject({ name: 'Sizing Gates Project' }).id;
  }, 30_000);

  afterAll(async () => {
    await server.close();
    restApp.dispose();
  });

  /** POST /api/v1/tasks over the live REST surface as the seeded user. */
  function postTask(payload: Record<string, unknown>) {
    return server.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  it('REST POST /api/v1/tasks with a decomp-* tag is rejected with the instructive decompose-gate error', async () => {
    const res = await postTask({
      title: 'Sizeless decompose leaf (REST)',
      project_id: projectId,
      created_by: 'decompose-skill',
      tags: ['decomp-batch-99'],
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error: string;
      message: string;
      details: { wsjf_submission?: string[] };
    };
    // Same error CLASS as the stdio surface (ValidationError) — here it surfaces
    // as the VALIDATION_ERROR envelope with the verbatim instructive message
    // under `details.wsjf_submission`. This is the cross-surface parity #995
    // proves: identical gate, identical error class, on REST and stdio.
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.message).toBe('Validation failed');
    expect(body.details.wsjf_submission).toBeDefined();
    expect(body.details.wsjf_submission?.[0]).toContain("decompose tag 'decomp-batch-99'");
    expect(body.details.wsjf_submission?.[0]).toContain("no 'wsjf_submission'");
    expect(body.details.wsjf_submission?.[0]).toContain('re-run decompose Step 8');
  });

  it('plain REST create auto-sizes the task (wsjf_job_size set, source auto)', async () => {
    // `estimated_minutes: 20` → minutesToTier tier 2.
    const res = await postTask({
      title: 'Plain WSJF-less task (REST)',
      project_id: projectId,
      created_by: 'tester',
      estimated_minutes: 20,
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { id: number };

    // NOTE (cross-surface finding): the REST TaskResponse contract
    // (TaskResponseSchema, src/api/routes/tasks/schemas.ts) deliberately OMITS
    // every `wsjf_*` column, so the auto-sized job size is not observable on the
    // REST/remote response body. The auto-size BEHAVIOUR still occurs — asserted
    // here against the authoritative service row (which the stdio get_task
    // surface DOES expose, covered in the MCP suite above).
    const sized = restApp.taskService.getTask(created.id) as Task & {
      wsjf_job_size: number | null;
      wsjf_source: { jobSize?: string } | null;
      wsjf_value: number | null;
    };
    expect(sized.wsjf_job_size).toBe(2);
    expect(sized.wsjf_source?.jobSize).toBe('auto');
    expect(sized.wsjf_value).toBeNull();
  });

  it('REST raw-wsjf tier-conflict payload is rejected (conflict gate)', async () => {
    // estimated_minutes 10 → minutesToTier tier 1, but a RAW wsjf.jobSize of 8
    // (no source.jobSize='auto', i.e. not submission-derived) disagrees → reject.
    const res = await postTask({
      title: 'Conflicting raw wsjf (REST)',
      project_id: projectId,
      created_by: 'tester',
      estimated_minutes: 10,
      wsjf: { value: 5, timeCriticality: 3, riskOpportunity: 2, jobSize: 8 },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error: string;
      message: string;
      details: { wsjf?: string[] };
    };
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(body.details.wsjf).toBeDefined();
    expect(body.details.wsjf?.[0]).toContain('estimated_minutes 10 maps to job-size tier 1');
    expect(body.details.wsjf?.[0]).toContain('the supplied wsjf.jobSize is 8');
  });

  it('REST conflict gate exempts submission-derived (auto-source) writes', async () => {
    // A submission-derived write stamps source.jobSize='auto'; the gate must
    // NOT fire even though estimated_minutes (10 → tier 1) disagrees with the
    // band-chosen jobSize (8). Proves the gate guards only RAW/manual writes.
    const res = await postTask({
      title: 'Submission-derived high tier (REST)',
      project_id: projectId,
      created_by: 'tester',
      estimated_minutes: 10,
      wsjf: {
        value: 5,
        timeCriticality: 3,
        riskOpportunity: 2,
        jobSize: 8,
        source: {
          value: 'auto',
          timeCriticality: 'auto',
          riskOpportunity: 'auto',
          jobSize: 'auto',
        },
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('Skill File Validation', () => {
  it('all skill files have valid frontmatter', () => {
    const skillFiles = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md'));

    expect(skillFiles.length).toBeGreaterThan(0);

    for (const filename of skillFiles) {
      const filepath = path.join(SKILLS_DIR, filename);
      const content = fs.readFileSync(filepath, 'utf-8');

      // Extract frontmatter between --- delimiters
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch, `${filename}: Should have valid frontmatter`).toBeTruthy();

      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];

        // Check for required fields
        const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
        expect(nameMatch, `${filename}: Should have 'name' field`).toBeTruthy();
        if (nameMatch) {
          expect(nameMatch[1].trim(), `${filename}: 'name' should be non-empty`).toBeTruthy();
        }

        const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
        expect(descMatch, `${filename}: Should have 'description' field`).toBeTruthy();
        if (descMatch) {
          expect(
            descMatch[1].trim(),
            `${filename}: 'description' should be non-empty`,
          ).toBeTruthy();
        }

        const disableMatch = frontmatter.match(/^disable-model-invocation:\s*(.+)$/m);
        expect(
          disableMatch,
          `${filename}: Should have 'disable-model-invocation' field`,
        ).toBeTruthy();
        if (disableMatch) {
          const value = disableMatch[1].trim();
          expect(
            ['true', 'false'].includes(value),
            `${filename}: 'disable-model-invocation' should be a boolean (true/false)`,
          ).toBe(true);
        }
      }
    }
  });

  it('all skill files reference valid MCP tool names', () => {
    const skillFiles = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md'));

    for (const filename of skillFiles) {
      const filepath = path.join(SKILLS_DIR, filename);
      const content = fs.readFileSync(filepath, 'utf-8');

      // Extract all wood-fired-tasks:TOOL_NAME references
      const toolReferences = content.matchAll(/wood-fired-tasks:([a-z_]+)/g);

      for (const match of toolReferences) {
        const toolName = match[1];
        expect(
          KNOWN_MCP_TOOLS.has(toolName),
          `${filename}: References unknown tool '${toolName}'. Known tools: ${Array.from(KNOWN_MCP_TOOLS).join(', ')}`,
        ).toBe(true);
      }
    }
  });

  it('skill file count matches expected (17 invocable files)', () => {
    // Update this count when adding or removing a skill file in
    // `skills/tasks/`. The README ("N Claude Code skill files") and
    // docs/MCP.md ("N pre-built skill files") references should be
    // updated in the same change.
    //
    // Wave 5 (#320) bumped the count 11 → 12 when `decompose.md` landed
    // as a design-only discovery stub. Runtime is deferred — see
    // `docs/tasks-decompose-design.md` for the contract.
    //
    // Wave 7.1 (#323) bumped the count 12 → 13 when `audit.md` landed
    // as a design-only discovery stub. Runtime is deferred — see
    // `docs/tasks-audit-design.md` for the contract.
    //
    // Wave 4.3 (#341) bumped the count 13 → 14 when `loop-dag.md` landed
    // as the native DAG executor sibling to `loop.md`. See the design
    // contract in `skills/tasks/loop-dag.md` and the static gate at
    // `src/api/routes/tasks/__tests__/loop-dag-skill-design.test.ts`.
    //
    // Task #347 added `_enums.md` as a NON-invocable
    // (`disable-model-invocation: true`) documentation pointer for the
    // canonical status + priority enums. It is intentionally excluded
    // here — the count tracks invocable skills.
    // Task #346 added `loop-shared.md` as a NON-invocable
    // (`disable-model-invocation: true`) documentation file holding the
    // shared worker brief template + verifier envelope spec + LOOP-RUN.md
    // frontmatter table that both `/tasks:loop` and `/tasks:loop-dag`
    // reference. Excluded here for the same reason `_enums.md` is — the
    // count tracks invocable skills only.
    //
    // Task #632 (WSJF 2.1) added `wsjf-rubric.md` as a NON-invocable
    // (`disable-model-invocation: true`) classification CONTRACT referenced
    // by `decompose.md` and `create-task.md` when they score tasks. It is a
    // reference document, not a command, so it is excluded here for the same
    // reason `loop-shared.md` is.
    //
    // Task #639 (WSJF 3.3) added `new-project.md` as an INVOCABLE charter
    // interview command, bumping the invocable count 14 → 15.
    //
    // Task #796 (Phase 4) added `update.md` as an INVOCABLE self-update
    // command (runs `tasks self-update`; action target of the status-line
    // update hint), bumping the invocable count 15 → 16.
    //
    // Task #923 (Configurable Task Models, Task 14) added `set-models.md`
    // as an INVOCABLE adaptive model-policy interview command, bumping the
    // invocable count 16 → 17.
    const NON_INVOCABLE_DOCS = new Set(['loop-shared.md', 'wsjf-rubric.md']);
    const skillFiles = fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => !f.startsWith('_'))
      .filter((f) => !NON_INVOCABLE_DOCS.has(f));

    expect(skillFiles).toHaveLength(17);
  });

  it('each skill file has workflow steps', () => {
    // Task #346 added `loop-shared.md` as a NON-invocable
    // (`disable-model-invocation: true`) documentation file holding the
    // shared worker brief template + verifier envelope spec + LOOP-RUN.md
    // frontmatter table that both `/tasks:loop` and `/tasks:loop-dag`
    // reference. Excluded here for the same reason `_enums.md` is — the
    // count tracks invocable skills only.
    //
    // Task #632 (WSJF 2.1) added `wsjf-rubric.md` as a NON-invocable
    // classification contract (reference doc, not a command) — excluded for
    // the same reason as `loop-shared.md`.
    const NON_INVOCABLE_DOCS = new Set(['loop-shared.md', 'wsjf-rubric.md']);
    const skillFiles = fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => !f.startsWith('_'))
      .filter((f) => !NON_INVOCABLE_DOCS.has(f));

    for (const filename of skillFiles) {
      const filepath = path.join(SKILLS_DIR, filename);
      const content = fs.readFileSync(filepath, 'utf-8');

      // Check for H2 section headers
      const hasH2Heading = /^## /m.test(content);
      expect(hasH2Heading, `${filename}: Should have at least one H2 heading (##)`).toBe(true);

      // Check for numbered steps (list items) OR numbered section headings (### 1. etc)
      const hasNumberedSteps = /^\d+\.\s/m.test(content);
      const hasNumberedHeadings = /^###\s+\d+\.\s/m.test(content);
      expect(
        hasNumberedSteps || hasNumberedHeadings,
        `${filename}: Should contain numbered steps (e.g., "1. ") or numbered headings (e.g., "### 1. ")`,
      ).toBe(true);
    }
  });
});
