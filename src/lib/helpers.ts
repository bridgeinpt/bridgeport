/**
 * Shared helper utilities for routes and services.
 */

/**
 * Safely parse a JSON string with a fallback default value.
 * Unlike raw JSON.parse, this never throws and always returns the expected type.
 */
export function safeJsonParse<T>(json: string | null | undefined, defaultValue: T): T {
  if (!json) return defaultValue;
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Extract a human-readable error message from an unknown error value.
 */
export function getErrorMessage(error: unknown, defaultMessage: string = 'Unknown error'): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return defaultMessage;
}

/**
 * Parse pagination query parameters with defaults.
 */
export function parsePaginationQuery(
  query: Record<string, unknown>,
  defaults: { limit: number; offset: number } = { limit: 25, offset: 0 }
): { limit: number; offset: number } {
  const limitStr = query.limit;
  const offsetStr = query.offset;
  return {
    limit: typeof limitStr === 'string' && limitStr ? parseInt(limitStr, 10) : defaults.limit,
    offset: typeof offsetStr === 'string' && offsetStr ? parseInt(offsetStr, 10) : defaults.offset,
  };
}
