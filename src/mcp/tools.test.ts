/**
 * Unit tests for the MCP tool registry (issue #208).
 *
 * Pure logic only — no DB, no SDK protocol. We exercise:
 *   - the stable Idempotency-Key derivation (deterministic, args/tool sensitive,
 *     ignores the optional `idempotencyKey` override arg);
 *   - the `list_vars` output transform (strips plaintext `value`);
 *   - the synthesized `get_capabilities` result shape.
 *
 * Tools that hit the API are invoked with a FAKE Fastify-shaped context whose
 * `app.inject` returns canned responses, so no real Fastify/DB is needed.
 */
import { describe, it, expect } from 'vitest';
import { ALL_TOOLS, deriveIdempotencyKey } from './tools.js';
import type { McpToolContext, McpToolDef } from './types.js';
import type { FastifyInstance } from 'fastify';
import type { AuthUser } from '../services/auth.js';
import { appVersion } from '../lib/version.js';
import { computeScopes } from '../lib/scopes.js';

function tool(name: string): McpToolDef {
  const def = ALL_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`tool ${name} not found in registry`);
  return def;
}

/**
 * Build a tool context whose `app.inject` returns a fixed response. Only the
 * `inject` method is used by inject-backed tool handlers, so a minimal stub
 * suffices (cast through unknown to FastifyInstance).
 */
function fakeCtx(
  injectResult: { statusCode: number; payload: string },
  authUser?: AuthUser,
  registeredToolNames: string[] = []
): McpToolContext {
  const app = {
    inject: async () => injectResult,
  } as unknown as FastifyInstance;
  return {
    app,
    bearer: 'test-bearer',
    authUser:
      authUser ?? { id: 'u1', email: 'a@test', name: null, role: 'admin' },
    registeredToolNames,
  };
}

describe('deriveIdempotencyKey', () => {
  it('is deterministic for identical tool name + args', () => {
    const a = deriveIdempotencyKey('deploy_service', { id: 'svc1', pullImage: true });
    const b = deriveIdempotencyKey('deploy_service', { id: 'svc1', pullImage: true });
    expect(a).toBe(b);
    // sha256 hex digest
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of argument key ORDER (canonical JSON)', () => {
    const a = deriveIdempotencyKey('deploy_service', { id: 'svc1', pullImage: true });
    const b = deriveIdempotencyKey('deploy_service', { pullImage: true, id: 'svc1' });
    expect(a).toBe(b);
  });

  it('differs when the argument VALUES differ', () => {
    const a = deriveIdempotencyKey('deploy_service', { id: 'svc1' });
    const b = deriveIdempotencyKey('deploy_service', { id: 'svc2' });
    expect(a).not.toBe(b);
  });

  it('differs when the TOOL NAME differs (same args)', () => {
    const a = deriveIdempotencyKey('deploy_service', { id: 'x' });
    const b = deriveIdempotencyKey('restart_deployment', { id: 'x' });
    expect(a).not.toBe(b);
  });

  it('EXCLUDES the optional idempotencyKey arg from the hash input', () => {
    // The override arg is not part of the logical operation, so two calls that
    // differ ONLY in idempotencyKey must derive the SAME stable key.
    const withKey = deriveIdempotencyKey('deploy_service', {
      id: 'svc1',
      idempotencyKey: 'caller-supplied-value',
    });
    const without = deriveIdempotencyKey('deploy_service', { id: 'svc1' });
    expect(withKey).toBe(without);
  });

  it('still distinguishes real args even when idempotencyKey is present', () => {
    const a = deriveIdempotencyKey('deploy_service', { id: 'svc1', idempotencyKey: 'k' });
    const b = deriveIdempotencyKey('deploy_service', { id: 'svc2', idempotencyKey: 'k' });
    expect(a).not.toBe(b);
  });
});

describe('list_vars transform', () => {
  it('strips the plaintext `value` field from every var, keeping metadata', async () => {
    const payload = {
      vars: [
        {
          id: 'v1',
          key: 'API_URL',
          value: 'https://secret.internal',
          description: 'base url',
          usedByConfigFiles: [{ id: 'f1', name: 'app.env' }],
          usageCount: 1,
        },
        {
          id: 'v2',
          key: 'TIMEOUT',
          value: '30',
          description: null,
          usedByConfigFiles: [],
          usageCount: 0,
        },
      ],
    };
    const ctx = fakeCtx({ statusCode: 200, payload: JSON.stringify(payload) });
    const res = await tool('list_vars').handler({ envId: 'env1' }, ctx);

    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0].text) as { vars: Array<Record<string, unknown>> };
    expect(out.vars).toHaveLength(2);
    for (const v of out.vars) {
      expect(v).not.toHaveProperty('value');
    }
    // Metadata is preserved (key/description/usage).
    expect(out.vars[0]).toMatchObject({
      key: 'API_URL',
      description: 'base url',
      usageCount: 1,
    });
    expect(out.vars[1]).toMatchObject({ key: 'TIMEOUT', usageCount: 0 });
    // And the raw secret value is nowhere in the serialized output.
    expect(res.content[0].text).not.toContain('https://secret.internal');
  });

  it('passes a non-conforming body through unchanged (defensive)', async () => {
    const ctx = fakeCtx({ statusCode: 200, payload: JSON.stringify({ unexpected: true }) });
    const res = await tool('list_vars').handler({ envId: 'env1' }, ctx);
    const out = JSON.parse(res.content[0].text);
    expect(out).toEqual({ unexpected: true });
  });
});

describe('read tool error mapping', () => {
  it('maps a non-2xx envelope to an MCP error result carrying the code', async () => {
    const ctx = fakeCtx({
      statusCode: 404,
      payload: JSON.stringify({ code: 'NOT_FOUND', message: 'Service not found' }),
    });
    const res = await tool('get_service').handler({ id: 'missing' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('NOT_FOUND');
    expect(res.content[0].text).toContain('Service not found');
  });
});

describe('get_capabilities synthesis', () => {
  it('returns { version, scopes, tools } from the caller context (no inject)', async () => {
    const authUser: AuthUser = { id: 'u1', email: 'admin@test', name: 'Admin', role: 'admin' };
    const names = ['get_capabilities', 'list_services', 'deploy_service'];
    // Pass an inject stub that would THROW if called, proving synthesis is local.
    const app = {
      inject: async () => {
        throw new Error('get_capabilities must not inject');
      },
    } as unknown as FastifyInstance;
    const ctx: McpToolContext = { app, bearer: 'b', authUser, registeredToolNames: names };

    const res = await tool('get_capabilities').handler({}, ctx);
    const out = JSON.parse(res.content[0].text) as {
      version: string;
      scopes: string[];
      tools: string[];
    };
    expect(out.version).toBe(appVersion);
    expect(out.scopes).toEqual(computeScopes(authUser));
    expect(out.tools).toEqual(names);
  });
});

describe('tool registry shape', () => {
  it('has exactly one meta tool, 23 read tools, and 6 write tools', () => {
    const meta = ALL_TOOLS.filter((t) => t.name === 'get_capabilities');
    const writes = ALL_TOOLS.filter((t) => t.isWrite);
    const reads = ALL_TOOLS.filter((t) => !t.isWrite && t.name !== 'get_capabilities');
    expect(meta).toHaveLength(1);
    expect(writes).toHaveLength(6);
    expect(reads).toHaveLength(23);
  });

  it('every write tool is destructive, requires services:write, and is not read-only', () => {
    for (const t of ALL_TOOLS.filter((t) => t.isWrite)) {
      expect(t.requiredScope).toBe('services:write');
      expect(t.destructive).toBe(true);
      expect(t.readOnly).toBe(false);
    }
  });

  it('every read/meta tool has a null requiredScope, is read-only, and not destructive', () => {
    for (const t of ALL_TOOLS.filter((t) => !t.isWrite)) {
      expect(t.requiredScope).toBeNull();
      expect(t.readOnly).toBe(true);
      expect(t.destructive).toBe(false);
    }
  });

  it('exposes no tool that reveals decrypted secret values', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(names).not.toContain('get_secret_value');
    expect(names).not.toContain('reveal_secret');
    expect(names.some((n) => /reveal|secret.*value|value.*secret/i.test(n))).toBe(false);
  });
});
