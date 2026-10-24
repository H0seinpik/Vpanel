import { ZodError } from 'zod';

/**
 * Typed application errors. The API layer maps these to HTTP responses and
 * never leaks stack traces or internal details to clients.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number = 500,
    readonly code: string = 'internal_error',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(message, 422, 'validation_error', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'unauthorized');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'forbidden');
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'not_found');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409, 'conflict');
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', readonly retryAfterSeconds = 60) {
    super(message, 429, 'rate_limited');
  }
}

export class ProviderError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 502, 'provider_error', details);
  }
}

/**
 * Structural check for a ZodError.
 *
 * `instanceof` alone is not enough: if two copies of zod ever end up in the
 * module graph (ESM + CJS interop, duplicated dependency trees), the class
 * identity differs and a genuine validation error would be misreported as a
 * 500. Checking the shape as well makes the mapping reliable either way.
 */
function isZodErrorLike(error: unknown): error is ZodError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'ZodError' &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

/** Normalise any thrown value into an AppError without leaking internals. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError || isZodErrorLike(error)) {
    return new ValidationError(
      'Validation failed',
      error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }

  // Prisma unique-constraint violation (P2002)
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: string }).code;
    if (code === 'P2002') return new ConflictError('A record with those unique values already exists');
    if (code === 'P2025') return new NotFoundError();
    if (code === 'P2003') return new ValidationError('Referenced record does not exist');
  }

  return new AppError('An unexpected error occurred', 500, 'internal_error');
}
