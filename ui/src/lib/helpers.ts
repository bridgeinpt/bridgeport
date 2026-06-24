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

/**
 * Extract a human-readable message from an unknown error value.
 */
export function getErrorMessage(error: unknown, defaultMessage = 'Unknown error'): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return defaultMessage;
}

const BYTES_PER_GB = 1024 ** 3;

/**
 * Format a byte count as a human-readable size (binary units, e.g. "1.5 MB").
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < BYTES_PER_GB) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
}

/** Convert a byte count to whole/fractional GB (binary). null passes through. */
export function bytesToGb(bytes: number | null | undefined): number | null {
  if (bytes == null) return null;
  // Trim floating noise so a round value (e.g. 5 GB) edits as "5", not "4.999…".
  return Math.round((bytes / BYTES_PER_GB) * 1000) / 1000;
}

/** Convert GB (binary) to whole bytes. null/empty passes through as null (cap off). */
export function gbToBytes(gb: number | null | undefined): number | null {
  if (gb == null || Number.isNaN(gb)) return null;
  return Math.round(gb * BYTES_PER_GB);
}
