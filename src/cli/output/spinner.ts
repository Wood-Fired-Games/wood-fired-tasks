import { spinner } from '@clack/prompts';
import { isJsonMode } from './formatters.js';

/**
 * Determine if the spinner should be shown.
 * Suppressed in JSON mode and when stdout is not a TTY (piped output).
 */
export function shouldShowSpinner(): boolean {
  if (isJsonMode()) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

/**
 * Wrap an async operation with a spinner that appears after a delay.
 *
 * @param message - Description shown while spinning (e.g., "Fetching tasks...")
 * @param fn - The async operation to execute
 * @param delay - Milliseconds to wait before showing spinner (default: 500ms)
 * @returns The result of the async operation
 */
export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
  delay = 500,
): Promise<T> {
  if (!shouldShowSpinner()) {
    return fn();
  }

  const s = spinner();
  let started = false;
  const timer = setTimeout(() => {
    started = true;
    s.start(message);
  }, delay);

  try {
    const result = await fn();
    clearTimeout(timer);
    if (started) {
      s.stop();
    }
    return result;
  } catch (error) {
    clearTimeout(timer);
    if (started) {
      s.stop();
    }
    throw error;
  }
}
