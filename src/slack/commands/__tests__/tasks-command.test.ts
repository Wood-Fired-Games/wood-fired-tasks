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

function makeMockServices(): Services {
  return {
    taskService: {} as Services['taskService'],
    projectService: {} as Services['projectService'],
    dependencyService: {} as Services['dependencyService'],
    commentService: {} as Services['commentService'],
  };
}

function makeMockIdentityCache() {
  return {
    resolve: vi.fn().mockResolvedValue('Test User'),
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
