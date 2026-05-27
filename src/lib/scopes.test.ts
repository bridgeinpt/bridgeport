import { describe, it, expect } from 'vitest';
import { computeScopes } from './scopes.js';
import type { AuthUser } from '../services/auth.js';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'u1',
    email: 'u1@test.com',
    name: 'User One',
    role: 'viewer',
    ...overrides,
  };
}

describe('computeScopes', () => {
  it('admin role gets the wildcard plus read+write on all resources and tokens:manage', () => {
    const scopes = computeScopes(makeUser({ role: 'admin' }));

    expect(scopes).toContain('admin:*');
    expect(scopes).toContain('tokens:manage');

    // Read on every resource.
    for (const r of ['services', 'secrets', 'servers', 'environments']) {
      expect(scopes).toContain(`${r}:read`);
      expect(scopes).toContain(`${r}:write`);
    }
  });

  it('operator role gets read+write on operational resources but NOT admin:* or tokens:manage', () => {
    const scopes = computeScopes(makeUser({ role: 'operator' }));

    expect(scopes).not.toContain('admin:*');
    expect(scopes).not.toContain('tokens:manage');

    for (const r of ['services', 'secrets', 'servers', 'environments']) {
      expect(scopes).toContain(`${r}:read`);
      expect(scopes).toContain(`${r}:write`);
    }
  });

  it('viewer role gets ONLY read scopes — no writes, no admin', () => {
    const scopes = computeScopes(makeUser({ role: 'viewer' }));

    expect(scopes).not.toContain('admin:*');
    expect(scopes).not.toContain('tokens:manage');

    // All reads present.
    for (const r of ['services', 'secrets', 'servers', 'environments']) {
      expect(scopes).toContain(`${r}:read`);
    }

    // No writes at all.
    expect(scopes.some((s) => s.endsWith(':write'))).toBe(false);
  });

  it('viewer scopes never contain a colon-write suffix', () => {
    const scopes = computeScopes(makeUser({ role: 'viewer' }));
    for (const s of scopes) {
      expect(s.endsWith(':write')).toBe(false);
    }
  });

  it('admin returns a stable, predictable set (no duplicates)', () => {
    const scopes = computeScopes(makeUser({ role: 'admin' }));
    const unique = new Set(scopes);
    expect(unique.size).toBe(scopes.length);
  });

  it('JWT session (no token scope) for admin still returns full admin scopes', () => {
    // JWT sessions have `scope === undefined` — they get the role's full set.
    const scopes = computeScopes(makeUser({ role: 'admin' }));
    expect(scopes).toContain('admin:*');
  });

  it('API token scoped to specific environments still derives scopes from role', () => {
    // Token scoping in BRIDGEPORT is per-environment, not per-resource. The
    // resource-level scope strings still come from the effective role; callers
    // who care about the env allowlist read `authUser.scope.environmentIds`.
    const restricted = makeUser({
      role: 'operator',
      apiTokenId: 'tok_1',
      scope: { allEnvironments: false, environmentIds: ['env_a'] },
    });
    const scopes = computeScopes(restricted);

    expect(scopes).toContain('services:read');
    expect(scopes).toContain('services:write');
    expect(scopes).not.toContain('admin:*');
  });

  it('API token with allEnvironments=true matches the same shape as a JWT session of equal role', () => {
    const tokenUser = makeUser({
      role: 'admin',
      apiTokenId: 'tok_2',
      scope: { allEnvironments: true, environmentIds: [] },
    });
    const jwtUser = makeUser({ role: 'admin' });

    expect(computeScopes(tokenUser).sort()).toEqual(computeScopes(jwtUser).sort());
  });

  it('viewer-role API token returns only read scopes (intersection with viewer ability)', () => {
    const viewerTok = makeUser({
      role: 'viewer',
      apiTokenId: 'tok_3',
      scope: { allEnvironments: false, environmentIds: ['env_a', 'env_b'] },
    });
    const scopes = computeScopes(viewerTok);

    // Reads yes.
    expect(scopes).toContain('services:read');
    expect(scopes).toContain('secrets:read');
    // No writes, no admin.
    expect(scopes.some((s) => s.endsWith(':write'))).toBe(false);
    expect(scopes).not.toContain('admin:*');
    expect(scopes).not.toContain('tokens:manage');
  });
});
