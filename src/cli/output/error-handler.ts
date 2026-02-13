import chalk from 'chalk';
import { ApiClientError } from '../api/client.js';

/**
 * Display user-friendly CLI error messages.
 * Sets process.exitCode to 1 (allows graceful cleanup, doesn't force immediate exit).
 */
export function handleError(error: unknown): void {
  if (error instanceof ApiClientError) {
    console.error(chalk.red(`Error (${error.statusCode}): ${error.message}`));

    // Provide context-specific hints
    if (error.statusCode === 401) {
      console.error(chalk.yellow('Check your API_KEY in .env'));
    } else if (error.statusCode === 404) {
      console.error(chalk.yellow('Resource not found'));
    }
  } else if (error instanceof Error) {
    // Handle timeout errors from AbortController
    if (error.name === 'AbortError') {
      console.error(chalk.red('Request timed out. Is the API server running?'));
    } else {
      console.error(chalk.red(`Error: ${error.message}`));
    }
  } else {
    console.error(chalk.red('An unexpected error occurred'));
  }

  // Set exit code but allow graceful cleanup
  process.exitCode = 1;
}
