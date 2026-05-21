/**
 * Tests for src/cli/prompts/interactive.ts (task #249).
 *
 * Mocks @clack/prompts so the test suite never blocks on stdin; we drive
 * each branch (already-have-value, no-input flag, non-TTY, force flag,
 * cancellation symbol, default value, validation function).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockText = vi.fn();
const mockConfirm = vi.fn();

vi.mock('@clack/prompts', () => ({
  text: (...args: unknown[]) => mockText(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_IS_TTY = process.stdin.isTTY;

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    configurable: true,
  });
}

describe('shouldPrompt', () => {
  beforeEach(() => {
    process.argv = ['node', 'tasks'];
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    Object.defineProperty(process.stdin, 'isTTY', {
      value: ORIGINAL_IS_TTY,
      configurable: true,
    });
  });

  it('returns true when TTY and no --no-input', async () => {
    setTTY(true);
    const { shouldPrompt } = await import('../prompts/interactive.js');
    expect(shouldPrompt()).toBe(true);
  });

  it('returns false when --no-input flag is set', async () => {
    setTTY(true);
    process.argv = ['node', 'tasks', '--no-input', 'create'];
    const { shouldPrompt } = await import('../prompts/interactive.js');
    expect(shouldPrompt()).toBe(false);
  });

  it('returns false when stdin is not a TTY', async () => {
    setTTY(false);
    const { shouldPrompt } = await import('../prompts/interactive.js');
    expect(shouldPrompt()).toBe(false);
  });
});

describe('promptForMissing', () => {
  beforeEach(() => {
    mockText.mockReset();
    mockConfirm.mockReset();
    process.argv = ['node', 'tasks'];
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    Object.defineProperty(process.stdin, 'isTTY', {
      value: ORIGINAL_IS_TTY,
      configurable: true,
    });
  });

  it('returns the supplied value without prompting', async () => {
    const { promptForMissing } = await import('../prompts/interactive.js');
    const result = await promptForMissing('title', 'Already provided');
    expect(result).toBe('Already provided');
    expect(mockText).not.toHaveBeenCalled();
  });

  it('throws when value is missing and prompts are disabled', async () => {
    setTTY(true);
    process.argv = ['node', 'tasks', '--no-input', 'create'];
    const { promptForMissing } = await import('../prompts/interactive.js');
    await expect(promptForMissing('title', undefined)).rejects.toThrow(
      /Missing required field: title/
    );
  });

  it('throws when value is missing and stdin is not TTY', async () => {
    setTTY(false);
    const { promptForMissing } = await import('../prompts/interactive.js');
    await expect(promptForMissing('description', undefined)).rejects.toThrow(
      /Missing required field: description/
    );
  });

  it('calls @clack/prompts text when prompting is allowed', async () => {
    setTTY(true);
    mockText.mockResolvedValue('user input');
    const { promptForMissing } = await import('../prompts/interactive.js');
    const result = await promptForMissing('title', undefined);
    expect(result).toBe('user input');
    expect(mockText).toHaveBeenCalledOnce();
  });

  it('forwards defaultValue to clack', async () => {
    setTTY(true);
    mockText.mockResolvedValue('result');
    const { promptForMissing } = await import('../prompts/interactive.js');
    await promptForMissing('priority', undefined, { defaultValue: 'medium' });
    const firstArg = mockText.mock.calls[0][0] as { defaultValue?: string };
    expect(firstArg.defaultValue).toBe('medium');
  });

  it('forwards a validator that flags invalid values', async () => {
    setTTY(true);
    mockText.mockImplementation(async (opts: {
      validate?: (v: string) => string | undefined;
    }) => {
      // Simulate clack invoking the validator with a bad string then a good one.
      const badResult = opts.validate?.('');
      expect(badResult).toMatch(/Invalid value for/);
      const okResult = opts.validate?.('42');
      expect(okResult).toBeUndefined();
      return '42';
    });
    const { promptForMissing } = await import('../prompts/interactive.js');
    const v = await promptForMissing<string>('count', undefined, {
      validate: (s) => /^\d+$/.test(s),
    });
    expect(v).toBe('42');
  });

  it('throws when user cancels (clack returns a symbol)', async () => {
    setTTY(true);
    mockText.mockResolvedValue(Symbol('clack.cancel'));
    const { promptForMissing } = await import('../prompts/interactive.js');
    await expect(promptForMissing('x', undefined)).rejects.toThrow(
      /Operation cancelled by user/
    );
  });
});

describe('confirmAction', () => {
  beforeEach(() => {
    mockConfirm.mockReset();
    process.argv = ['node', 'tasks'];
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    Object.defineProperty(process.stdin, 'isTTY', {
      value: ORIGINAL_IS_TTY,
      configurable: true,
    });
  });

  it('skips confirmation and returns true when --force is set', async () => {
    process.argv = ['node', 'tasks', '--force', 'delete'];
    const { confirmAction } = await import('../prompts/interactive.js');
    const result = await confirmAction('Sure?');
    expect(result).toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('throws when no TTY and no --force', async () => {
    setTTY(false);
    const { confirmAction } = await import('../prompts/interactive.js');
    await expect(confirmAction('Sure?')).rejects.toThrow(
      /Confirmation required/
    );
  });

  it('prompts the user and returns the result when interactive', async () => {
    setTTY(true);
    mockConfirm.mockResolvedValue(true);
    const { confirmAction } = await import('../prompts/interactive.js');
    const result = await confirmAction('Continue?');
    expect(result).toBe(true);
    expect(mockConfirm).toHaveBeenCalledOnce();
  });

  it('throws when user cancels (symbol)', async () => {
    setTTY(true);
    mockConfirm.mockResolvedValue(Symbol('clack.cancel'));
    const { confirmAction } = await import('../prompts/interactive.js');
    await expect(confirmAction('?')).rejects.toThrow(
      /Operation cancelled by user/
    );
  });

  it('forwards default value to clack', async () => {
    setTTY(true);
    mockConfirm.mockImplementation(async (opts: { initialValue: boolean }) => {
      expect(opts.initialValue).toBe(true);
      return true;
    });
    const { confirmAction } = await import('../prompts/interactive.js');
    await confirmAction('?', true);
  });
});
