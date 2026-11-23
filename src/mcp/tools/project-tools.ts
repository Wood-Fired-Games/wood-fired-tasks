import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toStructuredContent } from '../lib/structured-content.js';
import { ProjectService } from '../../services/project.service.js';
import {
  ArchivedFilterValueSchema,
  CreateProjectSchema,
  ValueCharterNullableSchema,
} from '../../schemas/project.schema.js';
import { ModelPolicyNullableSchema } from '../../schemas/model-policy.schema.js';
import { ScmCharterNullableSchema } from '../../schemas/scm-charter.schema.js';
import { z } from 'zod';
import { convertToMcpError } from '../errors.js';
import { enforceToolScope } from '../scope-gate.js';
import { omitUndefined } from '../../utils/omit-undefined.js';
import type { McpServerContext } from '../server.js';
import {
  ARCHIVE_PROJECT_DESCRIPTION,
  ArchiveProjectToolSchema,
  LIST_PROJECTS_DESCRIPTION,
  UNARCHIVE_PROJECT_DESCRIPTION,
  UnarchiveProjectToolSchema,
  formatArchiveResult,
  formatArchivedLine,
  formatProjectListLine,
  formatUnarchiveResult,
} from '../lib/project-tool-definitions.js';

/**
 * The name recorded as `archived_by` for a stdio MCP call: the display name
 * of the identity resolved at boot. Falls back to `user:<id>` when the server
 * was built without a user repository, and to `mcp` when it has no resolved
 * identity at all (contexts that predate identity resolution).
 */
function resolveMcpActorName(ctx: McpServerContext): string {
  if (ctx.actorUserId === null) {
    return 'mcp';
  }
  return ctx.userRepository?.findById(ctx.actorUserId)?.display_name ?? `user:${ctx.actorUserId}`;
}

/**
 * Register all project-related MCP tools
 *
 * Registers 7 tools for project operations:
 * - create_project: Create a new project
 * - get_project: Get project by ID
 * - list_projects: List projects (archived ones hidden by default)
 * - update_project: Update existing project
 * - archive_project: Archive a project (read-only, hidden from default lists)
 * - unarchive_project: Return an archived project to normal use
 * - delete_project: Delete project by ID
 *
 * @param ctx - Task #1631: boot-time context carrying the resolved PAT grant
 *   (`ctx.scopes`). The five mutating tools (`create_project` /
 *   `update_project` / `archive_project` / `unarchive_project` → write,
 *   `delete_project` → admin) check it via
 *   `enforceToolScope` before touching the service; `get_project` and
 *   `list_projects` are pure reads and stay ungated. Defaults to
 *   `{ actorUserId: null }` (no scopes ⇒ full tier) so pre-#1631 callers,
 *   including the many tests that build a server without a context, keep
 *   working unchanged.
 */
export function registerProjectTools(
  server: McpServer,
  projectService: ProjectService,
  ctx: McpServerContext = { actorUserId: null },
): void {
  // Tool: create_project
  server.registerTool(
    'create_project',
    {
      description:
        'Create a new project. Optionally accepts a WSJF `value_charter` ' +
        '(mission, ranked value_themes with Fibonacci weights, time_context, ' +
        'risk_posture, out_of_scope); malformed charters are rejected.',
      inputSchema: CreateProjectSchema,
    },
    async (args) => {
      try {
        // #1631: authorize BEFORE the write ('write' tier).
        enforceToolScope(ctx.scopes, 'create_project');
        const project = projectService.createProject(args);
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
        throw convertToMcpError(error);
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
        const project = projectService.getProject(args.id);
        const summary = [`Project: ${project.name}`, `Created: ${project.created_at}`];
        if (project.description) {
          summary.push(`Description: ${project.description}`);
        }
        const archivedLine = formatArchivedLine(project);
        if (archivedLine) {
          summary.push(archivedLine);
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
        throw convertToMcpError(error);
      }
    },
  );

  // Tool: list_projects (paginated)
  server.registerTool(
    'list_projects',
    {
      description: LIST_PROJECTS_DESCRIPTION,
      inputSchema: z.object({
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional(),
        archived: ArchivedFilterValueSchema.optional(),
      }),
    },
    async (args) => {
      try {
        const page = projectService.listProjectsPaginated(
          omitUndefined({ limit: args.limit, offset: args.offset, archived: args.archived }),
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
          summary.push(formatProjectListLine(project));
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
        throw convertToMcpError(error);
      }
    },
  );

  // Tool: update_project
  server.registerTool(
    'update_project',
    {
      description:
        'Update an existing project by ID. Can update name, description, ' +
        'the WSJF `value_charter` (pass null to clear it), and/or the ' +
        '`model_policy` (per-project model routing; pass null to clear it). A ' +
        'malformed charter (e.g. a non-Fibonacci theme weight) or model_policy ' +
        'is rejected.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        updates: z.object({
          name: z.string().min(1).max(200).optional(),
          description: z.string().max(5000).optional().nullable(),
          value_charter: ValueCharterNullableSchema.optional(),
          model_policy: ModelPolicyNullableSchema.optional(),
          scm: ScmCharterNullableSchema.optional(),
        }),
      }),
    },
    async (args) => {
      try {
        // #1631: authorize BEFORE the write ('write' tier).
        enforceToolScope(ctx.scopes, 'update_project');
        const project = projectService.updateProject(args.id, args.updates);
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
        throw convertToMcpError(error);
      }
    },
  );

  // Tool: archive_project (Archived project state, design §2.2 / §3.5)
  server.registerTool(
    'archive_project',
    {
      description: ARCHIVE_PROJECT_DESCRIPTION,
      inputSchema: ArchiveProjectToolSchema,
    },
    async (args) => {
      try {
        // `write`, like update_project: archiving destroys nothing and is
        // reversible.
        enforceToolScope(ctx.scopes, 'archive_project');
        // archived_by is the MCP identity, never an argument.
        const project = projectService.archiveProject(
          args.id,
          omitUndefined({ reason: args.reason, force: args.force }),
          resolveMcpActorName(ctx),
        );
        return {
          content: [{ type: 'text', text: formatArchiveResult(project) }],
          structuredContent: toStructuredContent(project),
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    },
  );

  // Tool: unarchive_project
  server.registerTool(
    'unarchive_project',
    {
      description: UNARCHIVE_PROJECT_DESCRIPTION,
      inputSchema: UnarchiveProjectToolSchema,
    },
    async (args) => {
      try {
        enforceToolScope(ctx.scopes, 'unarchive_project');
        const project = projectService.unarchiveProject(args.id, resolveMcpActorName(ctx));
        return {
          content: [{ type: 'text', text: formatUnarchiveResult(project) }],
          structuredContent: toStructuredContent(project),
        };
      } catch (error) {
        throw convertToMcpError(error);
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
        // #1631: row-destructive (cascades to the project's tasks) → 'admin'.
        enforceToolScope(ctx.scopes, 'delete_project');
        projectService.deleteProject(args.id);
        return {
          content: [
            {
              type: 'text',
              text: `Project ${args.id} deleted successfully.`,
            },
          ],
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    },
  );
}
