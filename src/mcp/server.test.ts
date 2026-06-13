/**
 * Unit tests for tool selection by scope (issue #208).
 *
 * `selectToolsForScopes` is the pure core of `buildMcpServer`'s gating: meta +
 * read tools (requiredScope null) are always present; write tools appear only
 * when the caller holds `services:write`. No SDK/transport/DB involved.
 */
import { describe, it, expect } from 'vitest';
import { selectToolsForScopes } from './server.js';
import { computeScopes } from '../lib/scopes.js';
import type { AuthUser } from '../services/auth.js';

const WRITE_TOOL_NAMES = [
  'deploy_service',
  'execute_deployment_plan',
  'restart_deployment',
  'rollback_deployment_plan',
  'run_database_backup',
  'sync_config_file',
];

function names(scopes: string[]): string[] {
  return selectToolsForScopes(scopes).map((t) => t.name);
}

function user(role: AuthUser['role']): AuthUser {
  return { id: `u-${role}`, email: `${role}@test`, name: null, role };
}

describe('selectToolsForScopes', () => {
  it('always includes the meta tool, regardless of scopes', () => {
    expect(names([])).toContain('get_capabilities');
    expect(names(['services:read'])).toContain('get_capabilities');
    expect(names(['services:write'])).toContain('get_capabilities');
  });

  it('admin scopes => all write tools present', () => {
    const adminScopes = computeScopes(user('admin'));
    const selected = names(adminScopes);
    for (const w of WRITE_TOOL_NAMES) {
      expect(selected).toContain(w);
    }
    // Sanity: a representative read tool is present too.
    expect(selected).toContain('list_services');
  });

  it('operator scopes => write tools present (operators can write)', () => {
    const selected = names(computeScopes(user('operator')));
    for (const w of WRITE_TOOL_NAMES) {
      expect(selected).toContain(w);
    }
  });

  it('viewer scopes (only *:read) => NO write tools, but read tools present', () => {
    const viewerScopes = computeScopes(user('viewer'));
    // Guard the premise: a viewer holds only read scopes, never services:write.
    expect(viewerScopes).not.toContain('services:write');

    const selected = names(viewerScopes);
    for (const w of WRITE_TOOL_NAMES) {
      expect(selected).not.toContain(w);
    }
    // Read + meta tools remain available to a viewer.
    expect(selected).toContain('list_services');
    expect(selected).toContain('list_secrets');
    expect(selected).toContain('get_capabilities');
  });

  it('write tools are gated specifically on services:write', () => {
    // Holding an unrelated write scope must NOT unlock the write tools.
    const selected = names(['services:read', 'secrets:reveal', 'tokens:manage']);
    for (const w of WRITE_TOOL_NAMES) {
      expect(selected).not.toContain(w);
    }
    // Granting services:write alone unlocks them.
    expect(names(['services:write'])).toEqual(
      expect.arrayContaining(WRITE_TOOL_NAMES)
    );
  });
});
