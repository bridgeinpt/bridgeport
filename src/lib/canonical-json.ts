/**
 * Deterministic JSON canonicalization + body hashing.
 *
 * Shared by the sync-batch idempotency path (issue #130) and the MCP write-tool
 * Idempotency-Key derivation (issue #208). Kept in `lib/` (rather than inside a
 * service) so the MCP layer can reuse it without importing the whole sync-batch
 * service (and its prisma/webhook/audit dependency graph) for two pure helpers.
 */

import { createHash } from 'node:crypto';

/**
 * Stable JSON canonicalization: recursively sort object keys, leave arrays in
 * order (array order is semantically meaningful). This is the input to SHA-256
 * for idempotency body hashes. Same logical body → same string regardless of
 * key ordering or whitespace.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => JSON.stringify(k) + ':' + canonicalizeJson(obj[k]));
  return '{' + entries.join(',') + '}';
}

/** SHA-256 hex digest of the canonical serialization of `value`. */
export function hashCanonicalBody(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value)).digest('hex');
}
