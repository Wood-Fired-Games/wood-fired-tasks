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
        created_by: 'stuart',
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

    await program.parseAsync([
      'node',
      'test',
      'list',
      '-p',
      '1',
      '-s',
      'open',
      '-a',
      'stuart',
    ]);

    expect(listTasks).toHaveBeenCalledWith({
      project_id: 1,
      status: 'open',
      assignee: 'stuart',
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
        created_by: 'stuart',
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
        created_by: 'stuart',
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
        created_by: 'stuart',
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
        created_by: 'stuart',
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
        created_by: 'stuart',
        due_date: null,
        created_at: '2026-02-13T00:00:00Z',
        updated_at: '2026-02-13T00:00:00Z',
        tags: [],
      },
    ]);

    await program.parseAsync(['node', 'test', 'list']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('3 task(s) found'));
  });

  it('validates status filter value', async () => {
    const { listTasks } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'list', '--status', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(listTasks).not.toHaveBeenCalled();
  });
});
