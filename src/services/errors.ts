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
 * BusinessError - thrown when business logic rules are violated
 */
export class BusinessError extends Error {
  public override readonly name = 'BusinessError';

  constructor(message: string) {
    super(message);

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

export function projectArchivedError(projectId: number): BusinessError {
  return new BusinessError(
    `${PROJECT_ARCHIVED_CODE}: project ${projectId} is archived and read-only; unarchive it before making changes`,
  );
}
