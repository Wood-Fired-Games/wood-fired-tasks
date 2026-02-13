import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module - use importOriginal to preserve ApiClientError
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    createTask: vi.fn(),
  };
});

// Mock the env module to avoid validation errors
vi.mock('../config/env.js', () => ({
  env: {
    API_BASE_URL: 'http://localhost:3000',
    API_KEY: 'test-key',
  },
}));

describe('create command', () => {
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
    const { createCommand } = await import('../commands/create.js');
    program = new Command();
    program.addCommand(createCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('creates task with required options', async () => {
    const { createTask } = await import('../api/client.js');
    vi.mocked(createTask).mockResolvedValue({
      id: 1,
      title: 'Test task',
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
    });

    await program.parseAsync(['node', 'test', 'create', '-t', 'Test task', '-p', '1', '-c', 'stuart']);

    expect(createTask).toHaveBeenCalledWith({
      title: 'Test task',
      project_id: 1,
      created_by: 'stuart',
      priority: 'medium',
    });
  });

  it('creates task with all options', async () => {
    const { createTask } = await import('../api/client.js');
    vi.mocked(createTask).mockResolvedValue({
      id: 2,
      title: 'Full task',
      description: 'A bug',
      status: 'open',
      priority: 'high',
      project_id: 1,
      assignee: 'bob',
      created_by: 'stuart',
      due_date: '2025-12-31T00:00:00Z',
      created_at: '2026-02-13T00:00:00Z',
      updated_at: '2026-02-13T00:00:00Z',
      tags: ['bug', 'ui'],
    });

    await program.parseAsync([
      'node',
      'test',
      'create',
      '-t',
      'Full task',
      '-p',
      '1',
      '-c',
      'stuart',
      '--priority',
      'high',
      '--assignee',
      'bob',
      '--due',
      '2025-12-31T00:00:00Z',
      '--tags',
      'bug,ui',
      '--description',
      'A bug',
    ]);

    expect(createTask).toHaveBeenCalledWith({
      title: 'Full task',
      project_id: 1,
      created_by: 'stuart',
      priority: 'high',
      assignee: 'bob',
      due_date: '2025-12-31T00:00:00Z',
      tags: ['bug', 'ui'],
      description: 'A bug',
    });
  });

  it('shows success message after creation', async () => {
    const { createTask } = await import('../api/client.js');
    vi.mocked(createTask).mockResolvedValue({
      id: 3,
      title: 'Test task',
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
    });

    await program.parseAsync(['node', 'test', 'create', '-t', 'Test task', '-p', '1', '-c', 'stuart']);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('created successfully'));
  });

  it('validates priority value', async () => {
    const { createTask } = await import('../api/client.js');

    await program.parseAsync([
      'node',
      'test',
      'create',
      '-t',
      'Test task',
      '-p',
      '1',
      '-c',
      'stuart',
      '--priority',
      'invalid',
    ]);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('handles API errors', async () => {
    const { createTask } = await import('../api/client.js');
    const { ApiClientError } = await import('../api/client.js');

    vi.mocked(createTask).mockRejectedValue(
      new ApiClientError('Task creation failed', 400, {
        error: 'VALIDATION_ERROR',
        message: 'Task creation failed',
      })
    );

    await program.parseAsync(['node', 'test', 'create', '-t', 'Test task', '-p', '1', '-c', 'stuart']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
