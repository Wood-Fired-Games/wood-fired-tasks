import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TaskService } from '../../services/task.service.js';
import { ProjectService } from '../../services/project.service.js';
import {
  // Phase 31 review WR-04: MCP tool schemas advertise the *client-facing*
  // variants which omit server-derived FK fields. A client supplying
  // `created_by_user_id` / `assignee_user_id` now gets a Zod validation
  // failure (clearer than silent stripping). Service-layer code paths
  // continue to use the full CreateTaskSchema / UpdateTaskSchema.
  CreateTaskClientSchema,
  UpdateTaskClientSchema,
  ListTasksMcpSchema,
  CompletionReportSchema,
  toCompactTask,
} from '../../schemas/task.schema.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { convertToMcpError } from '../errors.js';
import type { McpServerContext } from '../server.js';
import type { UserRepository } from '../../repositories/user.repository.js';
import { ScoreSubmissionSchema } from '../../schemas/wsjf.schema.js';
import {
  validateScoreSubmission,
  type ScoreSubmission,
} from '../../services/wsjf.service.js';
import { ValidationError } from '../../services/errors.js';
import type { WsjfWriteDTO } from '../../types/task.js';
import type { WsjfSource } from '../../types/wsjf.js';

/**
 * WSJF 1.10 (#630): route an agent's WSJF *submission* (`{classification,
 * features}`) through the deterministic {@link validateScoreSubmission} gate
 * BEFORE it reaches the service, and translate a passing result into the
 * {@link WsjfWriteDTO} the service persists.
 *
 * The MCP layer NEVER trusts a client number — it only forwards a submission
 * (enums + verbatim evidence spans + deterministic features) and lets the gate
 * recompute the four Fibonacci components. A failing gate (e.g. an evidence
 * span that is not a verbatim substring of the source) is surfaced as a
 * structured {@link ValidationError} (`fieldErrors.wsjf` = the gate's `errors[]`)
 * which `convertToMcpError` maps to an `InvalidParams` McpError carrying the
 * per-violation list — the bounded-retry contract from the design spec §12.3.
 *
 * @param submission the agent's `{classification, features}` payload.
 * @param charter    the parent project's value charter (or null).
 * @param sourceText the task text the evidence spans must occur verbatim in.
 * @returns a {@link WsjfWriteDTO} (auto path: server-computed components +
 *   the classification/features/evidence + an all-`auto` source map).
 * @throws ValidationError when the gate rejects the submission.
 */
function submissionToWsjfWrite(
  submission: ScoreSubmission,
  charter: import('../../types/task.js').ValueCharter | null,
  sourceText: string,
): WsjfWriteDTO {
  const result = validateScoreSubmission(submission, { charter, sourceText });
  if (!result.ok || !result.components) {
    // Structured, per-violation errors so a bounded agent retry can fix every
    // problem in one pass (design spec §12.3 — the gate returns `errors[]`).
    throw new ValidationError({ wsjf: result.errors });
  }
  const autoSource: WsjfSource = {
    value: 'auto',
    timeCriticality: 'auto',
    riskOpportunity: 'auto',
    jobSize: 'auto',
  };
  return {
    value: result.components.value,
    timeCriticality: result.components.timeCriticality,
    riskOpportunity: result.components.riskOpportunity,
    jobSize: result.components.jobSize,
    classifications: submission.classification,
    features: submission.features,
    evidence: submission.classification.evidence,
    source: autoSource,
  };
}

/**
 * Best-effort resolver for `assignee_user_id` when a PATCH-style update
 * carries an `assignee` string. Mirrors the REST PATCH handler's helper
 * (Phase 31 Plan 02 Task 3) so MCP and REST stay internally consistent.
 *
 * Resolution rules:
 *   - `assignee === null` or `assignee === ''` (explicit clear) → null
 *   - looks like an email (contains '@') → `userRepo.findByEmail` with
 *     try/catch around the null-guard throw (Pitfall 6); miss → null
 *   - any other free-form string → null (no display-name lookup exists;
 *     migrate-identities CLI in Plan 05 can backfill later)
 *
 * Exported so the small test in src/mcp/__tests__/task-tools.test.ts can
 * exercise the helper directly without driving the full MCP server.
 */
export function resolveAssigneeUserId(
  assignee: string | null | undefined,
  userRepo: UserRepository | undefined,
): number | null | undefined {
  // `undefined` means "no assignee key on the update body" — preserve the
  // existing PATCH semantics by NOT touching assignee_user_id.
  if (assignee === undefined) return undefined;
  if (assignee === null || assignee === '') return null;
  if (!userRepo) return null;
  if (assignee.includes('@')) {
    try {
      const u = userRepo.findByEmail(assignee);
      return u?.id ?? null;
    } catch {
      // findByEmail throws on null/empty; email-shaped-but-invalid (e.g.
      // '@@@') never actually reaches here because the upstream check
      // already filtered, but defensive guard against future drift.
      return null;
    }
  }
  return null;
}

/**
 * Register all task-related MCP tools
 *
 * Registers 6 tools for task CRUD operations plus claim:
 * - create_task: Create a new task
 * - get_task: Get task by ID
 * - update_task: Update existing task
 * - list_tasks: List tasks with filters
 * - delete_task: Delete task by ID
 * - claim_task: Atomically claim an unassigned task
 *
 * @param ctx - Phase 31 Plan 03: boot-time actor identity. The
 *   create/update/claim handlers inject `ctx.actorUserId` into the
 *   service-write input objects so the parallel FK columns
 *   (`created_by_user_id`, `assignee_user_id`) are populated. Defaults to
 *   `{ actorUserId: null }` for callers that pre-date Phase 31. The
 *   optional `ctx.userRepository` enables best-effort assignee email
 *   resolution in `update_task` (mirrors REST PATCH from Plan 31-02).
 */
export function registerTaskTools(
  server: McpServer,
  taskService: TaskService,
  projectService: ProjectService,
  ctx: McpServerContext = { actorUserId: null },
): void {
  // Tool: create_task
  server.registerTool(
    'create_task',
    {
      description:
        'Create a new task in a project. Optionally accepts a WSJF ' +
        '`wsjf_submission` ({classification, features}); it is routed through ' +
        'the deterministic validation gate (verbatim-evidence + job-size band ' +
        '+ contradiction checks) and a failure is rejected with a structured ' +
        'per-violation error — the server recomputes the score, never trusting ' +
        'a client number.',
      // WR-04: CreateTaskClientSchema omits server-derived FKs so a client
      // attempting to set created_by_user_id / assignee_user_id sees a
      // clear Zod error instead of getting the values silently stripped.
      // WSJF 1.10 (#630): extend with the agent submission envelope. The raw
      // `wsjf` WriteDTO stays on CreateTaskClientSchema for the manual path;
      // `wsjf_submission` is the classified/auto path routed through the gate.
      inputSchema: CreateTaskClientSchema.extend({
        wsjf_submission: ScoreSubmissionSchema.optional(),
      }),
    },
    async (args) => {
      const traceId = randomUUID();
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'create_task', event: 'start', timestamp: new Date().toISOString() }));
      try {
        // Phase 31 Plan 03 (T-31-07): strip any client-supplied identity
        // FKs from the JSON-RPC args BEFORE forwarding to the service.
        // ctx.actorUserId is the authoritative server-derived value; a
        // tool caller MUST NOT be able to override it. assignee_user_id
        // is also stripped here — MCP creates default to an unassigned
        // task; an assignee FK only makes sense after a separate claim
        // or update.
        const {
          created_by_user_id: _spoofCreatedBy,
          assignee_user_id: _spoofAssignee,
          wsjf_submission: wsjfSubmission,
          ...sanitizedArgs
        } = args as Record<string, unknown>;
        void _spoofCreatedBy;
        void _spoofAssignee;
        // WSJF 1.10 (#630): if a submission is present, run the deterministic
        // gate against the parent project's charter + the task text and forward
        // the server-computed components as the `wsjf` WriteDTO. A bad evidence
        // span (or any gate violation) throws a structured ValidationError.
        let wsjfWrite: WsjfWriteDTO | undefined;
        if (wsjfSubmission !== undefined) {
          const project = projectService.getProject(
            sanitizedArgs.project_id as number,
          );
          const sourceText = [
            sanitizedArgs.title,
            sanitizedArgs.description,
            sanitizedArgs.acceptance_criteria,
          ]
            .filter((s): s is string => typeof s === 'string')
            .join('\n');
          wsjfWrite = submissionToWsjfWrite(
            wsjfSubmission as ScoreSubmission,
            project.value_charter,
            sourceText,
          );
        }
        const task = taskService.createTask({
          ...sanitizedArgs,
          ...(wsjfWrite ? { wsjf: wsjfWrite } : {}),
          created_by_user_id: ctx.actorUserId,
        });
        console.error(JSON.stringify({ level: 'info', traceId, tool: 'create_task', event: 'success' }));
        return {
          content: [
            {
              type: 'text',
              text: `Task created: "${task.title}" (ID: ${task.id}, Status: ${task.status})`,
            },
          ],
          structuredContent: task as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', traceId, tool: 'create_task', event: 'error', error: error instanceof Error ? error.message : String(error) }));
        throw convertToMcpError(error);
      }
    }
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
        const task = taskService.getTask(args.id);
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
          structuredContent: task as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );

  // Tool: update_task
  server.registerTool(
    'update_task',
    {
      description:
        'Update an existing task by ID. Can update title, description, status, ' +
        'priority, assignee, due_date, tags, and the WSJF score. Pass a ' +
        '`wsjf_submission` ({classification, features}) to (re)score via the ' +
        'deterministic gate — a bad evidence span is rejected with a structured error.',
      // WR-04: UpdateTaskClientSchema omits server-derived assignee_user_id.
      // Clients change assignment by passing `assignee` (email or display
      // name); the handler resolves the FK server-side via
      // resolveAssigneeUserId.
      // WSJF 1.10 (#630): extend updates with the agent submission envelope.
      inputSchema: z.object({
        id: z.number().int().positive(),
        updates: UpdateTaskClientSchema.extend({
          wsjf_submission: ScoreSubmissionSchema.optional(),
        }),
      }),
    },
    async (args) => {
      const traceId = randomUUID();
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'update_task', event: 'start', timestamp: new Date().toISOString() }));
      try {
        // Phase 31 Plan 03 (T-31-07): strip any client-supplied
        // assignee_user_id spoof, then derive it server-side from the
        // body's `assignee` string (when present) using the same email-
        // resolution helper as the REST PATCH route (Plan 02 Task 3).
        const {
          assignee_user_id: _spoofAssigneeUserId,
          wsjf_submission: wsjfSubmission,
          ...rawUpdates
        } = args.updates as Record<string, unknown>;
        void _spoofAssigneeUserId;
        const updates: Record<string, unknown> = { ...rawUpdates };
        // WSJF 1.10 (#630): route a submission through the deterministic gate
        // against the task's project charter + current text, forwarding the
        // server-computed components as the `wsjf` WriteDTO (structured reject
        // on a bad evidence span / any gate violation).
        if (wsjfSubmission !== undefined) {
          const existing = taskService.getTask(args.id);
          const project = projectService.getProject(existing.project_id);
          const sourceText = [
            updates.title ?? existing.title,
            updates.description ?? existing.description,
            updates.acceptance_criteria ?? existing.acceptance_criteria,
          ]
            .filter((s): s is string => typeof s === 'string')
            .join('\n');
          updates.wsjf = submissionToWsjfWrite(
            wsjfSubmission as ScoreSubmission,
            project.value_charter,
            sourceText,
          );
        }
        if (Object.prototype.hasOwnProperty.call(rawUpdates, 'assignee')) {
          updates.assignee_user_id = resolveAssigneeUserId(
            rawUpdates.assignee as string | null | undefined,
            ctx.userRepository,
          );
        }
        // task #608 (PIECE A): thread the resolved actor id so the service's
        // strict-evidence validator (flag-gated, default OFF) can enforce
        // generator/critic separation (verifier != caller). 'user' keeps the
        // existing default source; ctx.actorUserId may be null.
        const task = taskService.updateTask(
          args.id,
          updates,
          'user',
          ctx.actorUserId,
        );
        console.error(JSON.stringify({ level: 'info', traceId, tool: 'update_task', event: 'success' }));
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.id} updated: "${task.title}" (Status: ${task.status}, Priority: ${task.priority})`,
            },
          ],
          structuredContent: task as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', traceId, tool: 'update_task', event: 'error', error: error instanceof Error ? error.message : String(error) }));
        throw convertToMcpError(error);
      }
    }
  );

  // Tool: list_tasks (paginated)
  // Pagination knobs: `limit` (default 50, max 500) and `offset` (default 0).
  // Returns `{ tasks, total, limit, offset }` so callers can iterate without
  // re-issuing without filters.
  server.registerTool(
    'list_tasks',
    {
      description:
        'List tasks with optional filters (project_id, status, assignee, tags, due_before, due_after, updated_before, updated_after, search) and pagination (limit default 50, max 500; offset default 0). Returns `{ tasks, total, limit, offset }`. Compact task projection by default; pass verbose=true for description + audit fields.',
      inputSchema: ListTasksMcpSchema,
    },
    async (args) => {
      const traceId = randomUUID();
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'list_tasks', event: 'start', timestamp: new Date().toISOString() }));
      try {
        const { verbose, ...filters } = args;
        const page = taskService.listTasksPaginated(filters);

        if (page.data.length === 0) {
          console.error(JSON.stringify({ level: 'info', traceId, tool: 'list_tasks', event: 'success' }));
          return {
            content: [
              {
                type: 'text',
                text: 'No tasks found matching filters.',
              },
            ],
            structuredContent: {
              tasks: [],
              total: page.total,
              limit: page.limit,
              offset: page.offset,
            } as unknown as { [x: string]: unknown },
          };
        }

        const summary = [
          `Found ${page.data.length} of ${page.total} task(s) (limit=${page.limit}, offset=${page.offset}):\n`,
        ];
        page.data.forEach((task) => {
          summary.push(
            `- [${task.id}] ${task.title} (${task.status}, ${task.priority})`
          );
        });

        const payloadTasks = verbose ? page.data : page.data.map(toCompactTask);

        console.error(JSON.stringify({ level: 'info', traceId, tool: 'list_tasks', event: 'success' }));
        return {
          content: [
            {
              type: 'text',
              text: summary.join('\n'),
            },
          ],
          structuredContent: {
            tasks: payloadTasks,
            total: page.total,
            limit: page.limit,
            offset: page.offset,
          } as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', traceId, tool: 'list_tasks', event: 'error', error: error instanceof Error ? error.message : String(error) }));
        throw convertToMcpError(error);
      }
    }
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
        taskService.deleteTask(args.id);
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.id} deleted successfully.`,
            },
          ],
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
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
      const traceId = randomUUID();
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'claim_task', event: 'start', timestamp: new Date().toISOString() }));
      try {
        // Phase 31 Plan 03: pass the boot-resolved actor as the trailing
        // optional positional (Plan 01 service signature). 'workflow' is
        // the source tag because MCP-initiated claims are agent-driven,
        // mirroring the Slack handler convention. ctx.actorUserId may be
        // null — the service binds null to the SQL parameter in that case.
        const task = taskService.claimTask(
          args.task_id,
          args.assignee,
          'workflow',
          ctx.actorUserId,
        );
        console.error(JSON.stringify({ level: 'info', traceId, tool: 'claim_task', event: 'success' }));
        return {
          content: [
            {
              type: 'text',
              text: `Task ${args.task_id} claimed by "${args.assignee}" (Status: ${task.status})`,
            },
          ],
          structuredContent: task as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', traceId, tool: 'claim_task', event: 'error', error: error instanceof Error ? error.message : String(error) }));
        throw convertToMcpError(error);
      }
    }
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
        const page = taskService.getSubtasksPaginated(args.task_id, {
          limit: args.limit,
          offset: args.offset,
        });

        if (page.data.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Task ${args.task_id} has no subtasks.`,
              },
            ],
            structuredContent: {
              parent_task_id: args.task_id,
              subtasks: [],
              total: page.total,
              limit: page.limit,
              offset: page.offset,
            } as unknown as { [x: string]: unknown },
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
          structuredContent: {
            parent_task_id: args.task_id,
            subtasks: page.data,
            total: page.total,
            limit: page.limit,
            offset: page.offset,
          } as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );

  // Tool: completion_report
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
      const traceId = randomUUID();
      console.error(JSON.stringify({ level: 'info', traceId, tool: 'completion_report', event: 'start', timestamp: new Date().toISOString() }));
      try {
        const report = taskService.getCompletionReport(args);

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

        console.error(JSON.stringify({ level: 'info', traceId, tool: 'completion_report', event: 'success' }));
        return {
          content: [{ type: 'text', text: summary.join('\n') }],
          structuredContent: report as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', traceId, tool: 'completion_report', event: 'error', error: error instanceof Error ? error.message : String(error) }));
        throw convertToMcpError(error);
      }
    }
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
        const page = taskService.getSubtasksPaginated(args.task_id, {
          limit: args.limit,
          offset: args.offset,
        });
        const summary = `Found ${page.data.length} of ${page.total} subtask(s) for task ${args.task_id} (limit=${page.limit}, offset=${page.offset})`;

        return {
          content: [
            {
              type: 'text',
              text: summary,
            },
          ],
          structuredContent: {
            parent_task_id: args.task_id,
            subtasks: page.data,
            total: page.total,
            limit: page.limit,
            offset: page.offset,
          } as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
  );
}
