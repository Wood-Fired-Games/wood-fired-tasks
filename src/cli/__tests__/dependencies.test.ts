import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module - use importOriginal to preserve ApiClientError
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    getDependencies: vi.fn(),
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

// Mock the json-output module
vi.mock('../output/json-output.js', () => ({
  jsonOutput: vi.fn(),
}));

// Mock the formatters module
vi.mock('../output/formatters.js', () => ({
  formatDependencyList: vi.fn((deps) => `Blocks: ${deps.blocks.length}, Blocked by: ${deps.blocked_by.length}`),
}));

const mockDependency = {
  id: 1,
  task_id: 1,
  blocks_task_id: 2,
  created_at: '2024-01-01T00:00:00Z',
};

const mockDependencyList = {
  blocks: [mockDependency],
  blocked_by: [],
};

describe('dep-add command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { depAddCommand } = await import('../commands/dep-add.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(depAddCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('adds dependency between two tasks', async () => {
    const { addDependency } = await import('../api/client.js');

    vi.mocked(addDependency).mockResolvedValue(mockDependency);

    await program.parseAsync(['node', 'test', 'dep-add', '1', '2']);

    expect(addDependency).toHaveBeenCalledWith(1, { blocks_task_id: 2 });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dependency added: Task 1 blocks Task 2')
    );
  });

  it('outputs JSON when --json flag set', async () => {
    const { addDependency } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(addDependency).mockResolvedValue(mockDependency);

    await program.parseAsync(['node', 'test', '--json', 'dep-add', '1', '2']);

    expect(addDependency).toHaveBeenCalledWith(1, { blocks_task_id: 2 });
    expect(jsonOutput).toHaveBeenCalledWith({ dependency: mockDependency });
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Dependency added')
    );
  });

  it('shows cycle detection error from API', async () => {
    const { addDependency, ApiClientError } = await import('../api/client.js');

    vi.mocked(addDependency).mockRejectedValue(
      new ApiClientError('Would create a cycle', 422, {
        error: 'VALIDATION_ERROR',
        message: 'Would create a cycle',
      })
    );

    await program.parseAsync(['node', 'test', 'dep-add', '2', '1']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Would create a cycle')
    );
    expect(process.exitCode).toBe(1);
  });

  it('validates task ID is a number', async () => {
    const { addDependency } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'dep-add', 'invalid', '2']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('must be a number')
    );
    expect(addDependency).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('validates blocks-id is a number', async () => {
    const { addDependency } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'dep-add', '1', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('must be a number')
    );
    expect(addDependency).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('dep-remove command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { depRemoveCommand } = await import('../commands/dep-remove.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(depRemoveCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('removes dependency when confirmed', async () => {
    const { removeDependency } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(removeDependency).mockResolvedValue(undefined);

    await program.parseAsync(['node', 'test', 'dep-remove', '1', '2']);

    expect(confirmAction).toHaveBeenCalledWith(
      'Remove dependency: Task 1 blocks Task 2?',
      false
    );
    expect(removeDependency).toHaveBeenCalledWith(1, 2);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('no longer blocks')
    );
  });

  it('skips removal when not confirmed', async () => {
    const { removeDependency } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    vi.mocked(confirmAction).mockResolvedValue(false);

    await program.parseAsync(['node', 'test', 'dep-remove', '1', '2']);

    expect(confirmAction).toHaveBeenCalled();
    expect(removeDependency).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('cancelled')
    );
  });

  it('removes dependency with --force flag', async () => {
    const { removeDependency } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(removeDependency).mockResolvedValue(undefined);

    await program.parseAsync(['node', 'test', '--force', 'dep-remove', '1', '2']);

    expect(removeDependency).toHaveBeenCalledWith(1, 2);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('no longer blocks')
    );
  });

  it('outputs JSON when --json flag set', async () => {
    const { removeDependency } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(removeDependency).mockResolvedValue(undefined);

    await program.parseAsync(['node', 'test', '--json', '--force', 'dep-remove', '1', '2']);

    expect(jsonOutput).toHaveBeenCalledWith(
      {},
      { message: 'Dependency removed: Task 1 no longer blocks Task 2' }
    );
    expect(consoleLogSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('no longer blocks')
    );
  });

  it('shows cancellation in JSON mode', async () => {
    const { removeDependency } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(confirmAction).mockResolvedValue(false);

    await program.parseAsync(['node', 'test', '--json', 'dep-remove', '1', '2']);

    expect(removeDependency).not.toHaveBeenCalled();
    expect(jsonOutput).toHaveBeenCalledWith({}, { message: 'Removal cancelled' });
  });
});

describe('dep-list command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { depListCommand } = await import('../commands/dep-list.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(depListCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('lists dependencies showing blocks and blocked_by', async () => {
    const { getDependencies } = await import('../api/client.js');
    const { formatDependencyList } = await import('../output/formatters.js');

    vi.mocked(getDependencies).mockResolvedValue(mockDependencyList);

    await program.parseAsync(['node', 'test', 'dep-list', '1']);

    expect(getDependencies).toHaveBeenCalledWith(1);
    expect(formatDependencyList).toHaveBeenCalledWith(mockDependencyList);
    expect(consoleLogSpy).toHaveBeenCalledWith('Blocks: 1, Blocked by: 0');
  });

  it('shows None when no dependencies', async () => {
    const { getDependencies } = await import('../api/client.js');
    const { formatDependencyList } = await import('../output/formatters.js');

    const emptyDeps = { blocks: [], blocked_by: [] };
    vi.mocked(getDependencies).mockResolvedValue(emptyDeps);

    await program.parseAsync(['node', 'test', 'dep-list', '1']);

    expect(getDependencies).toHaveBeenCalledWith(1);
    expect(formatDependencyList).toHaveBeenCalledWith(emptyDeps);
    expect(consoleLogSpy).toHaveBeenCalledWith('Blocks: 0, Blocked by: 0');
  });

  it('outputs JSON when --json flag set', async () => {
    const { getDependencies } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(getDependencies).mockResolvedValue(mockDependencyList);

    await program.parseAsync(['node', 'test', '--json', 'dep-list', '1']);

    expect(jsonOutput).toHaveBeenCalledWith(mockDependencyList);
    const { formatDependencyList } = await import('../output/formatters.js');
    expect(formatDependencyList).not.toHaveBeenCalled();
  });

  it('shows error when task not found', async () => {
    const { getDependencies, ApiClientError } = await import('../api/client.js');

    vi.mocked(getDependencies).mockRejectedValue(
      new ApiClientError('Task not found', 404, {
        error: 'NOT_FOUND',
        message: 'Task not found',
      })
    );

    await program.parseAsync(['node', 'test', 'dep-list', '99999']);

    expect(getDependencies).toHaveBeenCalledWith(99999);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('validates task ID is a number', async () => {
    const { getDependencies } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'dep-list', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('must be a number')
    );
    expect(getDependencies).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
