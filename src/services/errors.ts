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
