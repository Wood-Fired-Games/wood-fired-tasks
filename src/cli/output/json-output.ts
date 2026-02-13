/**
 * JSON output utilities for machine-readable CLI output.
 *
 * Separates data (stdout) from messages (stderr) to enable reliable script consumption.
 */

/**
 * Standard JSON envelope format for all CLI JSON output.
 */
export interface JsonEnvelope<T = unknown> {
  success: boolean;
  data: T;
  metadata?: {
    count?: number;
    timestamp?: string;
    [key: string]: unknown;
  };
}

/**
 * Output a JSON envelope to stdout.
 *
 * @param data - The data to include in the envelope
 * @param metadata - Optional metadata (count, timestamp, etc.)
 */
export function jsonOutput<T>(data: T, metadata?: Record<string, unknown>): void {
  const envelope: JsonEnvelope<T> = {
    success: true,
    data,
    metadata,
  };

  // Write JSON to stdout (for machine consumption)
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
}

/**
 * Output an error JSON envelope to stdout.
 *
 * @param message - Error message
 * @param code - Optional error code
 */
export function jsonError(message: string, code?: string): void {
  const envelope = {
    success: false,
    error: {
      message,
      code,
    },
  };

  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
}

/**
 * Output an informational message to stderr (does not pollute stdout data stream).
 *
 * Respects TTY detection - only outputs if stderr is a terminal.
 *
 * @param message - The message to output
 */
export function messageOutput(message: string): void {
  // Only output messages if stderr is a TTY (avoid polluting logs/pipes)
  if (process.stderr.isTTY) {
    process.stderr.write(message + '\n');
  }
}
