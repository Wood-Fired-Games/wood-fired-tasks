import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App, RespondFn, SlashCommand } from '@slack/bolt';
import {
  registerTasksCommand,
  parseArgs,
  formatServiceError,
  respondBlocks,
  respondError,
  type Services,
} from '../tasks-command.js';
import { NotFoundError, ValidationError, BusinessError } from '../../../services/errors.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockApp() {
  const handlers: Array<[string, (...args: unknown[]) => Promise<void>]> = [];
  const app = {
    command: vi.fn((name: string, handler: (...args: unknown[]) => Promise<void>) => {
      handlers.push([name, handler]);
    }),
    _handlers: handlers,
  };
  return app;
}

function makeMockTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    title: 'Fix login bug',
    description: null,
    status: 'open',
    priority: 'medium',
    project_id: 3,
    parent_task_id: null,
    estimated_minutes: null,
    assignee: null,
    created_by: 'Alice',
    due_date: null,
    created_at: '2026-02-18T00:00:00Z',
    updated_at: '2026-02-18T00:00:00Z',
    version: 1,
    claimed_at: null,
    tags: [],
    ...overrides,
  };
}

function makeMockComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    task_id: 42,
    author: 'Alice',
    content: 'This is a comment',
    created_at: '2026-02-18T00:00:00Z',
    updated_at: null,
    ...overrides,
  };
}

function makeMockDependency(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    task_id: 42,
    blocks_task_id: 99,
    created_at: '2026-02-18T00:00:00Z',
    ...overrides,
  };
}

function makeMockProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    name: 'Wood Fired Games',
    description: 'Main game project',
    created_at: '2026-02-18T00:00:00Z',
    updated_at: '2026-02-18T00:00:00Z',
    ...overrides,
  };
}

/**
 * Mock user repository. Default behavior:
 * - findBySlackUserId(...) → returns null (unmapped) unless overridden via vi.mocked()
 * - findServiceAccountByName('slack-bot') → returns the seeded slack-bot row (id: 999)
 * - findByEmail(...) → null unless overridden
 *
 * Tests that need to vary these (Task 2/3) override per-test via vi.mocked().
 */
function makeMockUserRepo() {
  return {
    findById: vi.fn().mockReturnValue(null),
    findByOidcSub: vi.fn().mockReturnValue(null),
    findBySlackUserId: vi.fn().mockReturnValue(null),
    findLegacyByDisplayName: vi.fn().mockReturnValue(null),
    findServiceAccountByName: vi.fn().mockImplementation((name: string) => {
      if (name === 'slack-bot') {
        return {
          id: 999,
          email: null,
          display_name: 'slack-bot',
          oidc_provider: null,
          oidc_sub: null,
          slack_user_id: null,
          is_legacy: 0,
          is_service_account: 1,
          created_at: '2026-02-18T00:00:00Z',
          last_login_at: null,
        };
      }
      return null;
    }),
    findByEmail: vi.fn().mockReturnValue(null),
    listAll: vi.fn().mockReturnValue([]),
    insert: vi.fn(),
    updateProfile: vi.fn(),
  };
}

function makeMockServices(): Services {
  return {
    taskService: {
      listTasks: vi.fn().mockReturnValue([]),
      getTask: vi.fn().mockReturnValue(makeMockTask()),
      createTask: vi.fn().mockReturnValue(makeMockTask()),
      updateTask: vi.fn().mockReturnValue(makeMockTask()),
      deleteTask: vi.fn().mockReturnValue(undefined),
      claimTask: vi.fn().mockReturnValue(makeMockTask({ assignee: 'Alice', claimed_at: '2026-02-18T00:00:00Z' })),
      getSubtasks: vi.fn().mockReturnValue([]),
      countTasks: vi.fn().mockReturnValue(42),
      searchTasks: vi.fn().mockReturnValue([]),
    } as unknown as Services['taskService'],
    projectService: {
      listProjects: vi.fn().mockReturnValue([]),
      getProject: vi.fn().mockReturnValue(makeMockProject()),
      createProject: vi.fn().mockReturnValue(makeMockProject()),
      updateProject: vi.fn().mockReturnValue(makeMockProject()),
      deleteProject: vi.fn().mockReturnValue(undefined),
    } as unknown as Services['projectService'],
    dependencyService: {
      getBlockedBy: vi.fn().mockReturnValue([]),
      getBlockers: vi.fn().mockReturnValue([]),
      addDependency: vi.fn().mockReturnValue(makeMockDependency()),
      removeDependency: vi.fn().mockReturnValue(undefined),
    } as unknown as Services['dependencyService'],
    commentService: {
      getComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn().mockReturnValue({ id: 7, task_id: 42, author: 'Alice', content: 'Test', created_at: '2026-02-18T00:00:00Z', updated_at: null }),
      deleteComment: vi.fn().mockReturnValue(undefined),
    } as unknown as Services['commentService'],
    userRepository: makeMockUserRepo() as unknown as Services['userRepository'],
  };
}

/**
 * Minimal pino-style logger mock used by tests that assert structured warn logs
 * (Plan 31-04 task 2: `event: 'slack_user_unmapped'`).
 */
function makeMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeMockIdentityCache() {
  return {
    resolve: vi.fn().mockResolvedValue('Alice'),
    clear: vi.fn(),
  } as unknown as InstanceType<typeof import('../../../slack/user-identity.js').UserIdentityCache>;
}

type HandlerArgs = {
  ack: ReturnType<typeof vi.fn>;
  respond: ReturnType<typeof vi.fn>;
  command: Partial<SlashCommand>;
};

function makeHandlerArgs(text: string): HandlerArgs {
  return {
    ack: vi.fn().mockResolvedValue(undefined),
    respond: vi.fn().mockResolvedValue(undefined),
    command: {
      text,
      user_id: 'U0123ABC',
      user_name: 'testuser',
      channel_id: 'C123',
      response_url: 'https://hooks.slack.com/response-url',
      command: '/tasks',
    },
  };
}

/**
 * Helper: register and extract the captured /tasks handler.
 */
function getHandler(app: ReturnType<typeof makeMockApp>) {
  const entry = app._handlers.find(([name]) => name === '/tasks');
  if (!entry) throw new Error('No /tasks handler registered');
  return entry[1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerTasksCommand', () => {
  it('registers /tasks command on app', () => {
    const app = makeMockApp();
    const services = makeMockServices();
    const identityCache = makeMockIdentityCache();

    registerTasksCommand(app as unknown as App, services, identityCache);

    expect(app.command).toHaveBeenCalledOnce();
    const [name, handler] = app.command.mock.calls[0]!;
    expect(name).toBe('/tasks');
    expect(typeof handler).toBe('function');
  });

  describe('ack-first behavior', () => {
    it('calls ack() before respond() for help subcommand', async () => {
      const app = makeMockApp();
      registerTasksCommand(app as unknown as App, makeMockServices(), makeMockIdentityCache());

      const handler = getHandler(app);
      const callOrder: string[] = [];

      const args = makeHandlerArgs('help');
      args.ack.mockImplementation(() => {
        callOrder.push('ack');
        return Promise.resolve();
      });
      args.respond.mockImplementation(() => {
        callOrder.push('respond');
        return Promise.resolve();
      });

      await handler(args);

      expect(callOrder[0]).toBe('ack');
      expect(callOrder).toContain('respond');
      expect(callOrder.indexOf('ack')).toBeLessThan(callOrder.indexOf('respond'));
    });
  });

  describe('bare /tasks shows help', () => {
    it('returns help blocks when command.text is empty string', async () => {
      const app = makeMockApp();
      registerTasksCommand(app as unknown as App, makeMockServices(), makeMockIdentityCache());

      const handler = getHandler(app);
      const args = makeHandlerArgs('');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(args.respond).toHaveBeenCalledOnce();

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: unknown[]; response_type: string };
      expect(respondArg.response_type).toBe('ephemeral');
      expect(Array.isArray(respondArg.blocks)).toBe(true);
      // First block should be a header with 'Tasks' in its text
      const firstBlock = respondArg.blocks[0] as { type: string; text: { text: string } };
      expect(firstBlock.type).toBe('header');
      expect(firstBlock.text.text).toContain('Tasks');
    });
  });

  describe('/tasks help shows help blocks', () => {
    it('returns help blocks when subcommand is help', async () => {
      const app = makeMockApp();
      registerTasksCommand(app as unknown as App, makeMockServices(), makeMockIdentityCache());

      const handler = getHandler(app);
      const args = makeHandlerArgs('help');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(args.respond).toHaveBeenCalledOnce();

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: unknown[]; response_type: string };
      expect(respondArg.response_type).toBe('ephemeral');
      expect(Array.isArray(respondArg.blocks)).toBe(true);
      const firstBlock = respondArg.blocks[0] as { type: string; text: { text: string } };
      expect(firstBlock.type).toBe('header');
      expect(firstBlock.text.text).toContain('Tasks');
    });
  });

  describe('unknown subcommand', () => {
    it('returns ephemeral error with unknown subcommand message and corrective hint', async () => {
      const app = makeMockApp();
      registerTasksCommand(app as unknown as App, makeMockServices(), makeMockIdentityCache());

      const handler = getHandler(app);
      const args = makeHandlerArgs('foobar');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(args.respond).toHaveBeenCalledOnce();

      const respondArg = args.respond.mock.calls[0]![0] as {
        response_type: string;
        blocks: Array<{ type: string; text: { type: string; text: string } }>;
      };
      expect(respondArg.response_type).toBe('ephemeral');
      const sectionBlock = respondArg.blocks[0]!;
      expect(sectionBlock.type).toBe('section');
      expect(sectionBlock.text.text).toContain(':x:');
      expect(sectionBlock.text.text).toContain('Unknown subcommand');
      expect(sectionBlock.text.text).toContain('/tasks help');
    });
  });

  // ── list tests ─────────────────────────────────────────────────────────────

  describe('/tasks list', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls taskService.listTasks({}) and responds with blocks from formatTaskList', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('list');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.taskService.listTasks).toHaveBeenCalledWith({});
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { response_type: string; blocks: unknown[] };
      expect(respondArg.response_type).toBe('ephemeral');
      expect(Array.isArray(respondArg.blocks)).toBe(true);
    });

    it('passes correct filters with --status open --project 3', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('list --status open --project 3');
      await handler(args);

      expect(services.taskService.listTasks).toHaveBeenCalledWith({
        status: 'open',
        project_id: 3,
      });
    });

    it('responds with no-tasks block when empty result', async () => {
      vi.mocked(services.taskService.listTasks).mockReturnValue([]);
      const handler = getHandler(app);
      const args = makeHandlerArgs('list');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      // formatTaskList returns a single section with "_No tasks found._" for empty arrays
      const hasNoTasksText = respondArg.blocks.some(
        (b) => b.text?.text?.includes('No tasks found')
      );
      expect(hasNoTasksText).toBe(true);
    });
  });

  // ── show tests ─────────────────────────────────────────────────────────────

  describe('/tasks show', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls getTask, getComments, getBlockedBy, getBlockers and responds with detail blocks', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('show 42');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.taskService.getTask).toHaveBeenCalledWith(42);
      expect(services.commentService.getComments).toHaveBeenCalledWith(42);
      expect(services.dependencyService.getBlockedBy).toHaveBeenCalledWith(42);
      expect(services.dependencyService.getBlockers).toHaveBeenCalledWith(42);
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { response_type: string; blocks: unknown[] };
      expect(respondArg.response_type).toBe('ephemeral');
      expect(respondArg.blocks.length).toBeGreaterThan(0);
    });

    it('responds with error and usage hint when no id provided', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('show');
      await handler(args);

      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as {
        blocks: Array<{ text?: { text: string } }>;
      };
      const blockText = respondArg.blocks[0]?.text?.text ?? '';
      expect(blockText).toContain(':x:');
      expect(blockText).toContain('required');
    });

    it('responds with error for non-numeric id (show abc)', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('show abc');
      await handler(args);

      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as {
        blocks: Array<{ text?: { text: string } }>;
      };
      const blockText = respondArg.blocks[0]?.text?.text ?? '';
      expect(blockText).toContain(':x:');
    });

    it('appends comments section when task has comments', async () => {
      const comments = [
        makeMockComment({ id: 1, content: 'First comment' }),
        makeMockComment({ id: 2, content: 'Second comment' }),
      ];
      vi.mocked(services.commentService.getComments).mockResolvedValue(comments);

      const handler = getHandler(app);
      const args = makeHandlerArgs('show 42');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      const hasCommentHeader = respondArg.blocks.some((b) => b.text?.text === '*Comments*');
      expect(hasCommentHeader).toBe(true);
      const hasCommentContent = respondArg.blocks.some((b) => b.text?.text?.includes('First comment'));
      expect(hasCommentContent).toBe(true);
    });

    it('adds "X more comments" footer when more than 5 comments', async () => {
      const comments = Array.from({ length: 7 }, (_, i) =>
        makeMockComment({ id: i + 1, content: `Comment ${i + 1}` })
      );
      vi.mocked(services.commentService.getComments).mockResolvedValue(comments);

      const handler = getHandler(app);
      const args = makeHandlerArgs('show 42');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ elements?: Array<{ text: string }> }> };
      const contextBlock = respondArg.blocks.find(
        (b) => b.elements?.[0]?.text?.includes('more comments')
      );
      expect(contextBlock).toBeDefined();
    });

    it('appends dependency section when task has dependencies', async () => {
      vi.mocked(services.dependencyService.getBlockedBy).mockReturnValue([
        makeMockDependency({ task_id: 42, blocks_task_id: 99 }),
      ]);

      const handler = getHandler(app);
      const args = makeHandlerArgs('show 42');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      const hasDepsText = respondArg.blocks.some((b) => b.text?.text?.includes('Blocks:'));
      expect(hasDepsText).toBe(true);
    });
  });

  // ── create tests ───────────────────────────────────────────────────────────

  describe('/tasks create', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls identityCache.resolve then createTask with title, project_id, created_by', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('create Fix login bug --project 3');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(identityCache.resolve).toHaveBeenCalledWith('U0123ABC');
      expect(services.taskService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Fix login bug',
          project_id: 3,
          created_by: 'Alice',
        })
      );
      expect(args.respond).toHaveBeenCalledOnce();
    });

    it('responds with error when no title provided', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('create --project 3');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as {
        blocks: Array<{ text?: { text: string } }>;
      };
      const blockText = respondArg.blocks[0]?.text?.text ?? '';
      expect(blockText).toContain(':x:');
      expect(blockText).toContain('Title required');
    });

    it('responds with error about required project_id when --project missing', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('create My task');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as {
        blocks: Array<{ text?: { text: string } }>;
      };
      const blockText = respondArg.blocks[0]?.text?.text ?? '';
      expect(blockText).toContain(':x:');
      expect(blockText).toContain('Project ID required');
    });

    it('uses medium priority by default when --priority not specified', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('create My task --project 3');
      await handler(args);

      expect(services.taskService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 'medium',
        })
      );
    });
  });

  // ── update tests ───────────────────────────────────────────────────────────

  describe('/tasks update', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls updateTask(42, { status: "done" }) for --status done', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('update 42 --status done');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.taskService.updateTask).toHaveBeenCalledWith(42, { status: 'done' });
      expect(args.respond).toHaveBeenCalledOnce();
    });

    it('passes both fields for --status done --priority high', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('update 42 --status done --priority high');
      await handler(args);

      expect(services.taskService.updateTask).toHaveBeenCalledWith(42, {
        status: 'done',
        priority: 'high',
      });
    });

    it('responds with error about no update fields when no flags provided', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('update 42');
      await handler(args);

      expect(services.taskService.updateTask).not.toHaveBeenCalled();
      const respondArg = args.respond.mock.calls[0]![0] as {
        blocks: Array<{ text?: { text: string } }>;
      };
      const blockText = respondArg.blocks[0]?.text?.text ?? '';
      expect(blockText).toContain(':x:');
      expect(blockText).toContain('No update fields provided');
    });

    it('responds with error when no task id provided', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('update --status done');
      await handler(args);

      // --status is parsed as a flag, so id is empty
      const respondArg = args.respond.mock.calls[0]![0] as {
        blocks: Array<{ text?: { text: string } }>;
      };
      const blockText = respondArg.blocks[0]?.text?.text ?? '';
      expect(blockText).toContain(':x:');
    });
  });

  // ── delete tests ───────────────────────────────────────────────────────────

  describe('/tasks delete', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls deleteTask(42) and responds with confirmation', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('delete 42');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.taskService.deleteTask).toHaveBeenCalledWith(42);
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      const blockText = respondArg.blocks[0]?.text?.text ?? '';
      expect(blockText).toContain(':white_check_mark:');
      expect(blockText).toContain('42');
      expect(blockText).toContain('deleted');
    });

    it('responds with error when no id provided', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('delete');
      await handler(args);

      expect(services.taskService.deleteTask).not.toHaveBeenCalled();
      const respondArg = args.respond.mock.calls[0]![0] as {
        blocks: Array<{ text?: { text: string } }>;
      };
      const blockText = respondArg.blocks[0]?.text?.text ?? '';
      expect(blockText).toContain(':x:');
      expect(blockText).toContain('required');
    });
  });

  // ── project tests ──────────────────────────────────────────────────────────

  describe('/tasks project-list', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls projectService.listProjects and responds with blocks', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('project-list');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.projectService.listProjects).toHaveBeenCalledOnce();
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { response_type: string; blocks: unknown[] };
      expect(respondArg.response_type).toBe('ephemeral');
      expect(Array.isArray(respondArg.blocks)).toBe(true);
    });

    it('responds with header block when projects exist', async () => {
      const projects = [makeMockProject({ id: 1, name: 'Alpha' }), makeMockProject({ id: 2, name: 'Beta' })];
      vi.mocked(services.projectService.listProjects).mockReturnValue(projects);
      const handler = getHandler(app);
      const handlerArgs = makeHandlerArgs('project-list');
      await handler(handlerArgs);

      // formatProjectList returns a header block for non-empty list
      const respondArg = handlerArgs.respond.mock.calls[0]![0] as { blocks: Array<{ type: string }> };
      expect(respondArg.blocks[0]?.type).toBe('header');
    });
  });

  describe('/tasks project-show', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls projectService.getProject(5) and responds with detail blocks', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('project-show 5');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.projectService.getProject).toHaveBeenCalledWith(5);
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { response_type: string; blocks: unknown[] };
      expect(respondArg.response_type).toBe('ephemeral');
    });

    it('responds with error when no id provided', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('project-show');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':x:');
      expect(respondArg.blocks[0]?.text?.text).toContain('required');
    });
  });

  describe('/tasks project-create', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls projectService.createProject with name "My Project" and responds', async () => {
      const handler = getHandler(app);
      // No shell quoting — command.text is split on whitespace by parseArgs
      // Use a single-word description to avoid splitting issues
      const args = makeHandlerArgs('project-create My Project --description ADesc');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.projectService.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My Project' })
      );
      expect(args.respond).toHaveBeenCalledOnce();
    });

    it('responds with error when no name provided', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('project-create');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':x:');
      expect(respondArg.blocks[0]?.text?.text).toContain('name required');
    });
  });

  describe('/tasks project-update', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls projectService.updateProject(5, { name: "NewName" })', async () => {
      const handler = getHandler(app);
      // No shell quoting — flag values are single tokens after whitespace split
      const args = makeHandlerArgs('project-update 5 --name NewName');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.projectService.updateProject).toHaveBeenCalledWith(5, { name: 'NewName' });
      expect(args.respond).toHaveBeenCalledOnce();
    });

    it('responds with error when no update fields provided', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('project-update 5');
      await handler(args);

      expect(services.projectService.updateProject).not.toHaveBeenCalled();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':x:');
    });
  });

  describe('/tasks project-delete', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls projectService.deleteProject(5) and responds with confirmation', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('project-delete 5');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.projectService.deleteProject).toHaveBeenCalledWith(5);
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':white_check_mark:');
      expect(respondArg.blocks[0]?.text?.text).toContain('5');
      expect(respondArg.blocks[0]?.text?.text).toContain('deleted');
    });
  });

  // ── dependency tests ────────────────────────────────────────────────────────

  describe('/tasks dep-add', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls dependencyService.addDependency({ task_id: 10, blocks_task_id: 20 }) and confirms', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('dep-add 10 20');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.dependencyService.addDependency).toHaveBeenCalledWith({ task_id: 10, blocks_task_id: 20 });
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':white_check_mark:');
      expect(respondArg.blocks[0]?.text?.text).toContain('10');
      expect(respondArg.blocks[0]?.text?.text).toContain('20');
    });

    it('responds with error when second id is missing', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('dep-add 10');
      await handler(args);

      expect(services.dependencyService.addDependency).not.toHaveBeenCalled();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':x:');
    });
  });

  describe('/tasks dep-list', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls getBlockedBy(10) and getBlockers(10) and responds with dependency info', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('dep-list 10');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.dependencyService.getBlockedBy).toHaveBeenCalledWith(10);
      expect(services.dependencyService.getBlockers).toHaveBeenCalledWith(10);
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('Task #10');
    });
  });

  describe('/tasks dep-remove', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls removeDependency(10, 20) and responds with confirmation', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('dep-remove 10 20');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.dependencyService.removeDependency).toHaveBeenCalledWith(10, 20);
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':white_check_mark:');
      expect(respondArg.blocks[0]?.text?.text).toContain('no longer blocks');
    });
  });

  // ── comment tests ───────────────────────────────────────────────────────────

  describe('/tasks comment-add', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls identityCache.resolve then commentService.addComment with multi-word content', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('comment-add 42 This is a great comment');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(identityCache.resolve).toHaveBeenCalledWith('U0123ABC');
      expect(services.commentService.addComment).toHaveBeenCalledWith(
        expect.objectContaining({ task_id: 42, content: 'This is a great comment', author: 'Alice' })
      );
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':white_check_mark:');
    });

    it('responds with error when no content provided', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('comment-add 42');
      await handler(args);

      expect(services.commentService.addComment).not.toHaveBeenCalled();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':x:');
      expect(respondArg.blocks[0]?.text?.text).toContain('required');
    });
  });

  describe('/tasks comment-list', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls commentService.getComments(42) and responds with comment blocks', async () => {
      const comments = [makeMockComment({ id: 1, content: 'Great work!' })];
      vi.mocked(services.commentService.getComments).mockResolvedValue(comments);

      const handler = getHandler(app);
      const args = makeHandlerArgs('comment-list 42');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.commentService.getComments).toHaveBeenCalledWith(42);
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ type: string; text?: { text: string } }> };
      expect(respondArg.blocks[0]?.type).toBe('header');
      const hasCommentContent = respondArg.blocks.some((b) => b.text?.text?.includes('Great work!'));
      expect(hasCommentContent).toBe(true);
    });

    it('responds with _No comments._ when task has no comments', async () => {
      vi.mocked(services.commentService.getComments).mockResolvedValue([]);

      const handler = getHandler(app);
      const args = makeHandlerArgs('comment-list 42');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('No comments');
    });
  });

  describe('/tasks comment-delete', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls commentService.deleteComment(7) and responds with confirmation', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('comment-delete 42 7');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.commentService.deleteComment).toHaveBeenCalledWith(7);
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':white_check_mark:');
      expect(respondArg.blocks[0]?.text?.text).toContain('7');
    });
  });

  // ── subtask tests ───────────────────────────────────────────────────────────

  describe('/tasks subtask-create', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls taskService.createTask with parent_task_id: 10 when subtask-create 10 Fix sub issue --project 3', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('subtask-create 10 Fix sub issue --project 3');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(identityCache.resolve).toHaveBeenCalledWith('U0123ABC');
      expect(services.taskService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ parent_task_id: 10, title: 'Fix sub issue', project_id: 3 })
      );
      expect(args.respond).toHaveBeenCalledOnce();
    });

    it('responds with error when --project flag is missing', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('subtask-create 10 Fix sub issue');
      await handler(args);

      expect(services.taskService.createTask).not.toHaveBeenCalled();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':x:');
      expect(respondArg.blocks[0]?.text?.text).toContain('Project ID required');
    });
  });

  describe('/tasks subtask-list', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls taskService.getSubtasks(10) and responds with task list blocks', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('subtask-list 10');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.taskService.getSubtasks).toHaveBeenCalledWith(10);
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { response_type: string; blocks: unknown[] };
      expect(respondArg.response_type).toBe('ephemeral');
    });
  });

  // ── health test ─────────────────────────────────────────────────────────────

  describe('/tasks health', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls taskService.countTasks and responds with healthy message', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('health');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(services.taskService.countTasks).toHaveBeenCalledOnce();
      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':white_check_mark:');
      expect(respondArg.blocks[0]?.text?.text).toContain('healthy');
      expect(respondArg.blocks[0]?.text?.text).toContain('42');
    });

    it('responds with failure message when countTasks throws', async () => {
      vi.mocked(services.taskService.countTasks).mockImplementation(() => { throw new Error('DB offline'); });

      const handler = getHandler(app);
      const args = makeHandlerArgs('health');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':x:');
      expect(respondArg.blocks[0]?.text?.text).toContain('failed');
    });
  });

  // ── CLI-only stub tests ─────────────────────────────────────────────────────

  describe('CLI-only stub commands', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('/tasks backup responds with CLI-only informational message', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('backup');
      await handler(args);

      expect(args.respond).toHaveBeenCalledOnce();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('only available via the CLI');
      expect(respondArg.blocks[0]?.text?.text).toContain('backup');
    });

    it('/tasks doctor responds with CLI-only informational message', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('doctor');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('only available via the CLI');
      expect(respondArg.blocks[0]?.text?.text).toContain('doctor');
    });

    it('/tasks completions responds with CLI-only informational message', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('completions');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('only available via the CLI');
      expect(respondArg.blocks[0]?.text?.text).toContain('completions');
    });

    it('/tasks stats responds with CLI-only informational message', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('stats');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('only available via the CLI');
    });

    it('/tasks db-check responds with CLI-only informational message', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('db-check');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('only available via the CLI');
    });
  });

  // ── subscribe / unsubscribe tests ──────────────────────────────────────────

  describe('subscribe / unsubscribe', () => {
    function makeMockSubscriptionRepo() {
      return {
        subscribe: vi.fn(),
        unsubscribe: vi.fn(() => 1),
        findSubscribedChannels: vi.fn(() => []),
        findByChannel: vi.fn(() => []),
        countByChannel: vi.fn(() => 0),
      };
    }

    it('subscribe --project 3 calls subscriptionRepo.subscribe and responds with :bell:', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('subscribe --project 3');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(subRepo.subscribe).toHaveBeenCalledWith('C123', 3, ['task.created', 'task.status_changed']);
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':bell:');
    });

    it('subscribe without --project responds with error "Missing required flag"', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('subscribe');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('Missing required flag');
    });

    it('subscribe --project 999 with project not found responds with error', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      vi.mocked(services.projectService.getProject).mockImplementation(() => { throw new Error('Not found'); });
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('subscribe --project 999');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('not found');
    });

    it('subscribe --project abc responds with error "Invalid project ID"', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('subscribe --project abc');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('Invalid project ID');
    });

    it('subscribe --project 3 --events task.created calls subscribe with only task.created', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('subscribe --project 3 --events task.created');
      await handler(args);

      expect(subRepo.subscribe).toHaveBeenCalledWith('C123', 3, ['task.created']);
    });

    it('subscribe --project 3 --events task.created,project.created persists both allowed types', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('subscribe --project 3 --events task.created,project.created');
      await handler(args);

      expect(subRepo.subscribe).toHaveBeenCalledWith('C123', 3, ['task.created', 'project.created']);
    });

    it('subscribe with invalid event type rejects ephemerally and does NOT persist', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('subscribe --project 3 --events task.created,not.a.real.event');
      await handler(args);

      // Must NOT have called subscribe (no DB mutation).
      expect(subRepo.subscribe).not.toHaveBeenCalled();

      const respondArg = args.respond.mock.calls[0]![0] as {
        response_type: string;
        blocks: Array<{ text?: { text: string } }>;
      };
      expect(respondArg.response_type).toBe('ephemeral');
      expect(respondArg.blocks[0]?.text?.text).toContain('Invalid event type');
      expect(respondArg.blocks[0]?.text?.text).toContain('not.a.real.event');
      // Lists allowed values in the error.
      expect(respondArg.blocks[0]?.text?.text).toContain('task.created');
      expect(respondArg.blocks[0]?.text?.text).toContain('project.deleted');
    });

    it('subscribe rejects when adding event types would exceed the 100-subscription per-channel cap', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      // Channel already has 100 subscription rows.
      subRepo.countByChannel.mockReturnValue(100);
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('subscribe --project 3 --events task.created');
      await handler(args);

      expect(subRepo.subscribe).not.toHaveBeenCalled();

      const respondArg = args.respond.mock.calls[0]![0] as {
        response_type: string;
        blocks: Array<{ text?: { text: string } }>;
      };
      expect(respondArg.response_type).toBe('ephemeral');
      expect(respondArg.blocks[0]?.text?.text).toContain('Subscription cap reached');
    });

    it('subscribe with empty --events value rejects ephemerally', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('subscribe --project 3 --events ,,');
      await handler(args);

      expect(subRepo.subscribe).not.toHaveBeenCalled();
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('No event types specified');
    });

    it('subscribe when subscriptionRepo is undefined responds with "not configured"', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);

      const handler = getHandler(app);
      const args = makeHandlerArgs('subscribe --project 3');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('not configured');
    });

    it('unsubscribe --project 3 calls subscriptionRepo.unsubscribe and responds with :no_bell:', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('unsubscribe --project 3');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(subRepo.unsubscribe).toHaveBeenCalledWith('C123', 3);
      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain(':no_bell:');
    });

    it('unsubscribe with no flags calls subscriptionRepo.unsubscribe with undefined projectId', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('unsubscribe');
      await handler(args);

      expect(subRepo.unsubscribe).toHaveBeenCalledWith('C123', undefined);
    });

    it('unsubscribe when repo returns 0 responds with error "No subscriptions found"', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      const subRepo = makeMockSubscriptionRepo();
      subRepo.unsubscribe.mockReturnValue(0);
      registerTasksCommand(app as unknown as App, services, identityCache, subRepo as any);

      const handler = getHandler(app);
      const args = makeHandlerArgs('unsubscribe');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('No subscriptions found');
    });

    it('unsubscribe when subscriptionRepo is undefined responds with "not configured"', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);

      const handler = getHandler(app);
      const args = makeHandlerArgs('unsubscribe');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      expect(respondArg.blocks[0]?.text?.text).toContain('not configured');
    });

    it('HELP_BLOCKS includes subscribe and unsubscribe commands', async () => {
      const app = makeMockApp();
      const services = makeMockServices();
      const identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);

      const handler = getHandler(app);
      const args = makeHandlerArgs('help');
      await handler(args);

      const respondArg = args.respond.mock.calls[0]![0] as { blocks: Array<{ text?: { text: string } }> };
      const allText = respondArg.blocks.map((b) => b.text?.text ?? '').join('\n');
      expect(allText).toContain('subscribe');
      expect(allText).toContain('unsubscribe');
    });
  });

  // ── claim tests ────────────────────────────────────────────────────────────

  describe('/tasks claim', () => {
    let app: ReturnType<typeof makeMockApp>;
    let services: Services;
    let identityCache: ReturnType<typeof makeMockIdentityCache>;

    beforeEach(() => {
      app = makeMockApp();
      services = makeMockServices();
      identityCache = makeMockIdentityCache();
      registerTasksCommand(app as unknown as App, services, identityCache);
    });

    it('calls identityCache.resolve(user_id) then claimTask(42, displayName, "workflow", slackBotUserId)', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('claim 42');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(identityCache.resolve).toHaveBeenCalledWith('U0123ABC');
      // Phase 31 (Plan 31-04): Slack claims pass source='workflow' and the
      // resolved actor (slackBotUserId 999 here since the default mock
      // findBySlackUserId returns null = unmapped).
      expect(services.taskService.claimTask).toHaveBeenCalledWith(42, 'Alice', 'workflow', 999);
      expect(args.respond).toHaveBeenCalledOnce();
    });

    it('responds with error when no id provided', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('claim');
      await handler(args);

      expect(services.taskService.claimTask).not.toHaveBeenCalled();
      const respondArg = args.respond.mock.calls[0]![0] as {
        blocks: Array<{ text?: { text: string } }>;
      };
      const blockText = respondArg.blocks[0]?.text?.text ?? '';
      expect(blockText).toContain(':x:');
      expect(blockText).toContain('required');
    });
  });

  // ---------------------------------------------------------------------------
  // Plan 31-04: slack_user_id → user lookup + slack-bot fallback
  // ---------------------------------------------------------------------------

  describe('Plan 31-04: actor resolution', () => {
    // Helper: build a "real" mapped user row
    function mappedUser(overrides: Record<string, unknown> = {}) {
      return {
        id: 17,
        email: 'alice@example.com',
        display_name: 'Alice',
        oidc_provider: 'google',
        oidc_sub: 'sub-17',
        slack_user_id: 'U0123ABC',
        is_legacy: 0,
        is_service_account: 0,
        created_at: '2026-02-18T00:00:00Z',
        last_login_at: null,
        ...overrides,
      };
    }

    describe('Task 1: registration-time slack-bot cache + Services.userRepository', () => {
      it('looks up findServiceAccountByName("slack-bot") exactly once at registration', () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);

        const userRepo = services.userRepository as unknown as ReturnType<typeof makeMockUserRepo>;
        expect(userRepo.findServiceAccountByName).toHaveBeenCalledTimes(1);
        expect(userRepo.findServiceAccountByName).toHaveBeenCalledWith('slack-bot');
      });

      it('does NOT re-query findServiceAccountByName per message (cached at boot)', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);

        const userRepo = services.userRepository as unknown as ReturnType<typeof makeMockUserRepo>;
        userRepo.findServiceAccountByName.mockClear();

        // Invoke multiple handlers that resolve actor → should NOT re-call
        const handler = getHandler(app);
        await handler(makeHandlerArgs('create Test --project 3'));
        await handler(makeHandlerArgs('create Test2 --project 3'));
        await handler(makeHandlerArgs('claim 42'));
        await handler(makeHandlerArgs('comment-add 42 Hello'));

        expect(userRepo.findServiceAccountByName).not.toHaveBeenCalled();
      });

      it('throws on registration when slack-bot service account is missing', () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        const userRepo = services.userRepository as unknown as ReturnType<typeof makeMockUserRepo>;
        userRepo.findServiceAccountByName.mockReturnValue(null);

        expect(() =>
          registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger)
        ).toThrow(/slack-bot/i);
      });
    });

    describe('Task 2: handleCreate actor resolution', () => {
      it('mapped slack_user_id → created_by_user_id = matched user id, no warn log', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        const userRepo = services.userRepository as unknown as ReturnType<typeof makeMockUserRepo>;
        userRepo.findBySlackUserId.mockImplementation((sid: string) =>
          sid === 'U0123ABC' ? mappedUser() : null
        );

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('create Fix login bug --project 3'));

        expect(userRepo.findBySlackUserId).toHaveBeenCalledWith('U0123ABC');
        expect(services.taskService.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Fix login bug',
            project_id: 3,
            created_by: 'Alice',
            created_by_user_id: 17,
          })
        );
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('unmapped slack_user_id → created_by_user_id = slackBotUserId + warn log', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        // findBySlackUserId default mock returns null = unmapped
        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('create Fix login bug --project 3'));

        expect(services.taskService.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            created_by_user_id: 999, // slack-bot id from makeMockUserRepo
          })
        );
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'slack_user_unmapped',
            slack_user_id: 'U0123ABC',
          }),
          'slack_user_unmapped'
        );
      });
    });

    describe('Task 2: handleClaim actor resolution', () => {
      it('mapped slack_user_id → claimTask receives assigneeUserId = matched user id', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        const userRepo = services.userRepository as unknown as ReturnType<typeof makeMockUserRepo>;
        userRepo.findBySlackUserId.mockReturnValue(mappedUser());

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('claim 42'));

        // claimTask signature: (taskId, assignee, source, assigneeUserId)
        expect(services.taskService.claimTask).toHaveBeenCalledWith(42, 'Alice', 'workflow', 17);
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('unmapped slack_user_id → claimTask receives assigneeUserId = slackBotUserId + warn log', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('claim 42'));

        expect(services.taskService.claimTask).toHaveBeenCalledWith(42, 'Alice', 'workflow', 999);
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'slack_user_unmapped',
            slack_user_id: 'U0123ABC',
          }),
          'slack_user_unmapped'
        );
      });
    });

    describe('Task 2: handleCommentAdd actor resolution', () => {
      it('mapped slack_user_id → addComment receives author_user_id = matched user id', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        const userRepo = services.userRepository as unknown as ReturnType<typeof makeMockUserRepo>;
        userRepo.findBySlackUserId.mockReturnValue(mappedUser());

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('comment-add 42 Looks good'));

        expect(services.commentService.addComment).toHaveBeenCalledWith(
          expect.objectContaining({
            task_id: 42,
            author: 'Alice',
            content: 'Looks good',
            author_user_id: 17,
          })
        );
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('unmapped slack_user_id → addComment receives author_user_id = slackBotUserId + warn log', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('comment-add 42 Hello'));

        expect(services.commentService.addComment).toHaveBeenCalledWith(
          expect.objectContaining({
            author_user_id: 999,
          })
        );
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'slack_user_unmapped',
            slack_user_id: 'U0123ABC',
          }),
          'slack_user_unmapped'
        );
      });
    });

    describe('Task 2: handleSubtaskCreate actor resolution', () => {
      it('mapped slack_user_id → subtask createTask receives created_by_user_id = matched user id', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        const userRepo = services.userRepository as unknown as ReturnType<typeof makeMockUserRepo>;
        userRepo.findBySlackUserId.mockReturnValue(mappedUser());

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('subtask-create 10 Fix sub issue --project 3'));

        expect(services.taskService.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            parent_task_id: 10,
            title: 'Fix sub issue',
            project_id: 3,
            created_by: 'Alice',
            created_by_user_id: 17,
          })
        );
        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('unmapped slack_user_id → subtask createTask receives created_by_user_id = slackBotUserId + warn log', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('subtask-create 10 Fix sub issue --project 3'));

        expect(services.taskService.createTask).toHaveBeenCalledWith(
          expect.objectContaining({
            created_by_user_id: 999,
          })
        );
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'slack_user_unmapped',
            slack_user_id: 'U0123ABC',
          }),
          'slack_user_unmapped'
        );
      });
    });

    describe('Task 3: handleUpdate assignee_user_id resolution', () => {
      it('updates with --assignee <email> resolving to a user sets assignee_user_id', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        const userRepo = services.userRepository as unknown as ReturnType<typeof makeMockUserRepo>;
        userRepo.findByEmail.mockImplementation((email: string) =>
          email === 'alice@example.com' ? mappedUser() : null
        );

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('update 42 --assignee alice@example.com'));

        expect(userRepo.findByEmail).toHaveBeenCalledWith('alice@example.com');
        expect(services.taskService.updateTask).toHaveBeenCalledWith(42, {
          assignee: 'alice@example.com',
          assignee_user_id: 17,
        });
      });

      it('updates with --assignee <unmatched-email> sets assignee_user_id = null', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('update 42 --assignee nobody@example.com'));

        expect(services.taskService.updateTask).toHaveBeenCalledWith(42, {
          assignee: 'nobody@example.com',
          assignee_user_id: null,
        });
      });

      it('updates with --assignee <freeform> (no @) sets assignee_user_id = null without findByEmail call', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        const userRepo = services.userRepository as unknown as ReturnType<typeof makeMockUserRepo>;

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('update 42 --assignee Bob'));

        expect(userRepo.findByEmail).not.toHaveBeenCalled();
        expect(services.taskService.updateTask).toHaveBeenCalledWith(42, {
          assignee: 'Bob',
          assignee_user_id: null,
        });
      });

      it('update without --assignee leaves assignee_user_id absent from the update DTO', async () => {
        const app = makeMockApp();
        const services = makeMockServices();
        const identityCache = makeMockIdentityCache();
        const logger = makeMockLogger();

        registerTasksCommand(app as unknown as App, services, identityCache, undefined, logger);
        const handler = getHandler(app);
        await handler(makeHandlerArgs('update 42 --status done'));

        const call = vi.mocked(services.taskService.updateTask).mock.calls[0]!;
        expect(call[0]).toBe(42);
        expect(call[1]).toEqual({ status: 'done' });
        expect(call[1]).not.toHaveProperty('assignee_user_id');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// formatServiceError
// ---------------------------------------------------------------------------

describe('formatServiceError', () => {
  it('formats NotFoundError', () => {
    const err = new NotFoundError('Task', 42);
    const result = formatServiceError(err);
    expect(result).toMatch(/Not found/);
    expect(result).toContain('Task');
    expect(result).toContain('42');
  });

  it('formats ValidationError with fieldErrors', () => {
    const err = new ValidationError({ title: ['Title is required', 'Must be at least 3 chars'], priority: ['Invalid priority'] });
    const result = formatServiceError(err);
    expect(result).toMatch(/Validation failed/);
    expect(result).toContain('title');
    expect(result).toContain('Title is required');
    expect(result).toContain('priority');
    expect(result).toContain('Invalid priority');
  });

  it('formats BusinessError with its message', () => {
    const err = new BusinessError('Task is already claimed');
    const result = formatServiceError(err);
    expect(result).toBe('Task is already claimed');
  });

  it('formats generic Error with its message', () => {
    const err = new Error('Something went wrong');
    const result = formatServiceError(err);
    expect(result).toBe('Something went wrong');
  });

  it('returns fallback string for unknown error', () => {
    const result = formatServiceError({ code: 42 });
    expect(result).toBe('Unexpected error');
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('splits flags and positionals correctly', () => {
    const result = parseArgs(['42', '--status', 'done', '--priority', 'high']);
    expect(result).toEqual({
      positionals: ['42'],
      flags: { status: 'done', priority: 'high' },
    });
  });

  it('handles no flags — all positionals', () => {
    const result = parseArgs(['42', 'hello']);
    expect(result).toEqual({
      positionals: ['42', 'hello'],
      flags: {},
    });
  });

  it('handles empty args array', () => {
    const result = parseArgs([]);
    expect(result).toEqual({ positionals: [], flags: {} });
  });

  it('handles flag at end with no value — defaults to empty string', () => {
    const result = parseArgs(['--status']);
    expect(result).toEqual({ positionals: [], flags: { status: '' } });
  });

  it('handles multiple positionals before flags', () => {
    const result = parseArgs(['1', '2', '--flag', 'val']);
    expect(result).toEqual({
      positionals: ['1', '2'],
      flags: { flag: 'val' },
    });
  });
});

// ---------------------------------------------------------------------------
// respondBlocks and respondError helper unit tests
// ---------------------------------------------------------------------------

describe('respondBlocks', () => {
  it('calls respond with ephemeral response_type, blocks, and fallback text', async () => {
    const respond = vi.fn().mockResolvedValue(undefined) as unknown as RespondFn;
    const blocks = [{ type: 'section' as const, text: { type: 'mrkdwn' as const, text: 'hello' } }];

    await respondBlocks(respond, blocks, 'fallback text');

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      response_type: 'ephemeral',
      blocks,
      text: 'fallback text',
    });
  });
});

describe('respondError', () => {
  it('calls respond with ephemeral error block containing :x: and message', async () => {
    const respond = vi.fn().mockResolvedValue(undefined) as unknown as RespondFn;

    await respondError(respond, 'Something failed');

    expect(respond).toHaveBeenCalledOnce();
    const arg = (respond as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      response_type: string;
      blocks: Array<{ type: string; text: { text: string } }>;
      text: string;
    };
    expect(arg.response_type).toBe('ephemeral');
    expect(arg.blocks[0]!.text.text).toContain(':x:');
    expect(arg.blocks[0]!.text.text).toContain('Something failed');
    expect(arg.text).toBe('Something failed');
  });

  it('appends hint to the error block text when provided', async () => {
    const respond = vi.fn().mockResolvedValue(undefined) as unknown as RespondFn;

    await respondError(respond, 'Unknown subcommand: `foo`', 'Run `/tasks help` to see available subcommands.');

    const arg = (respond as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      blocks: Array<{ type: string; text: { text: string } }>;
    };
    expect(arg.blocks[0]!.text.text).toContain('Unknown subcommand: `foo`');
    expect(arg.blocks[0]!.text.text).toContain('/tasks help');
  });
});
