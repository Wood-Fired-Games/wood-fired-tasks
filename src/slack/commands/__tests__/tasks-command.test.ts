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
    created_by: 'Stuart',
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
    author: 'Stuart',
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

function makeMockServices(): Services {
  return {
    taskService: {
      listTasks: vi.fn().mockReturnValue([]),
      getTask: vi.fn().mockReturnValue(makeMockTask()),
      createTask: vi.fn().mockReturnValue(makeMockTask()),
      updateTask: vi.fn().mockReturnValue(makeMockTask()),
      deleteTask: vi.fn().mockReturnValue(undefined),
      claimTask: vi.fn().mockReturnValue(makeMockTask({ assignee: 'Stuart', claimed_at: '2026-02-18T00:00:00Z' })),
      getSubtasks: vi.fn().mockReturnValue([]),
      countTasks: vi.fn().mockReturnValue(0),
      searchTasks: vi.fn().mockReturnValue([]),
    } as unknown as Services['taskService'],
    projectService: {} as Services['projectService'],
    dependencyService: {
      getBlockedBy: vi.fn().mockReturnValue([]),
      getBlockers: vi.fn().mockReturnValue([]),
      addDependency: vi.fn(),
      removeDependency: vi.fn(),
    } as unknown as Services['dependencyService'],
    commentService: {
      getComments: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
      deleteComment: vi.fn(),
    } as unknown as Services['commentService'],
  };
}

function makeMockIdentityCache() {
  return {
    resolve: vi.fn().mockResolvedValue('Stuart'),
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
          created_by: 'Stuart',
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

    it('calls identityCache.resolve(user_id) then claimTask(42, displayName)', async () => {
      const handler = getHandler(app);
      const args = makeHandlerArgs('claim 42');
      await handler(args);

      expect(args.ack).toHaveBeenCalledOnce();
      expect(identityCache.resolve).toHaveBeenCalledWith('U0123ABC');
      expect(services.taskService.claimTask).toHaveBeenCalledWith(42, 'Stuart');
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
