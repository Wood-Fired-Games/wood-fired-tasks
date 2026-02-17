import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock the API client module - use importOriginal to preserve ApiClientError
vi.mock('../api/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client.js')>();
  return {
    ...actual,
    addComment: vi.fn(),
    getComments: vi.fn(),
    deleteComment: vi.fn(),
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
  formatCommentList: vi.fn((comments) =>
    comments.length === 0
      ? 'No comments'
      : comments.map((c: { author: string; content: string }) => `${c.author}: ${c.content}`).join('\n')
  ),
  colorSuccess: vi.fn((text: string) => text),
  colorError: vi.fn((text: string) => text),
  colorWarn: vi.fn((text: string) => text),
  colorInfo: vi.fn((text: string) => text),
  colorBold: vi.fn((text: string) => text),
  isJsonMode: vi.fn(() => false),
  shouldUseColor: vi.fn(() => false),
}));

const mockComment = {
  id: 1,
  task_id: 1,
  author: 'alice',
  content: 'Test comment',
  created_at: '2024-01-15T10:30:00Z',
};

const mockComments = [
  mockComment,
  {
    id: 2,
    task_id: 1,
    author: 'bob',
    content: 'Another comment',
    created_at: '2024-01-15T11:45:00Z',
  },
];

describe('comment-add command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { commentAddCommand } = await import('../commands/comment-add.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(commentAddCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('adds comment with author and content', async () => {
    const { addComment } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');

    vi.mocked(promptForMissing)
      .mockResolvedValueOnce('alice')
      .mockResolvedValueOnce('Test comment');
    vi.mocked(addComment).mockResolvedValue(mockComment);

    await program.parseAsync(['node', 'test', 'comment-add', '1', '-a', 'alice', '-c', 'Test comment']);

    expect(promptForMissing).toHaveBeenCalledWith('author', 'alice');
    expect(promptForMissing).toHaveBeenCalledWith('content', 'Test comment');
    expect(addComment).toHaveBeenCalledWith(1, { author: 'alice', content: 'Test comment' });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Comment added to task 1'));
  });

  it('prompts for missing author when not provided', async () => {
    const { addComment } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');

    vi.mocked(promptForMissing)
      .mockResolvedValueOnce('prompted-author')
      .mockResolvedValueOnce('Test content');
    vi.mocked(addComment).mockResolvedValue(mockComment);

    await program.parseAsync(['node', 'test', 'comment-add', '1', '-c', 'Test content']);

    // Author should be prompted with undefined (not provided)
    expect(promptForMissing).toHaveBeenCalledWith('author', undefined);
    expect(promptForMissing).toHaveBeenCalledWith('content', 'Test content');
    expect(addComment).toHaveBeenCalledWith(1, { author: 'prompted-author', content: 'Test content' });
  });

  it('prompts for missing content when not provided', async () => {
    const { addComment } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');

    vi.mocked(promptForMissing)
      .mockResolvedValueOnce('alice')
      .mockResolvedValueOnce('prompted-content');
    vi.mocked(addComment).mockResolvedValue(mockComment);

    await program.parseAsync(['node', 'test', 'comment-add', '1', '-a', 'alice']);

    expect(promptForMissing).toHaveBeenCalledWith('author', 'alice');
    // Content should be prompted with undefined (not provided)
    expect(promptForMissing).toHaveBeenCalledWith('content', undefined);
    expect(addComment).toHaveBeenCalledWith(1, { author: 'alice', content: 'prompted-content' });
  });

  it('outputs JSON when --json flag set', async () => {
    const { addComment } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(promptForMissing)
      .mockResolvedValueOnce('alice')
      .mockResolvedValueOnce('Test comment');
    vi.mocked(addComment).mockResolvedValue(mockComment);

    await program.parseAsync(['node', 'test', '--json', 'comment-add', '1', '-a', 'alice', '-c', 'Test comment']);

    expect(jsonOutput).toHaveBeenCalledWith({ comment: mockComment });
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Comment added'));
  });

  it('shows error when task not found', async () => {
    const { addComment, ApiClientError } = await import('../api/client.js');
    const { promptForMissing } = await import('../prompts/interactive.js');

    vi.mocked(promptForMissing)
      .mockResolvedValueOnce('alice')
      .mockResolvedValueOnce('Test comment');
    vi.mocked(addComment).mockRejectedValue(
      new ApiClientError('Task not found', 404, {
        error: 'NOT_FOUND',
        message: 'Task not found',
      })
    );

    await program.parseAsync(['node', 'test', 'comment-add', '99999', '-a', 'alice', '-c', 'Test']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('validates task ID is a number', async () => {
    const { addComment } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'comment-add', 'invalid', '-a', 'alice', '-c', 'Test']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    expect(addComment).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('comment-list command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { commentListCommand } = await import('../commands/comment-list.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(commentListCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('lists comments in chronological order', async () => {
    const { getComments } = await import('../api/client.js');
    const { formatCommentList } = await import('../output/formatters.js');

    vi.mocked(getComments).mockResolvedValue(mockComments);

    await program.parseAsync(['node', 'test', 'comment-list', '1']);

    expect(getComments).toHaveBeenCalledWith(1);
    expect(formatCommentList).toHaveBeenCalledWith(mockComments);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('alice: Test comment'));
  });

  it('shows "No comments" when list is empty', async () => {
    const { getComments } = await import('../api/client.js');
    const { formatCommentList } = await import('../output/formatters.js');

    vi.mocked(getComments).mockResolvedValue([]);

    await program.parseAsync(['node', 'test', 'comment-list', '1']);

    expect(getComments).toHaveBeenCalledWith(1);
    expect(formatCommentList).toHaveBeenCalledWith([]);
    expect(consoleLogSpy).toHaveBeenCalledWith('No comments');
  });

  it('outputs JSON when --json flag set', async () => {
    const { getComments } = await import('../api/client.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(getComments).mockResolvedValue(mockComments);

    await program.parseAsync(['node', 'test', '--json', 'comment-list', '1']);

    expect(jsonOutput).toHaveBeenCalledWith(mockComments);
    const { formatCommentList } = await import('../output/formatters.js');
    expect(formatCommentList).not.toHaveBeenCalled();
  });

  it('formats timestamps and authors correctly', async () => {
    const { getComments } = await import('../api/client.js');
    const { formatCommentList } = await import('../output/formatters.js');

    vi.mocked(getComments).mockResolvedValue(mockComments);

    await program.parseAsync(['node', 'test', 'comment-list', '1']);

    // Verify the formatter was called with the correct data
    expect(formatCommentList).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ author: 'alice', created_at: '2024-01-15T10:30:00Z' }),
        expect.objectContaining({ author: 'bob', created_at: '2024-01-15T11:45:00Z' }),
      ])
    );
  });

  it('shows error when task not found', async () => {
    const { getComments, ApiClientError } = await import('../api/client.js');

    vi.mocked(getComments).mockRejectedValue(
      new ApiClientError('Task not found', 404, {
        error: 'NOT_FOUND',
        message: 'Task not found',
      })
    );

    await program.parseAsync(['node', 'test', 'comment-list', '99999']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('validates task ID is a number', async () => {
    const { getComments } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'comment-list', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    expect(getComments).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe('comment-delete command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let program: Command;

  beforeEach(async () => {
    vi.clearAllMocks();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = 0;

    const { commentDeleteCommand } = await import('../commands/comment-delete.js');
    program = new Command();
    program.option('--json', 'Output as JSON (machine-readable)');
    program.option('--no-input', 'Disable interactive prompts');
    program.option('--force', 'Skip confirmation prompts');
    program.addCommand(commentDeleteCommand);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('deletes comment when confirmed', async () => {
    const { deleteComment } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(deleteComment).mockResolvedValue(undefined);

    await program.parseAsync(['node', 'test', 'comment-delete', '1', '5']);

    expect(confirmAction).toHaveBeenCalledWith('Delete comment 5?', false);
    expect(deleteComment).toHaveBeenCalledWith(1, 5);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Comment 5 deleted successfully'));
  });

  it('skips deletion when not confirmed', async () => {
    const { deleteComment } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    vi.mocked(confirmAction).mockResolvedValue(false);

    await program.parseAsync(['node', 'test', 'comment-delete', '1', '5']);

    expect(confirmAction).toHaveBeenCalledWith('Delete comment 5?', false);
    expect(deleteComment).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
  });

  it('deletes comment with --force flag', async () => {
    const { deleteComment } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(deleteComment).mockResolvedValue(undefined);

    await program.parseAsync(['node', 'test', '--force', 'comment-delete', '1', '5']);

    expect(deleteComment).toHaveBeenCalledWith(1, 5);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Comment 5 deleted successfully'));
  });

  it('outputs JSON when --json flag set', async () => {
    const { deleteComment } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(deleteComment).mockResolvedValue(undefined);

    await program.parseAsync(['node', 'test', '--json', '--force', 'comment-delete', '1', '5']);

    expect(jsonOutput).toHaveBeenCalledWith({}, { message: 'Comment 5 deleted' });
    expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('deleted successfully'));
  });

  it('shows cancellation in JSON mode', async () => {
    const { deleteComment } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');
    const { jsonOutput } = await import('../output/json-output.js');

    vi.mocked(confirmAction).mockResolvedValue(false);

    await program.parseAsync(['node', 'test', '--json', 'comment-delete', '1', '5']);

    expect(deleteComment).not.toHaveBeenCalled();
    expect(jsonOutput).toHaveBeenCalledWith({}, { message: 'Deletion cancelled' });
  });

  it('validates task ID is a number', async () => {
    const { deleteComment } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'comment-delete', 'invalid', '5']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    expect(deleteComment).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('validates comment ID is a number', async () => {
    const { deleteComment } = await import('../api/client.js');

    await program.parseAsync(['node', 'test', 'comment-delete', '1', 'invalid']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('must be a number'));
    expect(deleteComment).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('shows error when comment not found', async () => {
    const { deleteComment, ApiClientError } = await import('../api/client.js');
    const { confirmAction } = await import('../prompts/interactive.js');

    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(deleteComment).mockRejectedValue(
      new ApiClientError('Comment not found', 404, {
        error: 'NOT_FOUND',
        message: 'Comment not found',
      })
    );

    await program.parseAsync(['node', 'test', 'comment-delete', '1', '99999']);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
