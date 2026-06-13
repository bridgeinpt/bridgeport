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

// Read tools backed by a GLOBAL route (no `:envId`): always FORBIDDEN_SCOPE for
// an env-scoped token, so they must be hidden when isEnvScoped=true.
const GLOBAL_READ_TOOL_NAMES = [
  'get_server',
  'get_service',
  'get_service_logs',
  'get_config_file',
  'get_server_metrics',
  'get_service_metrics',
  'get_deployments',
  'get_deployment_plan',
  'get_drift',
  'query_audit_log',
];

// Read tools (plus meta) backed by an env route / scope-exempt / no-scope route:
// usable by an env-scoped token, so they stay listed when isEnvScoped=true.
const ENV_SCOPED_TOOL_NAMES = [
  'list_environments',
  'get_environment',
  'list_servers',
  'get_server_health',
  'list_services',
  'list_config_files',
  'list_config_fragments',
  'list_secrets',
  'list_vars',
  'get_metrics_history',
  'list_health_checks',
  'list_deployment_plans',
  'get_version',
  'get_capabilities', // meta (synthesized locally, no route)
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

  describe('env-scoped tokens (isEnvScoped=true) hide every global-route tool', () => {
    it('an env-scoped OPERATOR (has services:write) sees ONLY env-scoped tools — no write tools AND no global read tools', () => {
      const operatorScopes = computeScopes(user('operator'));
      // Premise: an operator's role-derived scopes DO include services:write...
      expect(operatorScopes).toContain('services:write');

      // ...but with isEnvScoped=true every global-route tool is withheld (its
      // route always FORBIDDEN_SCOPE for an env-scoped token).
      const selected = selectToolsForScopes(operatorScopes, true).map((t) => t.name);

      // Write tools (all global) are gone.
      for (const w of WRITE_TOOL_NAMES) {
        expect(selected).not.toContain(w);
      }
      // Global READ tools are ALSO gone (previously listed but always FORBIDDEN_SCOPE).
      for (const g of GLOBAL_READ_TOOL_NAMES) {
        expect(selected).not.toContain(g);
      }
      // The env-scoped reads + meta remain.
      for (const e of ENV_SCOPED_TOOL_NAMES) {
        expect(selected).toContain(e);
      }
      // The truthful list is EXACTLY the env-scoped set (nothing more, nothing less).
      expect([...selected].sort()).toEqual([...ENV_SCOPED_TOOL_NAMES].sort());
    });

    it('an env-scoped VIEWER sees the same env-scoped set (viewers never had write tools anyway)', () => {
      const viewerScopes = computeScopes(user('viewer'));
      const selected = selectToolsForScopes(viewerScopes, true).map((t) => t.name);
      expect([...selected].sort()).toEqual([...ENV_SCOPED_TOOL_NAMES].sort());
    });

    it('an all-environments operator (isEnvScoped=false) sees the FULL scope-appropriate set — write tools AND global read tools', () => {
      const selected = selectToolsForScopes(computeScopes(user('operator')), false).map(
        (t) => t.name
      );
      // Full surface: writes, global reads, and env reads are all present.
      for (const w of WRITE_TOOL_NAMES) {
        expect(selected).toContain(w);
      }
      for (const g of GLOBAL_READ_TOOL_NAMES) {
        expect(selected).toContain(g);
      }
      for (const e of ENV_SCOPED_TOOL_NAMES) {
        expect(selected).toContain(e);
      }
    });

    it('defaults to NOT env-scoped (omitting the flag keeps the full set)', () => {
      // JWT sessions pass no scope → not env-scoped → full surface.
      const selected = names(computeScopes(user('admin')));
      expect(selected).toEqual(expect.arrayContaining(WRITE_TOOL_NAMES));
      expect(selected).toEqual(expect.arrayContaining(GLOBAL_READ_TOOL_NAMES));
    });
  });
});
