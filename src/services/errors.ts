/**
 * Custom error classes for structured error handling
 */

/**
 * ValidationError - thrown when input validation fails
 * Contains structured field errors from Zod validation
 */
export class ValidationError extends Error {
  public override readonly name = 'ValidationError';
  public readonly fieldErrors: Record<string, string[]>;

  constructor(fieldErrors: Record<string, string[]>) {
    super('Validation failed');
    this.fieldErrors = fieldErrors;

    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

/**
 * Build a ValidationError from Zod issues, one entry per field path (the
 * root is the empty string), messages in issue order.
 */
export function validationErrorFromIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): ValidationError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    const field = issue.path.map(String).join('.');
    (fieldErrors[field] ??= []).push(issue.message);
  }
  return new ValidationError(fieldErrors);
}

/**
 * BusinessError - thrown when business logic rules are violated
 */
export class BusinessError extends Error {
  public override readonly name = 'BusinessError';
  /**
   * Optional machine-readable detail sent as `details` on the REST 422 and as
   * `data` on the MCP error (WFT #2530), e.g. per-status task counts.
   */
  public readonly details: Record<string, unknown> | undefined;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;

    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, BusinessError.prototype);
  }
}

/**
 * NotFoundError - thrown when a requested entity does not exist
 */
export class NotFoundError extends Error {
  public override readonly name = 'NotFoundError';
  public readonly entity: string;
  public readonly id: number | string;

  constructor(entity: string, id: number | string) {
    super(`${entity} with id ${id} not found`);
    this.entity = entity;
    this.id = id;

    // Restore prototype chain for instanceof checks
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

/**
 * Archived project state: the error every refused write into an archived
 * project throws (docs/design/project-archived-state.md §2.3). A plain
 * {@link BusinessError} — HTTP 422 on REST, InvalidRequest on MCP — whose
 * message STARTS WITH the stable code `project_archived`, so clients and
 * tests can match on `/^project_archived/` without parsing prose.
 */
export const PROJECT_ARCHIVED_CODE = 'project_archived';

/**
 * True for the `project_archived` refusal and nothing else. Lets a caller
 * that maps BusinessError itself (the claim route's 409) tell the archive
 * freeze apart from its own business conflicts.
 */
export function isProjectArchivedError(error: unknown): error is BusinessError {
  return error instanceof BusinessError && error.message.startsWith(`${PROJECT_ARCHIVED_CODE}:`);
}

export function projectArchivedError(projectId: number): BusinessError {
  return new BusinessError(
    `${PROJECT_ARCHIVED_CODE}: project ${projectId} is archived and read-only; unarchive it before making changes`,
  );
}
