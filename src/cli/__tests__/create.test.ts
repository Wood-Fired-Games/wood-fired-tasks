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

// Mock the prompts module
vi.mock('../prompts/interactive.js', () => ({
  promptForMissing: vi.fn((field, value) => Promise.resolve(value)),
  shouldPrompt: vi.fn(() => true),
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

// Mock the json-output module
vi.mock('../output/json-output.js', () => ({
  jsonOutput: vi.fn(),
  messageOutput: vi.fn(),
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
    // Register global options (like the main CLI does)
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
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
      created_by: 'alice',
      due_date: null,
      created_at: '2026-02-13T00:00:00Z',
      updated_at: '2026-02-13T00:00:00Z',
      tags: [],
    });

    await program.parseAsync([
      'node',
      'test',
      'create',
      '-t',
      'Test task',
      '-p',
      '1',
      '-c',
      'alice',
    ]);

    expect(createTask).toHaveBeenCalledWith({
      title: 'Test task',
      project_id: 1,
      created_by: 'alice',
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
      created_by: 'alice',
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
      'alice',
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
      created_by: 'alice',
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
      created_by: 'alice',
      due_date: null,
      created_at: '2026-02-13T00:00:00Z',
      updated_at: '2026-02-13T00:00:00Z',
      tags: [],
    });

    await program.parseAsync([
      'node',
      'test',
      'create',
      '-t',
      'Test task',
      '-p',
      '1',
      '-c',
      'alice',
    ]);

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
      'alice',
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
      }),
    );

    await program.parseAsync([
      'node',
      'test',
      'create',
      '-t',
      'Test task',
      '-p',
      '1',
      '-c',
      'alice',
    ]);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('outputs JSON when --json flag set', async () => {
    const { createTask } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    const mockTask = {
      id: 10,
      title: 'JSON test task',
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

    vi.mocked(createTask).mockResolvedValue(mockTask);

    // Global options like --json go before subcommand name
    await program.parseAsync([
      'node',
      'test',
      '--json',
      'create',
      '-t',
      'JSON test task',
      '-p',
      '1',
      '-c',
      'alice',
    ]);

    expect(jsonOutput).toHaveBeenCalledWith({ task: mockTask }, { id: mockTask.id });
    // Should NOT show success message in JSON mode
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('created successfully'));
  });

  it('passes --acceptance into the createTask payload as acceptance_criteria (#311)', async () => {
    // Wave 1.3: CLI exposes the new server field via --acceptance <text>.
    // Single-value flag — the caller can embed newlines via $'...' if they
    // want multi-line markdown. The flag name diverges from the field name
    // for ergonomics (`--acceptance` is shorter than `--acceptance-criteria`).
    const { createTask } = await import('../api/client.js');
    vi.mocked(createTask).mockResolvedValue({
      id: 99,
      title: 'Acceptance flag task',
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
    });

    await program.parseAsync([
      'node',
      'test',
      'create',
      '-t',
      'Acceptance flag task',
      '-p',
      '1',
      '-c',
      'alice',
      '--acceptance',
      'tests pass; lint clean',
    ]);

    expect(createTask).toHaveBeenCalledWith({
      title: 'Acceptance flag task',
      project_id: 1,
      created_by: 'alice',
      priority: 'medium',
      acceptance_criteria: 'tests pass; lint clean',
    });
  });

  it('prompts for missing title when not provided', async () => {
    const { createTask } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');

    vi.mocked(promptForMissing).mockImplementation((field, value) =>
      Promise.resolve(value || 'Prompted title'),
    );

    vi.mocked(createTask).mockResolvedValue({
      id: 11,
      title: 'Prompted title',
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
    });

    await program.parseAsync(['node', 'test', 'create', '-p', '1', '-c', 'alice']);

    // Verify promptForMissing was called for title
    expect(promptForMissing).toHaveBeenCalledWith('title', undefined);
  });
});
