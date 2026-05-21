import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module - use importOriginal to preserve ApiClientError
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    deleteTask: vi.fn(),
    getTask: vi.fn(),
  };
});

// Mock the env module to avoid validation errors
vi.mock('../config/env.js', () => ({
  env: {
    API_BASE_URL: 'http://localhost:3000',
    API_KEY: 'test-key',
  },
}));

// Mock the prompts module
vi.mock('../prompts/interactive.js', () => ({
  confirmAction: vi.fn(),
}));

// Mock the spinner module (used by withApiSpinner in client.js)
vi.mock('../output/spinner.js', () => ({
  withSpinner: vi.fn((_msg: string, fn: () => Promise<unknown>) => fn()),
  shouldShowSpinner: vi.fn(() => false),
}));

// Mock the formatters module
vi.mock('../output/formatters.js', () => ({
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
}));

describe('delete command', () => {
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
    const { deleteCommand } = await import('../commands/delete.js');
    program = new Command();
    // Register global options (like the main CLI does)
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(deleteCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('deletes task when confirmed', async () => {
    const { deleteTask, getTask } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    const mockTask = {
      id: 1,
      title: 'Task to delete',
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
    };

    vi.mocked(getTask).mockResolvedValue(mockTask);
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(deleteTask).mockResolvedValue(undefined);

    await program.parseAsync(['node', 'test', 'delete', '1']);

    expect(getTask).toHaveBeenCalledWith(1);
    expect(confirmAction).toHaveBeenCalledWith("Delete task 'Task to delete'?", false);
    expect(deleteTask).toHaveBeenCalledWith(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('deleted successfully'));
  });

  it('skips deletion when not confirmed', async () => {
    const { deleteTask, getTask } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    const mockTask = {
      id: 2,
      title: 'Task not to delete',
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
    };

    vi.mocked(getTask).mockResolvedValue(mockTask);
    vi.mocked(confirmAction).mockResolvedValue(false);

    await program.parseAsync(['node', 'test', 'delete', '2']);

    expect(getTask).toHaveBeenCalledWith(2);
    expect(confirmAction).toHaveBeenCalledWith("Delete task 'Task not to delete'?", false);
    expect(deleteTask).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
  });

  it('deletes task with --force flag', async () => {
    const { deleteTask, getTask } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    const mockTask = {
      id: 3,
      title: 'Force delete task',
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
    };

    vi.mocked(getTask).mockResolvedValue(mockTask);
    // confirmAction returns true immediately when --force is set
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(deleteTask).mockResolvedValue(undefined);

    await program.parseAsync(['node', 'test', '--force', 'delete', '3']);

    expect(getTask).toHaveBeenCalledWith(3);
    expect(deleteTask).toHaveBeenCalledWith(3);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('deleted successfully'));
  });

  it('outputs JSON when --json flag set', async () => {
    const { deleteTask, getTask } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');
    const { jsonOutput } = await import('../output/json-output.js');

    const mockTask = {
      id: 4,
      title: 'JSON delete task',
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
    };

    vi.mocked(getTask).mockResolvedValue(mockTask);
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(deleteTask).mockResolvedValue(undefined);

    // Global options like --json go before subcommand name
    await program.parseAsync(['node', 'test', '--json', '--force', 'delete', '4']);

    expect(jsonOutput).toHaveBeenCalledWith({}, { message: 'Task 4 deleted' });
    // Should NOT show success message in JSON mode
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('deleted successfully'));
  });

  it('shows error when task not found', async () => {
    const { getTask, deleteTask } = await import('../api/client.js');
    const { ApiClientError } = await import('../api/client.js');

    vi.mocked(getTask).mockRejectedValue(
      new ApiClientError('Task not found', 404, {
        error: 'NOT_FOUND',
        message: 'Task not found',
      })
    );

    await program.parseAsync(['node', 'test', 'delete', '99999']);

    expect(getTask).toHaveBeenCalledWith(99999);
    expect(deleteTask).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('validates task ID is a number', async () => {
    const { deleteTask } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'delete', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    expect(deleteTask).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
