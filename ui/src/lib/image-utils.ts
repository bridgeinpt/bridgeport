/**
 * Shared image/digest display helpers for the UI.
 */

/**
 * Format a digest for short display.
 * If the digest contains `sha256:`, extract the first 12 chars after the prefix.
 * Otherwise return the first 12 chars. Mirrors the backend helper of the same
 * name (src/lib/image-utils.ts) so SHA truncation stays consistent end-to-end.
 */
export function formatDigestShort(digest: string): string {
  const stripped = digest.startsWith('sha256:') ? digest.slice(7) : digest;
  return stripped.slice(0, 12);
}
