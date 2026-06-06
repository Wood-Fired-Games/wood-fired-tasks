import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module - use importOriginal to preserve ApiClientError
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    claimTask: vi.fn(),
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

describe('claim command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  const mockClaimedTask = {
    id: 1,
    title: 'Fix authentication bug',
    description: null,
    status: 'in_progress',
    priority: 'high',
    project_id: 1,
    assignee: 'agent-1',
    created_by: 'alice',
    due_date: null,
    created_at: '2026-02-13T00:00:00Z',
    updated_at: '2026-02-14T10:00:00Z',
    tags: ['backend'],
  };

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Reset process.exitCode
    process.exitCode = 0;

    // Import after mocks are set up
    const { claimCommand } = await import('../commands/claim.js');
    program = new Command();
    // Register global options (like the main CLI does)
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(claimCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('claims a task and displays success message', async () => {
    const { claimTask } = await import('../api/client.js');
    vi.mocked(claimTask).mockResolvedValue(mockClaimedTask);

    await program.parseAsync(['node', 'test', 'claim', '1', '-a', 'agent-1']);

    expect(claimTask).toHaveBeenCalledWith(1, 'agent-1', undefined);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('claimed by agent-1'));
  });

  it('outputs JSON when --json flag set', async () => {
    const { claimTask } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(claimTask).mockResolvedValue(mockClaimedTask);

    await program.parseAsync(['node', 'test', '--json', 'claim', '1', '-a', 'agent-1']);

    expect(jsonOutput).toHaveBeenCalledWith(
      { task: mockClaimedTask },
      { id: mockClaimedTask.id, assignee: mockClaimedTask.assignee },
    );
    // Should NOT show terminal success message in JSON mode
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('claimed by'));
  });

  it('shows error for non-existent task (404)', async () => {
    const { claimTask, ApiClientError } = await import('../api/client.js');

    vi.mocked(claimTask).mockRejectedValue(
      new ApiClientError('Task not found', 404, {
        error: 'NOT_FOUND',
        message: 'Task not found',
      }),
    );

    await program.parseAsync(['node', 'test', 'claim', '999', '-a', 'agent-1']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('shows error for already-claimed task (409)', async () => {
    const { claimTask, ApiClientError } = await import('../api/client.js');

    vi.mocked(claimTask).mockRejectedValue(
      new ApiClientError('Task is already claimed', 409, {
        error: 'CONFLICT',
        message: 'Task is already claimed by agent-1',
      }),
    );

    await program.parseAsync(['node', 'test', 'claim', '1', '-a', 'agent-2']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('shows error for invalid task ID', async () => {
    const { claimTask } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'claim', 'abc', '-a', 'agent-1']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid task ID'));
    expect(process.exitCode).toBe(1);
    expect(claimTask).not.toHaveBeenCalled();
  });

  it('requires --assignee option', async () => {
    // Commander handles required options - it calls process.exit
    // We test that claim is not called without assignee
    const { claimTask } = await import('../api/client.js');

    // Commander will throw/exit for missing required option
    // We catch it and verify claimTask was never called
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    try {
      await program.parseAsync(['node', 'test', 'claim', '1']);
    } catch {
      // Expected - commander calls process.exit for missing required option
    }

    expect(claimTask).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('passes idempotency key when provided', async () => {
    const { claimTask } = await import('../api/client.js');
    vi.mocked(claimTask).mockResolvedValue(mockClaimedTask);

    await program.parseAsync([
      'node',
      'test',
      'claim',
      '1',
      '-a',
      'agent-1',
      '--idempotency-key',
      'retry-key-123',
    ]);

    expect(claimTask).toHaveBeenCalledWith(1, 'agent-1', 'retry-key-123');
  });
});
