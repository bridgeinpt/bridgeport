/**
 * Shared helper utilities for frontend components.
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
