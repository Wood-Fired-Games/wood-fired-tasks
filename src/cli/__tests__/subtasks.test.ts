import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module - use importOriginal to preserve ApiClientError
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    createSubtask: vi.fn(),
    getSubtasks: vi.fn(),
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
  promptForMissing: vi.fn(),
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
  formatTaskTable: vi.fn((tasks) =>
    tasks.map((t: { id: number; title: string }) => `${t.id} ${t.title}`).join('\n')
  ),
  colorSuccess: vi.fn((text: string) => text),
  colorError: vi.fn((text: string) => text),
  colorWarn: vi.fn((text: string) => text),
  colorInfo: vi.fn((text: string) => text),
  colorBold: vi.fn((text: string) => text),
  isJsonMode: vi.fn(() => false),
  shouldUseColor: vi.fn(() => false),
}));

const mockParentTask = {
  id: 1,
  title: 'Parent Task',
  description: null,
  status: 'open',
  priority: 'medium',
  project_id: 1,
  assignee: null,
  created_by: 'alice',
  due_date: null,
  created_at: '2024-01-15T10:00:00Z',
  updated_at: '2024-01-15T10:00:00Z',
  tags: [],
};

const mockSubtask = {
  id: 2,
  title: 'Subtask',
  description: null,
  status: 'open',
  priority: 'medium',
  project_id: 1,
  assignee: null,
  created_by: 'alice',
  due_date: null,
  created_at: '2024-01-15T10:30:00Z',
  updated_at: '2024-01-15T10:30:00Z',
  tags: [],
};

const mockSubtasks = [
  mockSubtask,
  {
    id: 3,
    title: 'Another Subtask',
    description: null,
    status: 'in_progress',
    priority: 'high',
    project_id: 1,
    assignee: 'bob',
    created_by: 'alice',
    due_date: null,
    created_at: '2024-01-15T11:00:00Z',
    updated_at: '2024-01-15T11:00:00Z',
    tags: [],
  },
];

describe('subtask-create command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { subtaskCreateCommand } = await import('../commands/subtask-create.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(subtaskCreateCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('creates subtask with title and created-by', async () => {
    const { createSubtask, getTask } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');

    vi.mocked(getTask).mockResolvedValue(mockParentTask);
    vi.mocked(promptForMissing)
      .mockResolvedValueOnce('Subtask')
      .mockResolvedValueOnce('alice');
    vi.mocked(createSubtask).mockResolvedValue(mockSubtask);

    await program.parseAsync(['node', 'test', 'subtask-create', '1', '-t', 'Subtask', '-c', 'alice']);

    expect(getTask).toHaveBeenCalledWith(1);
    expect(createSubtask).toHaveBeenCalledWith(1, expect.objectContaining({
      title: 'Subtask',
      created_by: 'alice',
      project_id: 1,
    }));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Subtask created under task #1'));
  });

  it('fetches parent task to inherit project_id', async () => {
    const { createSubtask, getTask } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');

    const parentWithProject3 = { ...mockParentTask, project_id: 3 };
    vi.mocked(getTask).mockResolvedValue(parentWithProject3);
    vi.mocked(promptForMissing)
      .mockResolvedValueOnce('Child Task')
      .mockResolvedValueOnce('bob');
    vi.mocked(createSubtask).mockResolvedValue({ ...mockSubtask, project_id: 3 });

    await program.parseAsync(['node', 'test', 'subtask-create', '1', '-t', 'Child Task', '-c', 'bob']);

    expect(getTask).toHaveBeenCalledWith(1);
    expect(createSubtask).toHaveBeenCalledWith(1, expect.objectContaining({
      project_id: 3,
    }));
  });

  it('prompts for missing title when not provided', async () => {
    const { createSubtask, getTask } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');

    vi.mocked(getTask).mockResolvedValue(mockParentTask);
    vi.mocked(promptForMissing)
      .mockResolvedValueOnce('prompted-title')
      .mockResolvedValueOnce('alice');
    vi.mocked(createSubtask).mockResolvedValue(mockSubtask);

    await program.parseAsync(['node', 'test', 'subtask-create', '1', '-c', 'alice']);

    expect(promptForMissing).toHaveBeenCalledWith('title', undefined);
    expect(createSubtask).toHaveBeenCalledWith(1, expect.objectContaining({
      title: 'prompted-title',
    }));
  });

  it('prompts for missing created-by when not provided', async () => {
    const { createSubtask, getTask } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');

    vi.mocked(getTask).mockResolvedValue(mockParentTask);
    vi.mocked(promptForMissing)
      .mockResolvedValueOnce('Subtask')
      .mockResolvedValueOnce('prompted-creator');
    vi.mocked(createSubtask).mockResolvedValue(mockSubtask);

    await program.parseAsync(['node', 'test', 'subtask-create', '1', '-t', 'Subtask']);

    expect(promptForMissing).toHaveBeenCalledWith('created-by', undefined);
    expect(createSubtask).toHaveBeenCalledWith(1, expect.objectContaining({
      created_by: 'prompted-creator',
    }));
  });

  it('outputs JSON when --json flag set', async () => {
    const { createSubtask, getTask } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(getTask).mockResolvedValue(mockParentTask);
    vi.mocked(promptForMissing)
      .mockResolvedValueOnce('Subtask')
      .mockResolvedValueOnce('alice');
    vi.mocked(createSubtask).mockResolvedValue(mockSubtask);

    await program.parseAsync(['node', 'test', '--json', 'subtask-create', '1', '-t', 'Subtask', '-c', 'alice']);

    expect(jsonOutput).toHaveBeenCalledWith(
      { task: mockSubtask },
      { id: mockSubtask.id, parent_task_id: 1 }
    );
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Subtask created'));
  });

  it('shows error when parent task not found', async () => {
    const { getTask, ApiClientError } = await import('../api/client.js');

    vi.mocked(getTask).mockRejectedValue(
      new ApiClientError('Task not found', 404, {
        error: 'NOT_FOUND',
        message: 'Task not found',
      })
    );

    await program.parseAsync(['node', 'test', 'subtask-create', '99999', '-t', 'Test', '-c', 'test']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('validates parent task ID is a number', async () => {
    const { createSubtask } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'subtask-create', 'invalid', '-t', 'Test', '-c', 'test']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    expect(createSubtask).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('subtask-list command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { subtaskListCommand } = await import('../commands/subtask-list.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(subtaskListCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('lists subtasks in table format', async () => {
    const { getSubtasks } = await import('../api/client.js');
    const { formatTaskTable } = await import('../output/formatters.js');

    vi.mocked(getSubtasks).mockResolvedValue(mockSubtasks);

    await program.parseAsync(['node', 'test', 'subtask-list', '1']);

    expect(getSubtasks).toHaveBeenCalledWith(1);
    expect(formatTaskTable).toHaveBeenCalledWith(mockSubtasks);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('2 Subtask'));
  });

  it('shows "No subtasks" when list is empty', async () => {
    const { getSubtasks } = await import('../api/client.js');

    vi.mocked(getSubtasks).mockResolvedValue([]);

    await program.parseAsync(['node', 'test', 'subtask-list', '1']);

    expect(getSubtasks).toHaveBeenCalledWith(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No subtasks'));
  });

  it('outputs JSON when --json flag set', async () => {
    const { getSubtasks } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(getSubtasks).mockResolvedValue(mockSubtasks);

    await program.parseAsync(['node', 'test', '--json', 'subtask-list', '1']);

    expect(jsonOutput).toHaveBeenCalledWith(mockSubtasks, { count: 2, parent_task_id: 1 });
    const { formatTaskTable } = await import('../output/formatters.js');
    expect(formatTaskTable).not.toHaveBeenCalled();
  });

  it('validates parent task ID is a number', async () => {
    const { getSubtasks } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'subtask-list', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    expect(getSubtasks).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('shows error when parent task not found', async () => {
    const { getSubtasks, ApiClientError } = await import('../api/client.js');

    vi.mocked(getSubtasks).mockRejectedValue(
      new ApiClientError('Task not found', 404, {
        error: 'NOT_FOUND',
        message: 'Task not found',
      })
    );

    await program.parseAsync(['node', 'test', 'subtask-list', '99999']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
