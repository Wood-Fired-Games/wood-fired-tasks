import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withSpinner, shouldShowSpinner } from '../output/spinner.js';

describe('Spinner utility', () => {
  const originalArgv = [...process.argv];
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    process.argv = [...originalArgv];
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
  });

  describe('shouldShowSpinner', () => {
    it('returns false when --json flag is present', () => {
      process.argv = ['node', 'tasks', '--json'];
      expect(shouldShowSpinner()).toBe(false);
    });

    it('returns false when stdout is not a TTY', () => {
      // Remove --json if present
      process.argv = process.argv.filter(a => a !== '--json');
      Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
      expect(shouldShowSpinner()).toBe(false);
    });
  });

  describe('withSpinner', () => {
    it('returns the result of the wrapped function', async () => {
      const result = await withSpinner('Testing...', async () => 42, 500);
      expect(result).toBe(42);
    });

    it('propagates errors from the wrapped function', async () => {
      await expect(
        withSpinner('Testing...', async () => {
          throw new Error('test error');
        }, 500)
      ).rejects.toThrow('test error');
    });

    it('works with async operations', async () => {
      const result = await withSpinner(
        'Testing...',
        () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 10)),
        500
      );
      expect(result).toBe('done');
    });
  });
});
