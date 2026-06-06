import { text, confirm } from '@clack/prompts';

/**
 * Determines if interactive prompts should be shown
 * @returns false if --no-input flag set OR !process.stdin.isTTY, true otherwise
 */
export function shouldPrompt(): boolean {
  // Check for --no-input flag in process.argv
  const hasNoInput = process.argv.includes('--no-input');

  // Check if running in a TTY (interactive terminal)
  const isTTY = process.stdin.isTTY === true;

  return !hasNoInput && isTTY;
}

/**
 * Prompts user for a missing field value, or throws error if prompts disabled
 * @param field - Name of the field being requested
 * @param value - Current value (if already provided)
 * @param options - Optional default value and validation function
 * @returns The provided value or prompted value
 * @throws Error if value is missing and prompts are disabled
 */
export async function promptForMissing<T>(
  field: string,
  value: T | undefined,
  options?: { defaultValue?: T; validate?: (v: string) => boolean },
): Promise<T> {
  // If value already provided, return it
  if (value !== undefined) {
    return value;
  }

  // If prompts disabled, throw error
  if (!shouldPrompt()) {
    throw new Error(`Missing required field: ${field}. Use --${field} or remove --no-input`);
  }

  // Prompt user for value
  const result = await text({
    message: `Enter ${field}:`,
    ...(options?.defaultValue !== undefined && {
      defaultValue: String(options.defaultValue),
    }),
    ...(options?.validate && {
      validate: (v: string | undefined) => {
        // v can be string | undefined from @clack/prompts
        if (!v || !options.validate!(v)) {
          return `Invalid value for ${field}`;
        }
        return undefined;
      },
    }),
  });

  // Handle cancellation (Ctrl+C)
  if (typeof result === 'symbol') {
    throw new Error('Operation cancelled by user');
  }

  return result as T;
}

/**
 * Shows a confirmation prompt for destructive actions
 * @param message - Confirmation message to display
 * @param defaultValue - Default choice (default: false)
 * @returns true if user confirms or --force flag set, false otherwise
 * @throws Error if confirmation required but not in TTY
 */
export async function confirmAction(message: string, defaultValue = false): Promise<boolean> {
  // Check for --force flag - skip confirmation if set
  const hasForce = process.argv.includes('--force');
  if (hasForce) {
    return true;
  }

  // If not in TTY, throw error (can't prompt)
  if (!process.stdin.isTTY) {
    throw new Error('Confirmation required. Use --force or run in interactive terminal');
  }

  // Show confirmation prompt
  const result = await confirm({
    message,
    initialValue: defaultValue,
  });

  // Handle cancellation (Ctrl+C)
  if (typeof result === 'symbol') {
    throw new Error('Operation cancelled by user');
  }

  return result;
}
