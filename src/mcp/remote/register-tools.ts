import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toStructuredContent } from '../lib/structured-content.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { RestClient } from './rest-client.js';
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  ListTasksMcpSchema,
  CreateProjectSchema,
  UpdateProjectSchema,
  CompletionReportSchema,
  toCompactTask,
} from '../../schemas/task.schema.js';
import { VERSION } from '../../utils/version.js';
import { omitUndefined } from '../../utils/omit-undefined.js';

/**
 * Task #768 — parse remote MCP tool arguments through their Zod schema BEFORE
 * the API-client call, and surface a CLEAR MCP error on invalid input.
 *
 * Why this lives in the handler (not just the SDK boundary): the production
 * `McpServer.registerTool` validates `args` against `inputSchema` before the
 * handler runs, but that validation is invisible to any caller that drives the
 * handler closure directly (our unit suite does exactly this). More important,
 * the high-risk write/report handlers used to `args as unknown as <X>Input`
 * straight into the REST client — a double-cast that bypasses BOTH the
 * Zod-inferred shape AND the API-client input contract, so a malformed payload
 * reached the wire untyped. Re-parsing here makes the narrowing explicit and
 * type-safe (the cast is gone — `parseToolArgs` returns the inferred type) and
 * turns a ZodError into an `InvalidParams` McpError with a readable message
 * instead of a 4xx/5xx round-trip or a silent pass.
 *
 * The returned value is the schema's inferred type; callers pass it to the
 * RestClient via a single, isolated SDK-boundary cast (documented at each call
 * site) because the API-client input interfaces in `cli/api/types.ts` are a
 * hand-written structural SUBSET of the richer service-layer Zod shapes.
 */
function parseToolArgs<S extends z.ZodTypeAny>(schema: S, args: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new McpError(ErrorCode.InvalidParams, `Invalid ${what} arguments: ${issues}`);
  }
  return parsed.data;
}

/**
 * Task #768 — the per-submission shape accepted by `rescore_project`. Extracted
 * to a named schema so the handler can re-parse the submissions array (clear
 * InvalidParams error on a malformed entry) rather than trusting the inbound
 * `args.submissions` and mapping it blind.
 */
const RescoreSubmissionSchema = z.object({
  task_id: z.number().int().positive(),
  classification: z.record(z.string(), z.unknown()),
  features: z.record(z.string(), z.unknown()),
});

const RescoreProjectArgsSchema = z.object({
  project_id: z.number().int().positive(),
  submissions: z.array(RescoreSubmissionSchema).default([]),
  actor_type: z.string().optional(),
  actor_id: z.string().optional(),
});

/** Default long-poll deadline (seconds) when the caller omits `timeout_seconds`. */
const WAIT_DEFAULT_TIMEOUT_SECONDS = 300;
/** Hard ceiling (seconds); larger requests are clamped down to this. */
const WAIT_MAX_TIMEOUT_SECONDS = 1800;

/**
 * Register all 27 MCP tools backed by REST API calls via RestClient.
 *
 * Tool names, descriptions, and input schemas match the local MCP server exactly.
 * Each handler proxies the request to the REST API and formats the MCP response.
 *
 * Layout:
 *   9 task tools (incl. completion_report — task #245 parity fix)
 *   5 project tools
 *   3 dependency tools
 *   3 comment tools
 *   1 health tool
 *   1 topology tool (topology_check) — backed by GET /api/v1/projects/:id/topology
 *   1 wait tool (wait_for_unblock) — backed by the SSE stream GET /api/v1/events
 *   4 WSJF tools (WSJF 1.10) — full remote parity with the stdio WSJF tools:
 *       wsjf_ranking   → GET  /api/v1/projects/:id/wsjf-ranking
 *       wsjf_history   → GET  /api/v1/tasks/:id/score-history
 *       wsjf_health    → GET  /api/v1/projects/:id/wsjf-health
 *       rescore_project→ POST /api/v1/projects/:id/rescore (MUTATION)
 *
 * task #245 — the `completion_report` tool reaches parity with the local server
 * by hitting `GET /api/v1/tasks/completion-report`.
 *
 * topology_check — parity with the stdio MCP server's `topology_check`
 * (`src/mcp/tools/topology-tools.ts`). Proxies to
 * `GET /api/v1/projects/:id/topology`, which exposes `TopologyService`.
 * Input/output schema is byte-identical to the stdio tool so callers can't
 * tell which transport they're on.
 *
 * wait_for_unblock — parity with the stdio `wait_for_unblock` tool
 * (`src/mcp/tools/wait-for-unblock-tools.ts`, task #455). The stdio variant
 * resolves the `blocked -> open` transition off the IN-PROCESS EventBus; this
 * remote variant resolves it off the API's SSE event stream
 * (`GET /api/v1/events`, task #481) so persistent agent sessions connected
 * via the REST proxy can wait on cross-process transitions. The input schema,
 * the three return envelopes (already_unblocked / unblocked / timeout), the
 * clamp logic ([1,1800], default 300, echoed `applied_timeout_seconds`), and
 * the timeout semantics (no throw) are byte-identical to the stdio tool.
 */
export function registerRemoteTools(server: McpServer, client: RestClient): void {
  // ── Task tools (9) ──────────────────────────────────────────────────────

  // Tool: create_task
  server.registerTool(
    'create_task',
    {
      description: 'Create a new task in a project',
      inputSchema: CreateTaskSchema,
    },
    async (args) => {
      // Task #768: parse against CreateTaskSchema before the API call; a bad
      // payload (missing title/project_id/created_by, etc.) throws a clear
      // InvalidParams McpError here instead of being cast straight to the wire.
      const input = parseToolArgs(CreateTaskSchema, args, 'create_task');
      try {
        const task = await client.createTask(
          // Isolated SDK-boundary cast: `input` is fully validated above; the
          // API-client `CreateTaskInput` is a structural subset of the inferred
          // CreateTaskSchema type.
          input as unknown as import('../../cli/api/types.js').CreateTaskInput,
        );
        return {
          content: [
            {
              type: 'text',
              text: `Task created: "${task.title}" (ID: ${task.id}, Status: ${task.status})`,
            },
          ],
          structuredContent: toStructuredContent(task),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to create task',
        );
      }
    },
  );

  // Tool: get_task
  server.registerTool(
    'get_task',
    {
      description: 'Get a task by its ID',
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const task = await client.getTask(args.id);
        const summary = [
          `Task: ${task.title}`,
          `Status: ${task.status}`,
          `Priority: ${task.priority}`,
        ];
        if (task.description) {
          summary.push(`Description: ${task.description}`);
        }
        if (task.assignee) {
          summary.push(`Assignee: ${task.assignee}`);
        }
        if (task.due_date) {
          summary.push(`Due: ${task.due_date}`);
        }
        if (task.tags.length > 0) {
          summary.push(`Tags: ${task.tags.join(', ')}`);
        }
        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: toStructuredContent(task),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to get task',
        );
      }
    },
  );

  // Tool: update_task
  server.registerTool(
    'update_task',
    {
      description:
        'Update an existing task by ID. Can update title, description, status, priority, assignee, due_date, and tags.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        updates: UpdateTaskSchema,
      }),
    },
    async (args) => {
      // Task #768: parse id + updates before the API call. An invalid id
      // (<=0 / non-int) or a malformed update (bad status enum, oversized
      // title, bad verification_evidence verdict, half-scored wsjf, etc.)
      // returns a clear InvalidParams McpError rather than reaching the wire.
      const { id, updates } = parseToolArgs(
        z.object({ id: z.number().int().positive(), updates: UpdateTaskSchema }),
        args,
        'update_task',
      );
      try {
        const task = await client.updateTask(
          id,
          // Isolated SDK-boundary cast: `updates` is validated above; the
          // API-client UpdateTaskInput is a structural subset.
          updates as import('../../cli/api/types.js').UpdateTaskInput,
        );
        return {
          content: [
            {
              type: 'text',
              text: `Task ${id} updated: "${task.title}" (Status: ${task.status}, Priority: ${task.priority})`,
            },
          ],
          structuredContent: toStructuredContent(task),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to update task',
        );
      }
    },
  );

  // Tool: list_tasks (paginated)
  server.registerTool(
    'list_tasks',
    {
      description:
        'List tasks with optional filters (project_id, status, assignee, tags, due_before, due_after, updated_before, updated_after, search) and pagination (limit default 50, max 500; offset default 0). Returns `{ tasks, total, limit, offset }`. Compact task projection by default; pass verbose=true for description + audit fields.',
      inputSchema: ListTasksMcpSchema,
    },
    async (args) => {
      // Task #768: parse against ListTasksMcpSchema before the API call so an
      // invalid filter (e.g. bad status enum, non-ISO due_before, oversized
      // search) returns a clear InvalidParams McpError rather than a cast to
      // the wire. `tags` is an array on the MCP schema but the API-client
      // TaskFilters expects a comma-joined string, so we normalize it here.
      const { verbose, tags, ...rest } = parseToolArgs(ListTasksMcpSchema, args, 'list_tasks');
      try {
        const filters = {
          ...rest,
          ...(tags !== undefined && { tags: tags.join(',') }),
        };
        const page = await client.listTasksPaginated(
          // Isolated SDK-boundary cast: `filters` is validated above; the
          // API-client TaskFilters is a structural subset.
          filters as unknown as import('../../cli/api/types.js').TaskFilters,
        );
        if (page.data.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No tasks found matching filters.',
              },
            ],
            structuredContent: toStructuredContent({
              tasks: [],
              total: page.total,
              limit: page.limit,
              offset: page.offset,
            }),
          };
        }
        const summary = [
          `Found ${page.data.length} of ${page.total} task(s) (limit=${page.limit}, offset=${page.offset}):\n`,
        ];
        page.data.forEach((task) => {
          summary.push(`- [${task.id}] ${task.title} (${task.status}, ${task.priority})`);
        });
        const payloadTasks = verbose ? page.data : page.data.map(toCompactTask);
        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: toStructuredContent({
            tasks: payloadTasks,
            total: page.total,
            limit: page.limit,
            offset: page.offset,
          }),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to list tasks',
        );
      }
    },
  );

  // Tool: delete_task
  server.registerTool(
    'delete_task',
    {
      description: 'Delete a task by its ID',
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        await client.deleteTask(args.id);
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.id} deleted successfully.`,
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to delete task',
        );
      }
    },
  );

  // Tool: claim_task
  server.registerTool(
    'claim_task',
    {
      description:
        'Atomically claim an unassigned task, setting assignee and transitioning status to in_progress. Returns 409-equivalent error if already claimed.',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        assignee: z.string().min(1).max(100),
      }),
    },
    async (args) => {
      try {
        const task = await client.claimTask(args.task_id, args.assignee);
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.task_id} claimed by "${args.assignee}" (Status: ${task.status})`,
            },
          ],
          structuredContent: toStructuredContent(task),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to claim task',
        );
      }
    },
  );

  // Tool: list_subtasks (paginated)
  server.registerTool(
    'list_subtasks',
    {
      description:
        'List subtasks (children) of a parent task with pagination (limit default 50, max 500; offset default 0). Returns `{ parent_task_id, subtasks, total, limit, offset }`.',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
    },
    async (args) => {
      try {
        const page = await client.getSubtasksPaginated(
          args.task_id,
          omitUndefined({ limit: args.limit, offset: args.offset }),
        );
        if (page.data.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} has no subtasks.`,
              },
            ],
            structuredContent: toStructuredContent({
              parent_task_id: args.task_id,
              subtasks: [],
              total: page.total,
              limit: page.limit,
              offset: page.offset,
            }),
          };
        }
        const summary = [
          `Task ${args.task_id} has ${page.data.length} of ${page.total} subtask(s) (limit=${page.limit}, offset=${page.offset}):\n`,
        ];
        page.data.forEach((task) => {
          summary.push(`- [${task.id}] ${task.title} (${task.status})`);
        });
        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: toStructuredContent({
            parent_task_id: args.task_id,
            subtasks: page.data,
            total: page.total,
            limit: page.limit,
            offset: page.offset,
          }),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to list subtasks',
        );
      }
    },
  );

  // Tool: get_subtasks (paginated)
  server.registerTool(
    'get_subtasks',
    {
      description:
        'Get subtasks (children) of a parent task with pagination (limit default 50, max 500; offset default 0). Returns `{ parent_task_id, subtasks, total, limit, offset }`.',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
    },
    async (args) => {
      try {
        const page = await client.getSubtasksPaginated(
          args.task_id,
          omitUndefined({ limit: args.limit, offset: args.offset }),
        );
        const summary = `Found ${page.data.length} of ${page.total} subtask(s) for task ${args.task_id} (limit=${page.limit}, offset=${page.offset})`;
        return {
          content: [
            {
              type: 'text',
              text: summary,
            },
          ],
          structuredContent: toStructuredContent({
            parent_task_id: args.task_id,
            subtasks: page.data,
            total: page.total,
            limit: page.limit,
            offset: page.offset,
          }),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to get subtasks',
        );
      }
    },
  );

  // Tool: completion_report
  // task #245 — parity with local MCP. Proxies to GET /api/v1/tasks/completion-report.
  server.registerTool(
    'completion_report',
    {
      description:
        'Dashboard view of tasks completed (status=done) within a time interval. ' +
        'Provide either `days` (trailing window) or `start`+`end` ISO8601 bounds. ' +
        'Returns per-task rows plus aggregates by project, assignee, priority, and daily throughput.',
      inputSchema: CompletionReportSchema,
    },
    async (args) => {
      // Task #768: parse against CompletionReportSchema before the API call.
      // Its refinements (must supply `days` OR both `start`+`end`; `end >=
      // start`) now produce a clear InvalidParams McpError instead of a cast
      // to the wire that the server would reject with an opaque 4xx.
      const input = parseToolArgs(CompletionReportSchema, args, 'completion_report');
      try {
        const report = await client.getCompletionReport(
          // Isolated SDK-boundary cast: `input` is validated above; the
          // API-client CompletionReportInput is a structural subset.
          input as unknown as import('../../cli/api/types.js').CompletionReportInput,
        );

        const summary = [
          `${report.total} task(s) completed between ${report.range.start} and ${report.range.end}`,
        ];
        if (report.total > 0) {
          summary.push('');
          summary.push('Top by project:');
          for (const r of report.by_project.slice(0, 5)) {
            summary.push(`  project ${r.project_id}: ${r.count}`);
          }
          summary.push('Top by assignee:');
          for (const r of report.by_assignee.slice(0, 5)) {
            summary.push(`  ${r.assignee}: ${r.count}`);
          }
        }

        return {
          content: [{ type: 'text', text: summary.join('\n') }],
          structuredContent: toStructuredContent(report),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to get completion report',
        );
      }
    },
  );

  // ── Project tools (5) ────────────────────────────────────────────────────

  // Tool: create_project
  server.registerTool(
    'create_project',
    {
      description:
        'Create a new project. Optionally accepts a WSJF `value_charter` ' +
        '(mission, ranked Fibonacci-weighted value themes, time/risk context); ' +
        'a malformed charter is rejected.',
      inputSchema: CreateProjectSchema,
    },
    async (args) => {
      try {
        // `name` is REQUIRED on CreateProjectInput, so omitUndefined (which maps
        // every key to optional) would over-widen it. Strip only the optional
        // keys when undefined; explicit `null` is preserved (three-state: clear).
        const project = await client.createProject({
          name: args.name,
          ...(args.description !== undefined && { description: args.description }),
          ...(args.value_charter !== undefined && { value_charter: args.value_charter }),
        });
        return {
          content: [
            {
              type: 'text',
              text: `Project created: ${project.name} (ID: ${project.id})`,
            },
          ],
          structuredContent: toStructuredContent(project),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to create project',
        );
      }
    },
  );

  // Tool: get_project
  server.registerTool(
    'get_project',
    {
      description: 'Get a project by its ID',
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const project = await client.getProject(args.id);
        const summary = [`Project: ${project.name}`, `Created: ${project.created_at}`];
        if (project.description) {
          summary.push(`Description: ${project.description}`);
        }
        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: toStructuredContent(project),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to get project',
        );
      }
    },
  );

  // Tool: list_projects (paginated)
  server.registerTool(
    'list_projects',
    {
      description:
        'List projects with pagination (limit default 50, max 500; offset default 0). Returns `{ projects, total, limit, offset }`.',
      inputSchema: z.object({
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
    },
    async (args) => {
      try {
        const page = await client.listProjectsPaginated(
          omitUndefined({ limit: args.limit, offset: args.offset }),
        );
        if (page.data.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No projects found.',
              },
            ],
            structuredContent: toStructuredContent({
              projects: [],
              total: page.total,
              limit: page.limit,
              offset: page.offset,
            }),
          };
        }
        const summary = [
          `Found ${page.data.length} of ${page.total} project(s) (limit=${page.limit}, offset=${page.offset}):\n`,
        ];
        page.data.forEach((project) => {
          summary.push(`- [${project.id}] ${project.name}`);
        });
        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: toStructuredContent({
            projects: page.data,
            total: page.total,
            limit: page.limit,
            offset: page.offset,
          }),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to list projects',
        );
      }
    },
  );

  // Tool: update_project
  server.registerTool(
    'update_project',
    {
      description:
        'Update an existing project by ID. Can update the name, description, ' +
        'and/or the WSJF `value_charter` (pass null to clear it). A malformed ' +
        'charter is rejected.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        updates: UpdateProjectSchema,
      }),
    },
    async (args) => {
      try {
        const project = await client.updateProject(args.id, omitUndefined(args.updates));
        return {
          content: [
            {
              type: 'text',
              text: `Project ${args.id} updated: ${project.name}`,
            },
          ],
          structuredContent: toStructuredContent(project),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to update project',
        );
      }
    },
  );

  // Tool: delete_project
  server.registerTool(
    'delete_project',
    {
      description: 'Delete a project by its ID',
      inputSchema: z.object({
        id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        await client.deleteProject(args.id);
        return {
          content: [
            {
              type: 'text',
              text: `Project ${args.id} deleted successfully.`,
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to delete project',
        );
      }
    },
  );

  // ── Dependency tools (3) ─────────────────────────────────────────────────

  // Tool: add_dependency
  server.registerTool(
    'add_dependency',
    {
      description: 'Add a dependency relationship between tasks (task_id blocks blocks_task_id)',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        blocks_task_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const dependency = await client.addDependency(args.task_id, {
          blocks_task_id: args.blocks_task_id,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Dependency created: Task ${dependency.task_id} blocks Task ${dependency.blocks_task_id}`,
            },
          ],
          structuredContent: toStructuredContent({
            dependency: {
              id: dependency.id,
              task_id: dependency.task_id,
              blocks_task_id: dependency.blocks_task_id,
              created_at: dependency.created_at,
            },
          }),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to add dependency',
        );
      }
    },
  );

  // Tool: remove_dependency
  server.registerTool(
    'remove_dependency',
    {
      description: 'Remove a dependency relationship between tasks',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        blocks_task_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        await client.removeDependency(args.task_id, args.blocks_task_id);
        return {
          content: [
            {
              type: 'text',
              text: `Dependency removed: Task ${args.task_id} no longer blocks Task ${args.blocks_task_id}`,
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to remove dependency',
        );
      }
    },
  );

  // Tool: get_dependencies
  server.registerTool(
    'get_dependencies',
    {
      description: 'Get all dependencies for a task (tasks it blocks and tasks that block it)',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const deps = await client.getDependencies(args.task_id);
        const blocks = deps.blocks ?? [];
        const blockedBy = deps.blocked_by ?? [];
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.task_id} blocks ${blocks.length} task(s) and is blocked by ${blockedBy.length} task(s)`,
            },
          ],
          structuredContent: toStructuredContent({
            task_id: args.task_id,
            blocks,
            blocked_by: blockedBy,
          }),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to get dependencies',
        );
      }
    },
  );

  // ── Comment tools (3) ───────────────────────────────────────────────────

  // Tool: add_comment
  server.registerTool(
    'add_comment',
    {
      description: 'Add a comment to a task',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        author: z.string().min(1).max(100),
        content: z.string().min(1).max(5000),
      }),
    },
    async (args) => {
      try {
        const comment = await client.addComment(args.task_id, {
          author: args.author,
          content: args.content,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Comment added by ${comment.author} on task ${comment.task_id}`,
            },
          ],
          structuredContent: toStructuredContent({
            comment: {
              id: comment.id,
              task_id: comment.task_id,
              author: comment.author,
              content: comment.content,
              created_at: comment.created_at,
            },
          }),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to add comment',
        );
      }
    },
  );

  // Tool: get_comments (paginated)
  server.registerTool(
    'get_comments',
    {
      description:
        'Get comments for a task in chronological order with pagination (limit default 50, max 500; offset default 0). Returns `{ task_id, comments, total, limit, offset }`.',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
    },
    async (args) => {
      try {
        const page = await client.getCommentsPaginated(
          args.task_id,
          omitUndefined({ limit: args.limit, offset: args.offset }),
        );
        return {
          content: [
            {
              type: 'text',
              text: `Found ${page.data.length} of ${page.total} comment(s) for task ${args.task_id} (limit=${page.limit}, offset=${page.offset})`,
            },
          ],
          structuredContent: toStructuredContent({
            task_id: args.task_id,
            comments: page.data,
            total: page.total,
            limit: page.limit,
            offset: page.offset,
          }),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to get comments',
        );
      }
    },
  );

  // Tool: delete_comment
  server.registerTool(
    'delete_comment',
    {
      description: 'Delete a comment by ID',
      inputSchema: z.object({
        comment_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        // The REST delete route is keyed solely by comment_id; its `{task_id}`
        // path segment is required to satisfy the URL shape but is IGNORED by
        // the server handler (deletion is by comment_id alone). This sentinel
        // makes that intent explicit so a future reader does not mistake the
        // value for a real task reference — any positive integer would do.
        const PATH_TASK_ID_IGNORED_BY_SERVER = 1;
        await client.deleteComment(PATH_TASK_ID_IGNORED_BY_SERVER, args.comment_id);
        return {
          content: [
            {
              type: 'text',
              text: `Comment ${args.comment_id} deleted successfully`,
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to delete comment',
        );
      }
    },
  );

  // ── Health tool (1) ─────────────────────────────────────────────────────

  // Tool: check_health
  server.registerTool(
    'check_health',
    {
      description: 'Check service health status, database connectivity, and version information',
      inputSchema: z.object({}),
    },
    async (_args) => {
      try {
        const health = await client.checkHealth();
        const status = health.status ?? 'unknown';
        const version = health.version ?? VERSION;
        const timestamp = health.timestamp ?? new Date().toISOString();
        const dbStatus = health.checks?.database ?? 'unknown';
        const fp = health.database;
        const fpLine = fp
          ? `\nDB Path: ${fp.path}\nProjects: ${fp.projects}, Max Task ID: ${fp.maxTaskId ?? 'none'}, Latest Activity: ${fp.latestActivity ?? 'none'}`
          : '';
        return {
          content: [
            {
              type: 'text',
              text: `Service Status: ${status}\nVersion: ${version}\nDatabase: ${dbStatus}\nTimestamp: ${timestamp}${fpLine}`,
            },
          ],
          structuredContent: toStructuredContent(health),
        };
      } catch (error) {
        const timestamp = new Date().toISOString();
        const version = VERSION;
        return {
          content: [
            {
              type: 'text',
              text: `Service Status: unhealthy\nVersion: ${version}\nDatabase: failed\nTimestamp: ${timestamp}\nError: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          structuredContent: toStructuredContent({
            status: 'unhealthy',
            timestamp,
            version,
            checks: { database: 'failed' },
          }),
        };
      }
    },
  );

  // ── Topology tool (1) ────────────────────────────────────────────────────

  // Tool: topology_check
  // Parity with the stdio MCP tool (src/mcp/tools/topology-tools.ts).
  // Proxies to GET /api/v1/projects/:id/topology (TopologyService.classify).
  // Input/output schema is identical to the stdio tool.
  server.registerTool(
    'topology_check',
    {
      description:
        'Classify a project as FLAT (parallelizable, /tasks:loop), DAG ' +
        '(wave-by-wave parallel dispatch, /tasks:loop-dag), or DAG_CYCLIC ' +
        '(BLOCKED) based ' +
        'on its task_dependencies graph. Returns roots, leaves, edges, and ' +
        'an execution advisory.',
      inputSchema: z.object({
        project_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const report = await client.getTopology(args.project_id);
        return {
          content: [
            {
              type: 'text',
              text:
                `Project ${args.project_id}: topology=${report.topology}, ` +
                `advisory=${report.advisory}, ` +
                `edges=${report.edges.length}, ` +
                `roots=${report.roots.length}, ` +
                `leaves=${report.leaves.length}`,
            },
          ],
          structuredContent: toStructuredContent(report),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to check topology',
        );
      }
    },
  );

  // ── WSJF tools (4) ────────────────────────────────────────────────────────
  // Remote parity (WSJF 1.10) with the stdio WSJF tools
  // (src/mcp/tools/wsjf-tools.ts). Each proxies the REST endpoint that exposes
  // the same service the stdio server wires in-process, and formats output to
  // match the stdio tool's text/structuredContent shape.

  /** Component keys whose history deltas wsjf_history reports (matches stdio). */
  const WSJF_COMPONENT_KEYS = [
    'value',
    'time_criticality',
    'risk_opportunity',
    'job_size',
    'wsjf_score',
  ] as const;

  // Tool: wsjf_ranking
  server.registerTool(
    'wsjf_ranking',
    {
      description:
        "Rank a project's tasks by propagation-adjusted WSJF (Weighted Shortest " +
        'Job First). `scope="frontier"` (default) excludes not-ready/blocked tasks; ' +
        '`scope="all"` ranks every task. Returns an ordered list (descending ' +
        'effective WSJF) where each entry carries its components, base vs effective ' +
        'WSJF, and the downstream Cost-of-Delay `propagation` breakdown.',
      inputSchema: z.object({
        project_id: z.number().int().positive(),
        scope: z.enum(['frontier', 'all']).optional(),
      }),
    },
    async (args) => {
      try {
        const scope = args.scope ?? 'frontier';
        const res = await client.getWsjfRanking(args.project_id, scope);
        const ranking = res.ranking;
        const summary = [
          `Ranked ${ranking.length} task(s) for project ${args.project_id} (scope=${scope}):\n`,
        ];
        ranking.forEach((r, idx) => {
          summary.push(
            `${idx + 1}. [${r.taskId}] effectiveWsjf=${r.effectiveWsjf.toFixed(3)}` +
              (r.scored ? ` (scored, base=${r.baseWsjf?.toFixed(3)})` : ' (unscored)'),
          );
        });
        return {
          content: [{ type: 'text', text: summary.join('\n') }],
          structuredContent: toStructuredContent({
            project_id: args.project_id,
            scope,
            ranking,
          }),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to rank tasks',
        );
      }
    },
  );

  // Tool: wsjf_history
  server.registerTool(
    'wsjf_history',
    {
      description:
        'Return the append-only WSJF score-history timeline for a task ' +
        '(oldest-first). Each entry carries the server-computed components, the ' +
        'classification/features behind them, the trigger, and a `deltas` map ' +
        'reporting the from→to change of every component (and the WSJF score) ' +
        'versus the previous entry (null `from` on the first scoring).',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const res = await client.getWsjfHistory(args.task_id);
        const rows = res.history;
        // Annotate each row with the from→to delta of every component versus
        // the immediately-preceding row (oldest-first) — identical to stdio.
        const timeline = rows.map((row, i) => {
          const prev = i > 0 ? rows[i - 1] : null;
          const deltas: Record<string, { from: number | null; to: number | null }> = {};
          for (const key of WSJF_COMPONENT_KEYS) {
            const to = (row as unknown as Record<string, number | null>)[key] ?? null;
            const from = prev
              ? ((prev as unknown as Record<string, number | null>)[key] ?? null)
              : null;
            deltas[key] = { from, to };
          }
          return { ...row, deltas };
        });
        const summary = [
          `Task ${args.task_id} has ${timeline.length} WSJF history entr${
            timeline.length === 1 ? 'y' : 'ies'
          }:\n`,
        ];
        timeline.forEach((entry) => {
          // `wsjf_score` is always written into `deltas` (it is in
          // WSJF_COMPONENT_KEYS), but the Record lookup is `| undefined` under
          // noUncheckedIndexedAccess; default to a null/null pair so the
          // rendered output is unchanged in the (unreachable) missing case.
          const s = entry.deltas['wsjf_score'] ?? { from: null, to: null };
          summary.push(
            `- ${entry.changed_at} [${entry.trigger}] wsjf ${
              s.from === null ? '∅' : s.from
            }→${s.to === null ? '∅' : s.to}`,
          );
        });
        return {
          content: [{ type: 'text', text: summary.join('\n') }],
          structuredContent: toStructuredContent({
            task_id: args.task_id,
            timeline,
          }),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to read WSJF history',
        );
      }
    },
  );

  // Tool: rescore_project (MUTATION)
  server.registerTool(
    'rescore_project',
    {
      description:
        "Deterministically rescore a project's already-scored tasks against " +
        'its current value charter. Accepts written-back classifications ' +
        '(one per task), recomputes the four WSJF components, opens a rescore ' +
        'run, writes one append-only history row per changed task linked by ' +
        'the run id, and SKIPS per-component locked values. Returns a run ' +
        'summary with evaluated / changed / skipped-locked counts and any ' +
        'per-task validation errors.',
      inputSchema: RescoreProjectArgsSchema,
    },
    async (args) => {
      // Task #768: parse the mutation args before the API call. A malformed
      // submission entry (non-positive task_id, non-object classification /
      // features) now returns a clear InvalidParams McpError rather than being
      // mapped through and sent to the rescore endpoint untyped.
      const { project_id, submissions, actor_type, actor_id } = parseToolArgs(
        RescoreProjectArgsSchema,
        args,
        'rescore_project',
      );
      try {
        const result = await client.rescoreProject(
          project_id,
          submissions.map((s) => ({
            task_id: s.task_id,
            classification: s.classification,
            features: s.features,
          })),
          {
            ...(actor_type !== undefined && { actor_type }),
            ...(actor_id !== undefined && { actor_id }),
          },
        );
        const summary = [
          `Rescore run ${result.run_id} for project ${result.project_id}: ` +
            `${result.tasks_evaluated} evaluated, ${result.tasks_changed} changed, ` +
            `${result.tasks_skipped_locked} with locked components preserved.`,
        ];
        if (result.errors.length > 0) {
          summary.push(`\n${result.errors.length} task(s) had validation errors:`);
          for (const e of result.errors) {
            summary.push(`- [${e.taskId}] ${e.errors.join('; ')}`);
          }
        }
        return {
          content: [{ type: 'text', text: summary.join('\n') }],
          structuredContent: toStructuredContent(result),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to rescore project',
        );
      }
    },
  );

  // Tool: wsjf_health
  server.registerTool(
    'wsjf_health',
    {
      description:
        "Lint a project's WSJF state for degeneracies and pitfalls " +
        '(non-blocking). Reports near-identical scores, a Cost-of-Delay ' +
        'column missing its `1` anchor, a Job Size distribution collapsed to ' +
        '1–2, past-deadline tasks with stale Time Criticality, a high ' +
        'priority-fallback ratio, and score-churn across rescore runs. Each ' +
        'finding carries a severity, a plain-language message, and a suggested ' +
        'fix. Empty findings list ⇔ healthy.',
      inputSchema: z.object({
        project_id: z.number().int().positive(),
      }),
    },
    async (args) => {
      try {
        const report = await client.getWsjfHealth(args.project_id);
        const summary = [
          report.healthy
            ? `Project ${report.project_id} WSJF health: OK ` +
              `(${report.scored_task_count} scored task(s), no degeneracies).`
            : `Project ${report.project_id} WSJF health: ${report.findings.length} ` +
              `finding(s) across ${report.scored_task_count} scored task(s):\n`,
        ];
        for (const f of report.findings) {
          summary.push(`- [${f.severity}] ${f.check}: ${f.message} Fix: ${f.suggestion}`);
        }
        return {
          content: [{ type: 'text', text: summary.join('\n') }],
          structuredContent: toStructuredContent(report),
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to check WSJF health',
        );
      }
    },
  );

  // ── Wait tool (1) ────────────────────────────────────────────────────────

  // Tool: wait_for_unblock
  // Parity with the stdio MCP tool (src/mcp/tools/wait-for-unblock-tools.ts,
  // task #455). The stdio variant resolves the blocked->open transition off
  // the IN-PROCESS EventBus; this remote variant (task #481) resolves it off
  // the API's SSE stream (GET /api/v1/events) via
  // RestClient.waitForUnblockViaSse. Input schema, the three envelopes, the
  // clamp logic, and the no-throw timeout semantics are byte-identical to the
  // stdio tool so callers can't tell which transport they're on.
  server.registerTool(
    'wait_for_unblock',
    {
      description:
        'Long-poll until a task transitions blocked -> open, then return the ' +
        'fresh task projection. Resolves immediately with status ' +
        '"already_unblocked" if the task is not currently blocked. Returns ' +
        'status "timeout" (no error) if the deadline elapses first. ' +
        'timeout_seconds defaults to 300, is clamped to [1, 1800], and the ' +
        'applied value is echoed back as applied_timeout_seconds. NOTE: the ' +
        'remote transport observes transitions over the SSE event stream, so ' +
        'it sees cross-process / cross-session wake-ups (unlike the in-process ' +
        'stdio variant).',
      inputSchema: z.object({
        task_id: z.number().int().positive(),
        timeout_seconds: z.number().int().positive().optional(),
      }),
    },
    async (args) => {
      const requested = args.timeout_seconds ?? WAIT_DEFAULT_TIMEOUT_SECONDS;
      // Clamp to [1, MAX]. Zod already rejects <=0 / non-int, so the lower
      // bound is defensive; the upper bound is the real clamp the caller sees
      // via applied_timeout_seconds. Identical to the stdio tool.
      const appliedTimeoutSeconds = Math.min(Math.max(1, requested), WAIT_MAX_TIMEOUT_SECONDS);

      // Race handling (acceptance #3/#4): OPEN THE STREAM FIRST, then re-read
      // the current status. A blocked->open transition could land in the tiny
      // window between "read status" and "subscribe"; subscribing first
      // guarantees we never miss it — the same no-miss ordering the stdio tool
      // documents. We use an AbortController so that, if the re-read shows the
      // task is already non-blocked, we tear the stream down immediately
      // (already_unblocked fast path) rather than leaking a socket until the
      // deadline.
      const abortController = new AbortController();
      const waitPromise = client.waitForUnblockViaSse(
        args.task_id,
        appliedTimeoutSeconds * 1000,
        abortController.signal,
      );

      // Now (after opening the stream) read the current projection. This both
      // authorizes the caller (same boundary as get_task — throws for unknown
      // / inaccessible ids) and tells us whether we even need to wait. If the
      // read throws, abort the stream first so we never leak the socket, then
      // surface the same McpError the remote get_task produces.
      let current: import('../../cli/api/types.js').TaskResponse;
      try {
        current = await client.getTask(args.task_id);
      } catch (error) {
        abortController.abort();
        waitPromise.catch(() => {
          /* expected abort from the teardown above */
        });
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to wait for unblock',
        );
      }

      if (current.status !== 'blocked') {
        // Not blocked at call time: abort the just-opened stream and return
        // the already_unblocked envelope. Swallow the resulting resolution.
        abortController.abort();
        waitPromise.catch(() => {
          /* expected abort from the teardown above */
        });
        const payload = {
          status: 'already_unblocked' as const,
          task: current,
          applied_timeout_seconds: appliedTimeoutSeconds,
        };
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.task_id} is not blocked (status: ${current.status}); returning immediately.`,
            },
          ],
          structuredContent: toStructuredContent(payload),
        };
      }

      // Task is blocked: wait for the SSE transition or the deadline.
      let unblocked: boolean;
      try {
        unblocked = await waitPromise;
      } catch (error) {
        // A genuine stream failure (network / auth / non-2xx) surfaces as the
        // same McpError shape the other remote tools produce.
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to wait for unblock',
        );
      }

      if (!unblocked) {
        // Deadline hit: timeout envelope. NO exception is thrown for timeout.
        const payload = {
          status: 'timeout' as const,
          task_id: args.task_id,
          waited_seconds: appliedTimeoutSeconds,
          applied_timeout_seconds: appliedTimeoutSeconds,
        };
        return {
          content: [
            {
              type: 'text',
              text: `Timed out after ${appliedTimeoutSeconds}s waiting for task ${args.task_id} to unblock.`,
            },
          ],
          structuredContent: toStructuredContent(payload),
        };
      }

      // Transition observed: re-read the fresh projection rather than trusting
      // the event payload, so the caller always gets the current canonical
      // task (mirrors the stdio tool).
      let fresh: import('../../cli/api/types.js').TaskResponse;
      try {
        fresh = await client.getTask(args.task_id);
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : 'Failed to wait for unblock',
        );
      }
      const payload = {
        status: 'unblocked' as const,
        task: fresh,
        applied_timeout_seconds: appliedTimeoutSeconds,
      };
      return {
        content: [
          {
            type: 'text',
            text: `Task ${args.task_id} transitioned blocked -> open (status: ${fresh.status}).`,
          },
        ],
        structuredContent: toStructuredContent(payload),
      };
    },
  );
}
