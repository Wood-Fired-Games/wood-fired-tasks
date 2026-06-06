import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module - use importOriginal to preserve ApiClientError
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    listTasks: vi.fn(),
  };
});

// Mock the env module to avoid validation errors
vi.mock('../config/env.js', () => ({
  env: {
    API_BASE_URL: 'http://localhost:3000',
    API_KEY: 'test-key',
  },
}));

// Mock the spinner module (used by withApiSpinner in client.js)
vi.mock('../output/spinner.js', () => ({
  withSpinner: vi.fn((_msg: string, fn: () => Promise<unknown>) => fn()),
  shouldShowSpinner: vi.fn(() => false),
}));

// Mock the formatters module
vi.mock('../output/formatters.js', () => ({
  formatTaskTable: vi.fn((tasks) => `Table with ${tasks.length} tasks`),
  colorSuccess: vi.fn((text: string) => text),
  colorError: vi.fn((text: string) => text),
  colorWarn: vi.fn((text: string) => text),
  colorInfo: vi.fn((text: string) => text),
  colorBold: vi.fn((text: string) => text),
  isJsonMode: vi.fn(() => false),
  shouldUseColor: vi.fn(() => false),
}));

// Mock the json-output module
vi.mock('../output/json-output.js', () => ({
  jsonOutput: vi.fn(),
  messageOutput: vi.fn(),
}));

describe('list command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Reset process.exitCode
    process.exitCode = 0;

    // Import after mocks are set up
    const { listCommand } = await import('../commands/list.js');
    program = new Command();
    // Register global options (like the main CLI does)
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(listCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('lists all tasks with no filters', async () => {
    const { listTasks } = await import('../api/client.js');
    vi.mocked(listTasks).mockResolvedValue([
      {
        id: 1,
        title: 'Task 1',
        description: null,
        status: 'open',
        priority: 'medium',
        project_id: 1,
        assignee: null,
        created_by: 'alice',
        due_date: null,
        created_at: '2026-02-13T00:00:00Z',
        updated_at: '2026-02-13T00:00:00Z',
        tags: [],
      },
    ]);

    await program.parseAsync(['node', 'test', 'list']);

    expect(listTasks).toHaveBeenCalledWith(undefined);
  });

  it('lists tasks with status filter', async () => {
    const { listTasks } = await import('../api/client.js');
    vi.mocked(listTasks).mockResolvedValue([]);

    await program.parseAsync(['node', 'test', 'list', '-s', 'open']);

    expect(listTasks).toHaveBeenCalledWith({ status: 'open' });
  });

  it('lists tasks with multiple filters', async () => {
    const { listTasks } = await import('../api/client.js');
    vi.mocked(listTasks).mockResolvedValue([]);

    await program.parseAsync(['node', 'test', 'list', '-p', '1', '-s', 'open', '-a', 'alice']);

    expect(listTasks).toHaveBeenCalledWith({
      project_id: 1,
      status: 'open',
      assignee: 'alice',
    });
  });

  it('searches tasks by text', async () => {
    const { listTasks } = await import('../api/client.js');
    vi.mocked(listTasks).mockResolvedValue([]);

    await program.parseAsync(['node', 'test', 'list', '--search', 'bug fix']);

    expect(listTasks).toHaveBeenCalledWith({ search: 'bug fix' });
  });

  it("shows 'no tasks found' for empty results", async () => {
    const { listTasks } = await import('../api/client.js');
    vi.mocked(listTasks).mockResolvedValue([]);

    await program.parseAsync(['node', 'test', 'list']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No tasks found'));
  });

  it('displays table for results', async () => {
    const { listTasks } = await import('../api/client.js');
    vi.mocked(listTasks).mockResolvedValue([
      {
        id: 1,
        title: 'Task 1',
        description: null,
        status: 'open',
        priority: 'medium',
        project_id: 1,
        assignee: null,
        created_by: 'alice',
        due_date: null,
        created_at: '2026-02-13T00:00:00Z',
        updated_at: '2026-02-13T00:00:00Z',
        tags: [],
      },
      {
        id: 2,
        title: 'Task 2',
        description: null,
        status: 'done',
        priority: 'high',
        project_id: 1,
        assignee: 'bob',
        created_by: 'alice',
        due_date: null,
        created_at: '2026-02-13T00:00:00Z',
        updated_at: '2026-02-13T00:00:00Z',
        tags: [],
      },
    ]);

    await program.parseAsync(['node', 'test', 'list']);

    // Console.log should be called (table output)
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  it('shows task count after table', async () => {
    const { listTasks } = await import('../api/client.js');
    vi.mocked(listTasks).mockResolvedValue([
      {
        id: 1,
        title: 'Task 1',
        description: null,
        status: 'open',
        priority: 'medium',
        project_id: 1,
        assignee: null,
        created_by: 'alice',
        due_date: null,
        created_at: '2026-02-13T00:00:00Z',
        updated_at: '2026-02-13T00:00:00Z',
        tags: [],
      },
      {
        id: 2,
        title: 'Task 2',
        description: null,
        status: 'done',
        priority: 'high',
        project_id: 1,
        assignee: 'bob',
        created_by: 'alice',
        due_date: null,
        created_at: '2026-02-13T00:00:00Z',
        updated_at: '2026-02-13T00:00:00Z',
        tags: [],
      },
      {
        id: 3,
        title: 'Task 3',
        description: null,
        status: 'blocked',
        priority: 'urgent',
        project_id: 1,
        assignee: 'alice',
        created_by: 'alice',
        due_date: null,
        created_at: '2026-02-13T00:00:00Z',
        updated_at: '2026-02-13T00:00:00Z',
        tags: [],
      },
    ]);

    await program.parseAsync(['node', 'test', 'list']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('3 task(s) found'));
  });

  it('passes --limit and --offset through to listTasks', async () => {
    const { listTasks } = await import('../api/client.js');
    vi.mocked(listTasks).mockResolvedValue([]);

    await program.parseAsync(['node', 'test', 'list', '--limit', '25', '--offset', '50']);

    expect(listTasks).toHaveBeenCalledWith({ limit: 25, offset: 50 });
  });

  it('rejects --limit > 500 before calling the API', async () => {
    const { listTasks } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'list', '--limit', '501']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('rejects negative --offset before calling the API', async () => {
    const { listTasks } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'list', '--offset', '-1']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('validates status filter value', async () => {
    const { listTasks } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'list', '--status', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('outputs JSON when --json flag set', async () => {
    const { listTasks } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    const mockTasks = [
      {
        id: 1,
        title: 'Task 1',
        description: null,
        status: 'open' as const,
        priority: 'medium' as const,
        project_id: 1,
        assignee: null,
        created_by: 'alice',
        due_date: null,
        created_at: '2026-02-13T00:00:00Z',
        updated_at: '2026-02-13T00:00:00Z',
        tags: [],
      },
      {
        id: 2,
        title: 'Task 2',
        description: null,
        status: 'done' as const,
        priority: 'high' as const,
        project_id: 1,
        assignee: 'bob',
        created_by: 'alice',
        due_date: null,
        created_at: '2026-02-13T00:00:00Z',
        updated_at: '2026-02-13T00:00:00Z',
        tags: [],
      },
    ];

    vi.mocked(listTasks).mockResolvedValue(mockTasks);

    // Global options like --json go before subcommand name
    await program.parseAsync(['node', 'test', '--json', 'list']);

    expect(jsonOutput).toHaveBeenCalledWith(mockTasks, { count: 2 });
    // Should NOT show task count message in JSON mode
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('task(s) found'));
  });

  it('JSON output is parseable', async () => {
    const { listTasks } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    const mockTasks = [
      {
        id: 1,
        title: 'Task 1',
        description: null,
        status: 'open' as const,
        priority: 'medium' as const,
        project_id: 1,
        assignee: null,
        created_by: 'alice',
        due_date: null,
        created_at: '2026-02-13T00:00:00Z',
        updated_at: '2026-02-13T00:00:00Z',
        tags: [],
      },
    ];

    vi.mocked(listTasks).mockResolvedValue(mockTasks);

    // Global options like --json go before subcommand name
    await program.parseAsync(['node', 'test', '--json', 'list']);

    // Verify jsonOutput was called (the function itself handles JSON stringification)
    expect(jsonOutput).toHaveBeenCalled();

    // Verify the data structure passed to jsonOutput is valid
    const callArgs = vi.mocked(jsonOutput).mock.calls[0];
    expect(callArgs[0]).toEqual(mockTasks);
    expect(callArgs[1]).toEqual({ count: 1 });

    // Verify it would be parseable as JSON
    expect(() =>
      JSON.stringify({ success: true, data: callArgs[0], metadata: callArgs[1] }),
    ).not.toThrow();
  });
});
