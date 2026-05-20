import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ProjectService } from '../../services/project.service.js';
import { CreateProjectSchema } from '../../schemas/task.schema.js';
import { z } from 'zod';
import { convertToMcpError } from '../errors.js';

/**
 * Register all project-related MCP tools
 *
 * Registers 5 tools for project CRUD operations:
 * - create_project: Create a new project
 * - get_project: Get project by ID
 * - list_projects: List all projects
 * - update_project: Update existing project
 * - delete_project: Delete project by ID
 */
export function registerProjectTools(
  server: McpServer,
  projectService: ProjectService
): void {
  // Tool: create_project
  server.registerTool(
    'create_project',
    {
      description: 'Create a new project',
      inputSchema: CreateProjectSchema,
    },
    async (args) => {
      try {
        const project = projectService.createProject(args);
        return {
          content: [
            {
              type: 'text',
              text: `Project created: ${project.name} (ID: ${project.id})`,
            },
          ],
          structuredContent: project as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
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
        const summary = [
          `Project: ${project.name}`,
          `Created: ${project.created_at}`,
        ];
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
          structuredContent: project as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
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
        const page = projectService.listProjectsPaginated({
          limit: args.limit,
          offset: args.offset,
        });

        if (page.data.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No projects found.',
              },
            ],
            structuredContent: {
              projects: [],
              total: page.total,
              limit: page.limit,
              offset: page.offset,
            } as unknown as { [x: string]: unknown },
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
          structuredContent: {
            projects: page.data,
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

  // Tool: update_project
  server.registerTool(
    'update_project',
    {
      description: 'Update an existing project by ID. Can update name and/or description.',
      inputSchema: z.object({
        id: z.number().int().positive(),
        updates: CreateProjectSchema.partial(),
      }),
    },
    async (args) => {
      try {
        const project = projectService.updateProject(args.id, args.updates);
        return {
          content: [
            {
              type: 'text',
              text: `Project ${args.id} updated: ${project.name}`,
            },
          ],
          structuredContent: project as unknown as { [x: string]: unknown },
        };
      } catch (error) {
        throw convertToMcpError(error);
      }
    }
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
    }
  );
}
