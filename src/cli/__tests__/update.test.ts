import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module - use importOriginal to preserve ApiClientError
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    updateTask: vi.fn(),
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
  messageOutput: vi.fn(),
}));

describe('update command', () => {
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
    const { updateCommand } = await import('../commands/update.js');
    program = new Command();
    // Register global options (like the main CLI does)
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(updateCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('updates task status', async () => {
    const { updateTask } = await import('../api/client.js');
    vi.mocked(updateTask).mockResolvedValue({
      id: 1,
      title: 'Task 1',
      description: null,
      status: 'done',
      priority: 'medium',
      project_id: 1,
      assignee: null,
      created_by: 'stuart',
      due_date: null,
      created_at: '2026-02-13T00:00:00Z',
      updated_at: '2026-02-13T00:00:00Z',
      tags: [],
    });

    await program.parseAsync(['node', 'test', 'update', '1', '-s', 'done']);

    expect(updateTask).toHaveBeenCalledWith(1, { status: 'done' });
  });

  it('updates multiple fields', async () => {
    const { updateTask } = await import('../api/client.js');
    vi.mocked(updateTask).mockResolvedValue({
      id: 5,
      title: 'New title',
      description: null,
      status: 'open',
      priority: 'high',
      project_id: 1,
      assignee: 'bob',
      created_by: 'stuart',
      due_date: null,
      created_at: '2026-02-13T00:00:00Z',
      updated_at: '2026-02-13T00:00:00Z',
      tags: [],
    });

    await program.parseAsync([
      'node',
      'test',
      'update',
      '5',
      '-t',
      'New title',
      '--priority',
      'high',
      '-a',
      'bob',
    ]);

    expect(updateTask).toHaveBeenCalledWith(5, {
      title: 'New title',
      priority: 'high',
      assignee: 'bob',
    });
  });

  it('shows success message after update', async () => {
    const { updateTask } = await import('../api/client.js');
    vi.mocked(updateTask).mockResolvedValue({
      id: 1,
      title: 'Task 1',
      description: null,
      status: 'done',
      priority: 'medium',
      project_id: 1,
      assignee: null,
      created_by: 'stuart',
      due_date: null,
      created_at: '2026-02-13T00:00:00Z',
      updated_at: '2026-02-13T00:00:00Z',
      tags: [],
    });

    await program.parseAsync(['node', 'test', 'update', '1', '-s', 'done']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('updated successfully'));
  });

  it('shows error for no updates specified', async () => {
    const { updateTask } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'update', '1']);

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('No updates specified')
    );
    expect(process.exitCode).toBe(1);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('validates status value', async () => {
    const { updateTask } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'update', '1', '--status', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('validates priority value', async () => {
    const { updateTask } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'update', '1', '--priority', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('handles task not found', async () => {
    const { updateTask } = await import('../api/client.js');
    const { ApiClientError } = await import('../api/client.js');

    vi.mocked(updateTask).mockRejectedValue(
      new ApiClientError('Task not found', 404, {
        error: 'NOT_FOUND',
        message: 'Task not found',
      })
    );

    await program.parseAsync(['node', 'test', 'update', '999', '-s', 'done']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('parses tags correctly', async () => {
    const { updateTask } = await import('../api/client.js');
    vi.mocked(updateTask).mockResolvedValue({
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
      tags: ['bug', 'ui', 'frontend'],
    });

    await program.parseAsync([
      'node',
      'test',
      'update',
      '1',
      '--tags',
      'bug, ui, frontend',
    ]);

    expect(updateTask).toHaveBeenCalledWith(1, {
      tags: ['bug', 'ui', 'frontend'],
    });
  });

  it('outputs JSON when --json flag set', async () => {
    const { updateTask } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    const mockTask = {
      id: 5,
      title: 'Updated task',
      description: null,
      status: 'done' as const,
      priority: 'high' as const,
      project_id: 1,
      assignee: 'bob',
      created_by: 'stuart',
      due_date: null,
      created_at: '2026-02-13T00:00:00Z',
      updated_at: '2026-02-13T00:00:00Z',
      tags: [],
    };

    vi.mocked(updateTask).mockResolvedValue(mockTask);

    // Global options like --json go before subcommand name
    await program.parseAsync(['node', 'test', '--json', 'update', '5', '-s', 'done', '--priority', 'high', '-a', 'bob']);

    expect(jsonOutput).toHaveBeenCalledWith({ task: mockTask }, { id: mockTask.id });
    // Should NOT show success message in JSON mode
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('updated successfully'));
  });
});
