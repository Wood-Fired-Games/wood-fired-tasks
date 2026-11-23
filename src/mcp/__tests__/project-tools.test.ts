import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestApp } from '../../index.js';
import { createMcpServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { App } from '../../index.js';

// The MCP SDK callTool returns a union of CallToolResult | CompatibilityCallToolResult.
// The index signature makes content/structuredContent resolve to unknown.
// This type represents the standard (non-compatibility) result shape we expect.
interface ToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// WSJF (Phase 3.2): a fully-valid value charter. value_themes weights must be
// on the modified Fibonacci scale {1,2,3,5,8,13}.
const validCharter = {
  mission: 'Ship the highest-leverage work first.',
  value_themes: [
    { name: 'Reliability', weight: 8, description: 'Keep the lights on.' },
    { name: 'Velocity', weight: 5, description: 'Ship faster.' },
  ],
  time_context: 'Q3 push.',
  risk_posture: 'Conservative on data, aggressive on UX.',
  out_of_scope: ['marketing', 'billing'],
  interview_version: 1,
  updated_at: '2026-06-01T00:00:00.000Z',
};

describe('MCP Project Tools', () => {
  let app: App;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;

  beforeEach(async () => {
    // Create in-memory test app
    app = await createTestApp();

    // Create MCP server with all services
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

  describe('create_project tool', () => {
    it('creates a project with required fields', async () => {
      const result = (await client.callTool({
        name: 'create_project',
        arguments: {
          name: 'Test Project',
        },
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Test Project');
        expect(result.content[0].text).toContain('ID:');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const project = result.structuredContent as {
          id: number;
          name: string;
        };
        expect(project.name).toBe('Test Project');
        expect(project.id).toBeDefined();
      }
    });

    it('creates a project with optional description', async () => {
      const result = (await client.callTool({
        name: 'create_project',
        arguments: {
          name: 'Project with Description',
          description: 'This is a detailed project description',
        },
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Project with Description');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const project = result.structuredContent as {
          name: string;
          description: string | null;
        };
        expect(project.name).toBe('Project with Description');
        expect(project.description).toBe('This is a detailed project description');
      }
    });

    it('returns error for missing name', async () => {
      const result = (await client.callTool({
        name: 'create_project',
        arguments: {},
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
        expect(result.content[0].text).toContain('validation');
      }
    });

    it('returns error for duplicate name', async () => {
      // Create first project
      await client.callTool({
        name: 'create_project',
        arguments: { name: 'Duplicate Project' },
      });

      // Try to create second project with same name
      const result = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Duplicate Project' },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('already exists');
      }
    });

    it('accepts and persists a value_charter', async () => {
      const createResult = (await client.callTool({
        name: 'create_project',
        arguments: {
          name: 'Project with Charter',
          value_charter: validCharter,
        },
      })) as ToolResult;

      expect(createResult.isError).toBeFalsy();
      const projectId = (createResult.structuredContent as { id: number }).id;

      // Read it back via get_project to confirm persistence.
      const getResult = (await client.callTool({
        name: 'get_project',
        arguments: { id: projectId },
      })) as ToolResult;

      const project = getResult.structuredContent as {
        value_charter: typeof validCharter | null;
      };
      expect(project.value_charter).toEqual(validCharter);
    });

    it('rejects a malformed charter (non-Fibonacci weight) with a structured error', async () => {
      const result = (await client.callTool({
        name: 'create_project',
        arguments: {
          name: 'Project with Bad Charter',
          value_charter: {
            ...validCharter,
            value_themes: [
              // weight 4 is off the Fibonacci scale {1,2,3,5,8,13}
              { name: 'Bad', weight: 4, description: 'invalid weight' },
            ],
          },
        },
      })) as ToolResult;

      // Structured rejection (isError result), not an unhandled throw — same
      // shape as the existing "missing name" validation case.
      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });
  });

  describe('get_project tool', () => {
    it('gets a project by ID', async () => {
      // Create a project first
      const createResult = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project to Get', description: 'Test description' },
      })) as ToolResult;

      const projectId = (createResult.structuredContent as { id: number }).id;

      // Get the project
      const result = (await client.callTool({
        name: 'get_project',
        arguments: { id: projectId },
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Project: Project to Get');
        expect(result.content[0].text).toContain('Created:');
        expect(result.content[0].text).toContain('Description: Test description');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const project = result.structuredContent as {
          id: number;
          name: string;
          description: string | null;
        };
        expect(project.id).toBe(projectId);
        expect(project.name).toBe('Project to Get');
        expect(project.description).toBe('Test description');
      }
    });

    it('returns error for nonexistent project', async () => {
      const result = (await client.callTool({
        name: 'get_project',
        arguments: { id: 99999 },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('not found');
      }
    });
  });

  describe('list_projects tool', () => {
    it('lists all projects', async () => {
      // Create 3 projects
      await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project Alpha' },
      });
      await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project Beta' },
      });
      await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project Gamma' },
      });

      // List all projects
      const result = (await client.callTool({
        name: 'list_projects',
        arguments: {},
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        // Paginated envelope: "Found 3 of 3 project(s) (limit=50, offset=0)"
        expect(result.content[0].text).toContain('Found 3 of 3 project(s)');
        expect(result.content[0].text).toContain('Project Alpha');
        expect(result.content[0].text).toContain('Project Beta');
        expect(result.content[0].text).toContain('Project Gamma');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const data = result.structuredContent as {
          projects: Array<{ id: number; name: string }>;
          total: number;
          limit: number;
          offset: number;
        };
        expect(data.projects).toHaveLength(3);
        expect(data.projects.map((p) => p.name)).toContain('Project Alpha');
        expect(data.total).toBe(3);
        expect(data.limit).toBe(50);
        expect(data.offset).toBe(0);
      }
    });

    it('respects limit/offset pagination args', async () => {
      // Seed projects for paging
      for (let i = 0; i < 5; i++) {
        await client.callTool({
          name: 'create_project',
          arguments: { name: `Pagination MCP Project ${i + 1}` },
        });
      }
      const result = (await client.callTool({
        name: 'list_projects',
        arguments: { limit: 2, offset: 1 },
      })) as ToolResult;

      const data = result.structuredContent as {
        projects: unknown[];
        total: number;
        limit: number;
        offset: number;
      };
      expect(data.limit).toBe(2);
      expect(data.offset).toBe(1);
      expect(data.projects.length).toBeLessThanOrEqual(2);
      expect(data.total).toBeGreaterThanOrEqual(2);
    });

    it('returns empty array when no projects exist', async () => {
      // Fresh database with no projects
      const result = (await client.callTool({
        name: 'list_projects',
        arguments: {},
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('No projects found');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const data = result.structuredContent as {
          projects: Array<unknown>;
        };
        expect(data.projects).toEqual([]);
      }
    });
  });

  describe('update_project tool', () => {
    it('updates project name', async () => {
      // Create a project
      const createResult = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Original Name' },
      })) as ToolResult;

      const projectId = (createResult.structuredContent as { id: number }).id;

      // Update the name
      const result = (await client.callTool({
        name: 'update_project',
        arguments: {
          id: projectId,
          updates: { name: 'Updated Name' },
        },
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('Updated Name');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const project = result.structuredContent as { name: string };
        expect(project.name).toBe('Updated Name');
      }
    });

    it('updates project description', async () => {
      // Create a project
      const createResult = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project for Update', description: 'Old description' },
      })) as ToolResult;

      const projectId = (createResult.structuredContent as { id: number }).id;

      // Update the description
      const result = (await client.callTool({
        name: 'update_project',
        arguments: {
          id: projectId,
          updates: { description: 'New description' },
        },
      })) as ToolResult;

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const project = result.structuredContent as { description: string | null };
        expect(project.description).toBe('New description');
      }
    });

    it('updates both name and description', async () => {
      // Create a project
      const createResult = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Old Name', description: 'Old description' },
      })) as ToolResult;

      const projectId = (createResult.structuredContent as { id: number }).id;

      // Update both fields
      const result = (await client.callTool({
        name: 'update_project',
        arguments: {
          id: projectId,
          updates: { name: 'New Name', description: 'New description' },
        },
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('New Name');
      }

      expect(result.structuredContent).toBeDefined();
      if (result.structuredContent) {
        const project = result.structuredContent as {
          name: string;
          description: string | null;
        };
        expect(project.name).toBe('New Name');
        expect(project.description).toBe('New description');
      }
    });

    it('returns error for nonexistent project', async () => {
      const result = (await client.callTool({
        name: 'update_project',
        arguments: {
          id: 99999,
          updates: { name: 'New Name' },
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('not found');
      }
    });

    it('returns error for duplicate name', async () => {
      // Create two projects
      await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project One' },
      });

      const createResult2 = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project Two' },
      })) as ToolResult;

      const project2Id = (createResult2.structuredContent as { id: number }).id;

      // Try to update Project Two to have the same name as Project One
      const result = (await client.callTool({
        name: 'update_project',
        arguments: {
          id: project2Id,
          updates: { name: 'Project One' },
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('already exists');
      }
    });

    it('accepts and persists/updates a value_charter', async () => {
      // Create a charter-less project, then attach a charter via update.
      const createResult = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project Charter via Update' },
      })) as ToolResult;
      const projectId = (createResult.structuredContent as { id: number }).id;

      const updateResult = (await client.callTool({
        name: 'update_project',
        arguments: {
          id: projectId,
          updates: { value_charter: validCharter },
        },
      })) as ToolResult;

      expect(updateResult.isError).toBeFalsy();
      const updated = updateResult.structuredContent as {
        value_charter: typeof validCharter | null;
      };
      expect(updated.value_charter).toEqual(validCharter);

      // Confirm it survived a round-trip read.
      const getResult = (await client.callTool({
        name: 'get_project',
        arguments: { id: projectId },
      })) as ToolResult;
      const fetched = getResult.structuredContent as {
        value_charter: typeof validCharter | null;
      };
      expect(fetched.value_charter).toEqual(validCharter);
    });

    it('accepts model_policy and returns it in structuredContent; get_project includes it', async () => {
      const createResult = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project Model Policy via Update' },
      })) as ToolResult;
      const projectId = (createResult.structuredContent as { id: number }).id;

      const modelPolicy = {
        execution: { byCategory: { heavy: 'claude-opus-4-8' }, default: 'auto' },
        validation: { default: 'claude-sonnet-4-6' },
      };

      const updateResult = (await client.callTool({
        name: 'update_project',
        arguments: {
          id: projectId,
          updates: { model_policy: modelPolicy },
        },
      })) as ToolResult;

      expect(updateResult.isError).toBeFalsy();
      const updated = updateResult.structuredContent as {
        model_policy: typeof modelPolicy | null;
      };
      expect(updated.model_policy).toEqual(modelPolicy);

      // get_project must surface the persisted model_policy too.
      const getResult = (await client.callTool({
        name: 'get_project',
        arguments: { id: projectId },
      })) as ToolResult;
      const fetched = getResult.structuredContent as {
        model_policy: typeof modelPolicy | null;
      };
      expect(fetched.model_policy).toEqual(modelPolicy);
    });

    it('clears model_policy with an explicit null', async () => {
      const createResult = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project Model Policy Clear' },
      })) as ToolResult;
      const projectId = (createResult.structuredContent as { id: number }).id;

      // Set a policy, then clear it.
      await client.callTool({
        name: 'update_project',
        arguments: {
          id: projectId,
          updates: { model_policy: { planning: { constant: 'auto' } } },
        },
      });

      const clearResult = (await client.callTool({
        name: 'update_project',
        arguments: { id: projectId, updates: { model_policy: null } },
      })) as ToolResult;

      expect(clearResult.isError).toBeFalsy();
      const cleared = clearResult.structuredContent as { model_policy: unknown };
      expect(cleared.model_policy).toBeNull();
    });

    it('rejects a malformed model_policy on update with a structured error', async () => {
      const createResult = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project Bad Model Policy Update' },
      })) as ToolResult;
      const projectId = (createResult.structuredContent as { id: number }).id;

      const result = (await client.callTool({
        name: 'update_project',
        arguments: {
          id: projectId,
          updates: {
            // `byFib` is not a valid RolePolicy key (strict schema).
            model_policy: { execution: { byFib: {} } },
          },
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });

    it('rejects a malformed charter on update with a structured error', async () => {
      const createResult = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project Bad Charter Update' },
      })) as ToolResult;
      const projectId = (createResult.structuredContent as { id: number }).id;

      const result = (await client.callTool({
        name: 'update_project',
        arguments: {
          id: projectId,
          updates: {
            value_charter: {
              ...validCharter,
              value_themes: [{ name: 'Bad', weight: 4, description: 'invalid weight' }],
            },
          },
        },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('MCP error');
      }
    });
  });

  describe('delete_project tool', () => {
    it('deletes a project', async () => {
      // Create a project
      const createResult = (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Project to Delete' },
      })) as ToolResult;

      const projectId = (createResult.structuredContent as { id: number }).id;

      // Delete the project
      const result = (await client.callTool({
        name: 'delete_project',
        arguments: { id: projectId },
      })) as ToolResult;

      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('deleted successfully');
      }

      // Try to get the deleted project - should fail
      const getResult = (await client.callTool({
        name: 'get_project',
        arguments: { id: projectId },
      })) as ToolResult;

      expect(getResult.isError).toBe(true);
    });

    it('returns error for nonexistent project', async () => {
      const result = (await client.callTool({
        name: 'delete_project',
        arguments: { id: 99999 },
      })) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      if (result.content[0].type === 'text') {
        expect(result.content[0].text).toContain('not found');
      }
    });
  });

  // ==========================================================================
  // Archived project state (WFT #2474, design §3.5)
  // ==========================================================================
  describe('archived project state', () => {
    async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      return (await client.callTool({ name, arguments: args })) as ToolResult;
    }

    function text(result: ToolResult): string {
      return result.content[0].text ?? '';
    }

    function listedNames(result: ToolResult): string[] {
      const projects = (result.structuredContent?.projects ?? []) as Array<{ name: string }>;
      return projects.map((project) => project.name);
    }

    describe('archive_project tool', () => {
      it('archives a project with no unfinished tasks and returns it', async () => {
        const project = app.projectService.createProject({ name: 'Finished' });

        const result = await call('archive_project', { id: project.id, reason: 'shipped' });

        expect(result.isError).toBeFalsy();
        expect(text(result)).toContain(`Project ${project.id} archived`);
        expect(result.structuredContent).toMatchObject({
          id: project.id,
          archived: true,
          archive_reason: 'shipped',
        });
        expect(app.projectService.getProject(project.id).archived).toBe(true);
      });

      it('refuses while a task is unfinished, and archives with force and a reason', async () => {
        const project = app.projectService.createProject({ name: 'Busy' });
        app.taskService.createTask({ title: 'Open', project_id: project.id, created_by: 't' });

        const refused = await call('archive_project', { id: project.id });
        expect(refused.isError).toBe(true);
        expect(text(refused)).toContain('project_has_unfinished_tasks');
        expect(app.projectService.getProject(project.id).archived).toBe(false);

        const forcedWithoutReason = await call('archive_project', { id: project.id, force: true });
        expect(forcedWithoutReason.isError).toBe(true);
        expect(app.projectService.getProject(project.id).archived).toBe(false);

        const forced = await call('archive_project', {
          id: project.id,
          force: true,
          reason: 'shelved',
        });
        expect(forced.isError).toBeFalsy();
        expect(forced.structuredContent).toMatchObject({
          archived: true,
          archive_reason: 'shelved',
        });
      });

      it('is a no-op on an already archived project: first archive wins', async () => {
        const project = app.projectService.createProject({ name: 'Twice' });
        const first = await call('archive_project', { id: project.id, reason: 'first' });

        const second = await call('archive_project', { id: project.id, reason: 'second' });

        expect(second.isError).toBeFalsy();
        expect(second.structuredContent).toEqual(first.structuredContent);
      });

      it('returns a structured error for a project that does not exist', async () => {
        const result = await call('archive_project', { id: 99999 });

        expect(result.isError).toBe(true);
        expect(text(result)).toContain('not found');
      });

      it('takes archived_by from the MCP identity, and has no argument that could set it', async () => {
        const actor = app.db
          .prepare(`INSERT INTO users (display_name, email) VALUES (?, ?) RETURNING id`)
          .get('mcp-archiver', 'mcp-archiver@example.com') as { id: number };
        const server = createMcpServer(
          app.taskService,
          app.projectService,
          app.dependencyService,
          app.commentService,
          app.db,
          { actorUserId: actor.id, userRepository: app.userRepository },
        );
        const [actorServerTransport, actorClientTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(actorServerTransport);
        const actorClient = new Client({ name: 'actor-client', version: '1.0.0' }, {});
        await actorClient.connect(actorClientTransport);
        try {
          const project = app.projectService.createProject({ name: 'Attributed' });

          const result = (await actorClient.callTool({
            name: 'archive_project',
            arguments: { id: project.id, archived_by: 'someone-else' },
          })) as ToolResult;

          expect(result.isError).toBeFalsy();
          expect(app.projectService.getProject(project.id).archived_by).toBe('mcp-archiver');
        } finally {
          await actorClientTransport.close();
          await actorServerTransport.close();
        }
      });

      it('records the fallback actor when the server has no resolved identity', async () => {
        const project = app.projectService.createProject({ name: 'Anonymous' });

        await call('archive_project', { id: project.id });

        expect(app.projectService.getProject(project.id).archived_by).toBe('mcp');
      });
    });

    describe('unarchive_project tool', () => {
      it('unarchives an archived project and returns it', async () => {
        const project = app.projectService.createProject({ name: 'Back again' });
        app.projectService.archiveProject(project.id, { reason: 'shipped' }, 'tester');

        const result = await call('unarchive_project', { id: project.id });

        expect(result.isError).toBeFalsy();
        expect(text(result)).toContain(`Project ${project.id} unarchived`);
        expect(result.structuredContent).toMatchObject({
          id: project.id,
          archived: false,
          archived_at: null,
          archived_by: null,
          archive_reason: null,
        });
      });

      it('is a no-op on a project that is not archived', async () => {
        const project = app.projectService.createProject({ name: 'Never archived' });
        const before = app.projectService.getProject(project.id);

        const result = await call('unarchive_project', { id: project.id });

        expect(result.isError).toBeFalsy();
        expect(app.projectService.getProject(project.id)).toEqual(before);
      });

      it('returns a structured error for a project that does not exist', async () => {
        const result = await call('unarchive_project', { id: 99999 });

        expect(result.isError).toBe(true);
        expect(text(result)).toContain('not found');
      });

      // WFT #2532: the stdio server runs in its own process, built by the same
      // createApp (src/mcp/index.ts) that starts the workflow engine, so a
      // stdio unarchive re-evaluates the project like a REST one.
      describe('re-evaluation after a stdio unarchive (WFT #2532)', () => {
        function blockedDependentOfFinishedBlocker(): { projectId: number; dependentId: number } {
          const live = app.projectService.createProject({ name: 'Live blockers' });
          const project = app.projectService.createProject({ name: 'Comes back' });
          const blocker = app.taskService.createTask({
            title: 'Blocker',
            project_id: live.id,
            created_by: 't',
          });
          const dependent = app.taskService.createTask({
            title: 'Dependent',
            project_id: project.id,
            created_by: 't',
          });
          app.dependencyService.addDependency({
            task_id: blocker.id,
            blocks_task_id: dependent.id,
          });
          app.taskService.updateTask(dependent.id, { status: 'blocked' });
          app.projectService.archiveProject(
            project.id,
            { force: true, reason: 'paused' },
            'tester',
          );
          app.taskService.updateTask(blocker.id, { status: 'in_progress' });
          app.taskService.updateTask(blocker.id, { status: 'done' });
          expect(app.taskService.getTask(dependent.id).status).toBe('blocked');
          return { projectId: project.id, dependentId: dependent.id };
        }

        it('opens a task whose blockers all finished while the project was archived', async () => {
          const { projectId, dependentId } = blockedDependentOfFinishedBlocker();

          const result = await call('unarchive_project', { id: projectId });

          expect(result.isError).toBeFalsy();
          expect(app.taskService.getTask(dependentId).status).toBe('open');
        });

        it('a repeated stdio unarchive retries a task whose first re-evaluation failed', async () => {
          const { projectId, dependentId } = blockedDependentOfFinishedBlocker();
          const original = app.taskService.updateTask.bind(app.taskService);
          const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
          const spy = vi
            .spyOn(app.taskService, 'updateTask')
            .mockImplementation((id: number, ...rest: unknown[]) => {
              if (id === dependentId) {
                throw new Error('simulated write failure');
              }
              return (original as (...args: unknown[]) => ReturnType<typeof original>)(id, ...rest);
            });
          try {
            await call('unarchive_project', { id: projectId });
          } finally {
            spy.mockRestore();
            errorSpy.mockRestore();
          }
          expect(app.taskService.getTask(dependentId).status).toBe('blocked');

          const retry = await call('unarchive_project', { id: projectId });

          expect(retry.isError).toBeFalsy();
          expect(app.taskService.getTask(dependentId).status).toBe('open');
        });
      });
    });

    describe('list_projects archived filter', () => {
      beforeEach(() => {
        app.projectService.createProject({ name: 'Live' });
        const archived = app.projectService.createProject({ name: 'Archived' });
        app.projectService.archiveProject(archived.id, { reason: 'shipped' }, 'tester');
      });

      it('omits archived projects by default, and total counts the filtered set', async () => {
        const result = await call('list_projects', {});

        expect(listedNames(result)).toEqual(['Live']);
        expect(result.structuredContent?.total).toBe(1);
      });

      it('archived=exclude is the default spelled out', async () => {
        const result = await call('list_projects', { archived: 'exclude' });

        expect(listedNames(result)).toEqual(['Live']);
        expect(result.structuredContent?.total).toBe(1);
      });

      it('archived=include returns both and marks the archived one in the text', async () => {
        const result = await call('list_projects', { archived: 'include' });

        expect(listedNames(result).sort()).toEqual(['Archived', 'Live']);
        expect(result.structuredContent?.total).toBe(2);
        expect(text(result)).toMatch(/Archived \(archived\)/);
        expect(text(result)).not.toMatch(/Live \(archived\)/);
      });

      it('archived=only returns nothing else', async () => {
        const result = await call('list_projects', { archived: 'only' });

        expect(listedNames(result)).toEqual(['Archived']);
        expect(result.structuredContent?.total).toBe(1);
      });

      it('rejects an unknown archived value', async () => {
        const result = await call('list_projects', { archived: 'yes' });

        expect(result.isError).toBe(true);
      });
    });

    describe('get_project text summary', () => {
      it('shows an archived line with date, actor and reason', async () => {
        const project = app.projectService.createProject({ name: 'Shelved' });
        const archived = app.projectService.archiveProject(
          project.id,
          { reason: 'shipped' },
          'tester',
        );

        const result = await call('get_project', { id: project.id });

        expect(text(result)).toContain(
          `Archived: ${archived.archived_at} by tester (reason: shipped)`,
        );
      });

      it('shows the archived line without a reason when none was given', async () => {
        const project = app.projectService.createProject({ name: 'Shelved quietly' });
        const archived = app.projectService.archiveProject(project.id, {}, 'tester');

        const result = await call('get_project', { id: project.id });

        expect(text(result)).toContain(`Archived: ${archived.archived_at} by tester`);
        expect(text(result)).not.toContain('reason:');
      });

      it('shows no archived line for a project that is not archived', async () => {
        const project = app.projectService.createProject({ name: 'Live' });

        const result = await call('get_project', { id: project.id });

        expect(text(result)).not.toContain('Archived:');
      });
    });

    it('a write refused by the freeze is an InvalidRequest tool error with the project_archived prefix', async () => {
      const project = app.projectService.createProject({ name: 'Frozen' });
      app.projectService.archiveProject(project.id, {}, 'tester');

      const result = await call('update_project', { id: project.id, updates: { name: 'Nope' } });

      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/project_archived: project \d+ is archived/);
    });
  });
});
