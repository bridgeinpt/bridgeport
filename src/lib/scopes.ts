/**
 * Compute the scope strings advertised by `GET /api/auth/me`.
 *
 * Scopes are *derived* — they're not stored in the database. They reflect
 * the principal's effective role plus, for API tokens, any environment
 * scoping. Clients can use them to gate UI affordances without hard-coding
 * the BRIDGEPORT role hierarchy.
 *
 * Scope strings follow `<resource>:<action>`:
 *   services:read | services:write
 *   secrets:read  | secrets:write
 *   secrets:reveal    (decrypt secret values — admin only)
 *   servers:read  | servers:write
 *   environments:read | environments:write
 *   tokens:manage
 *   admin:*           (wildcard granted to admins)
 *
 * NOTE: `secrets:read` (granted to every role) covers listing secret keys and
 * metadata. Revealing the decrypted *value* is a separate, stronger capability
 * advertised as `secrets:reveal` and granted to admins only — matching the
 * `requireAdmin` guard on `GET /api/secrets/:id/value`.
 *
 * NOTE: This is intentionally a *view* of permissions, not the source of
 * truth. The real enforcement still lives in the authenticate/authorize
 * plugins (role + token scope checks). Treat scopes here as advisory
 * metadata for clients.
 */

import type { AuthUser, UserRole } from '../services/auth.js';

const RESOURCES = ['services', 'secrets', 'servers', 'environments'] as const;

function scopesForRole(role: UserRole): string[] {
  const out: string[] = [];

  // Everyone authenticated gets read access to operational resources.
  if (role === 'admin' || role === 'operator' || role === 'viewer') {
    for (const r of RESOURCES) out.push(`${r}:read`);
  }

  // Operators and admins can write to operational resources.
  if (role === 'admin' || role === 'operator') {
    for (const r of RESOURCES) out.push(`${r}:write`);
  }

  // Admin-only.
  if (role === 'admin') {
    // Revealing decrypted secret values is admin-only (enforced by requireAdmin
    // on GET /api/secrets/:id/value). `secrets:read` above only covers listing.
    out.push('secrets:reveal');
    out.push('tokens:manage');
    out.push('admin:*');
  }

  return out;
}

/**
 * Derive the scope strings for an authenticated principal.
 *
 * For JWT sessions (`authUser.scope === undefined`) the full set for the
 * user's role is returned.
 *
 * For API tokens with `scope.allEnvironments === false` the per-resource
 * scopes are still based on the (effective) role, since BRIDGEPORT's
 * token scoping is per-environment, not per-resource. Callers that need
 * to know the environment allowlist should read `scope.environmentIds`
 * separately.
 */
export function computeScopes(authUser: AuthUser): string[] {
  return scopesForRole(authUser.role);
}
