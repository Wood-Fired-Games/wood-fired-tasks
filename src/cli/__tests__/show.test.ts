import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module - use importOriginal to preserve ApiClientError
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
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

// Mock the json-output module
vi.mock('../output/json-output.js', () => ({
  jsonOutput: vi.fn(),
}));

// Mock the spinner module (used by withApiSpinner in client.js)
vi.mock('../output/spinner.js', () => ({
  withSpinner: vi.fn((_msg: string, fn: () => Promise<unknown>) => fn()),
  shouldShowSpinner: vi.fn(() => false),
}));

// Mock the formatters module
vi.mock('../output/formatters.js', () => ({
  formatTaskDetail: vi.fn((task) => `Task #${task.id}: ${task.title}`),
  colorSuccess: vi.fn((text: string) => text),
  colorError: vi.fn((text: string) => text),
  colorWarn: vi.fn((text: string) => text),
  colorInfo: vi.fn((text: string) => text),
  colorBold: vi.fn((text: string) => text),
  isJsonMode: vi.fn(() => false),
  shouldUseColor: vi.fn(() => false),
}));

describe('show command', () => {
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
    const { showCommand } = await import('../commands/show.js');
    program = new Command();
    // Register global options (like the main CLI does)
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(showCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('shows task details in terminal mode', async () => {
    const { getTask } = await import('../api/client.js');
    const { formatTaskDetail } = await import('../output/formatters.js');

    const mockTask = {
      id: 1,
      title: 'Task to show',
      description: 'Task description',
      status: 'open' as const,
      priority: 'high' as const,
      project_id: 1,
      assignee: 'bob',
      created_by: 'alice',
      due_date: '2025-12-31T00:00:00Z',
      created_at: '2026-02-13T00:00:00Z',
      updated_at: '2026-02-13T00:00:00Z',
      tags: ['bug', 'ui'],
    };

    vi.mocked(getTask).mockResolvedValue(mockTask);

    await program.parseAsync(['node', 'test', 'show', '1']);

    expect(getTask).toHaveBeenCalledWith(1);
    expect(formatTaskDetail).toHaveBeenCalledWith(mockTask);
    expect(consoleLogSpy).toHaveBeenCalledWith('Task #1: Task to show');
  });

  it('outputs JSON when --json flag set', async () => {
    const { getTask } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    const mockTask = {
      id: 2,
      title: 'JSON show task',
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

    // Global options like --json go before subcommand name
    await program.parseAsync(['node', 'test', '--json', 'show', '2']);

    expect(jsonOutput).toHaveBeenCalledWith({ task: mockTask });
    // Should NOT call formatTaskDetail in JSON mode
    const { formatTaskDetail } = await import('../output/formatters.js');
    expect(formatTaskDetail).not.toHaveBeenCalled();
  });

  it('shows error when task not found', async () => {
    const { getTask } = await import('../api/client.js');
    const { ApiClientError } = await import('../api/client.js');

    vi.mocked(getTask).mockRejectedValue(
      new ApiClientError('Task not found', 404, {
        error: 'NOT_FOUND',
        message: 'Task not found',
      }),
    );

    await program.parseAsync(['node', 'test', 'show', '99999']);

    expect(getTask).toHaveBeenCalledWith(99999);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('displays all task fields', async () => {
    const { getTask } = await import('../api/client.js');
    const { formatTaskDetail } = await import('../output/formatters.js');

    const mockTask = {
      id: 3,
      title: 'Complete task',
      description: 'Full description',
      status: 'in_progress' as const,
      priority: 'urgent' as const,
      project_id: 5,
      assignee: 'alice',
      created_by: 'bob',
      due_date: '2026-03-15T00:00:00Z',
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-10T00:00:00Z',
      tags: ['feature', 'backend', 'database'],
    };

    vi.mocked(getTask).mockResolvedValue(mockTask);

    await program.parseAsync(['node', 'test', 'show', '3']);

    expect(getTask).toHaveBeenCalledWith(3);
    expect(formatTaskDetail).toHaveBeenCalledWith(mockTask);
    // Verify the formatted output includes task data
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Complete task'));
  });

  it('validates task ID is a number', async () => {
    const { getTask } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'show', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    expect(getTask).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
