/**
 * CLI API error types.
 *
 * `NotAuthenticatedError` surfaces when the CLI cannot resolve any credentials
 * via the precedence chain (--token flag → credentials file → API_KEY env).
 * The top-level CLI error handler converts this error into the friendly
 * "Not authenticated. Run: tasks login" message + exit code 1.
 *
 * The `.code` field is a string literal so downstream callers can discriminate
 * via a narrow `error.code === 'NOT_AUTHENTICATED'` check without having to
 * import the class itself.
 */
export class NotAuthenticatedError extends Error {
  public readonly code = 'NOT_AUTHENTICATED' as const;

  constructor(message = 'Not authenticated. Run: tasks login') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}
