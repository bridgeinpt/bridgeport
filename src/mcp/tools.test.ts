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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ALL_TOOLS, deriveIdempotencyKey, IDEMPOTENCY_DEDUP_WINDOW_MS } from './tools.js';
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
    callerIp: '203.0.113.7',
    authUser:
      authUser ?? { id: 'u1', email: 'a@test', name: null, role: 'admin' },
    registeredToolNames,
  };
}

describe('deriveIdempotencyKey', () => {
  // The derived key folds in a wall-clock time bucket, so freeze time to make
  // "same window" vs "later window" deterministic (and avoid bucket-boundary
  // flakiness in the same-window assertions).
  afterEach(() => {
    vi.useRealTimers();
  });

  // Anchor at a window BOUNDARY (a multiple of the window size) so that adding
  // `WINDOW_MS - 1` stays inside the same bucket and adding `WINDOW_MS` crosses
  // exactly one bucket — otherwise the assertions are sensitive to where in the
  // bucket the base timestamp happens to fall.
  const WINDOW_START = 16_666_666 * IDEMPOTENCY_DEDUP_WINDOW_MS;

  it('is deterministic within the same time window for identical tool name + args', () => {
    vi.useFakeTimers();
    vi.setSystemTime(WINDOW_START);
    const a = deriveIdempotencyKey('deploy_service', { id: 'svc1', pullImage: true });
    // Advance to the LAST ms of the SAME bucket — still dedupes.
    vi.setSystemTime(WINDOW_START + IDEMPOTENCY_DEDUP_WINDOW_MS - 1);
    const b = deriveIdempotencyKey('deploy_service', { id: 'svc1', pullImage: true });
    expect(a).toBe(b);
    // sha256 hex digest
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of argument key ORDER (canonical JSON)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(WINDOW_START);
    const a = deriveIdempotencyKey('deploy_service', { id: 'svc1', pullImage: true });
    const b = deriveIdempotencyKey('deploy_service', { pullImage: true, id: 'svc1' });
    expect(a).toBe(b);
  });

  it('differs in a LATER window so an intended repeat executes (not a stale replay)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(WINDOW_START);
    const a = deriveIdempotencyKey('run_database_backup', { id: 'db1' });
    // Jump a full window forward → the next bucket → a different key, so the
    // same operation later is NOT deduped against the earlier one.
    vi.setSystemTime(WINDOW_START + IDEMPOTENCY_DEDUP_WINDOW_MS);
    const b = deriveIdempotencyKey('run_database_backup', { id: 'db1' });
    expect(a).not.toBe(b);
  });

  it('differs when the argument VALUES differ (same window)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(WINDOW_START);
    const a = deriveIdempotencyKey('deploy_service', { id: 'svc1' });
    const b = deriveIdempotencyKey('deploy_service', { id: 'svc2' });
    expect(a).not.toBe(b);
  });

  it('differs when the TOOL NAME differs (same args, same window)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(WINDOW_START);
    const a = deriveIdempotencyKey('deploy_service', { id: 'x' });
    const b = deriveIdempotencyKey('restart_deployment', { id: 'x' });
    expect(a).not.toBe(b);
  });

  it('EXCLUDES the optional idempotencyKey arg from the hash input', () => {
    vi.useFakeTimers();
    vi.setSystemTime(WINDOW_START);
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
    vi.useFakeTimers();
    vi.setSystemTime(WINDOW_START);
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

describe('error mapping (mapResult)', () => {
  it('maps a non-2xx envelope to an MCP error result carrying code + message + status', async () => {
    const ctx = fakeCtx({
      statusCode: 404,
      payload: JSON.stringify({ code: 'NOT_FOUND', message: 'Service not found' }),
    });
    const res = await tool('get_service').handler({ id: 'missing' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('NOT_FOUND');
    expect(res.content[0].text).toContain('Service not found');
    // The HTTP status is now surfaced losslessly.
    expect(res.content[0].text).toContain('status: 404');
  });

  it('surfaces field and hint from the envelope (so an agent can self-correct)', async () => {
    const ctx = fakeCtx({
      statusCode: 422,
      payload: JSON.stringify({
        code: 'VALIDATION_ERROR',
        message: 'Invalid strategy',
        field: 'strategy',
        hint: 'Use "sequential" or "parallel".',
      }),
    });
    const res = await tool('get_service').handler({ id: 'x' }, ctx);
    expect(res.isError).toBe(true);
    const text = res.content[0].text;
    expect(text).toContain('VALIDATION_ERROR');
    expect(text).toContain('field: strategy');
    expect(text).toContain('hint: Use "sequential" or "parallel".');
    expect(text).toContain('status: 422');
  });

  it('falls back to status (and legacy { error } body) for a non-envelope error', async () => {
    const ctx = fakeCtx({
      statusCode: 404,
      payload: JSON.stringify({ error: 'Config file not found' }),
    });
    const res = await tool('get_config_file').handler({ id: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Config file not found');
    expect(res.content[0].text).toContain('status: 404');
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
    const ctx: McpToolContext = { app, bearer: 'b', callerIp: '198.51.100.4', authUser, registeredToolNames: names };

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

  it('deploy_service.strategy is constrained to the route enum (sequential|parallel)', () => {
    // Mirrors the route's deploySchema (z.enum(['sequential','parallel'])) so the
    // tool schema guides the model instead of letting an arbitrary string 400.
    const strategy = tool('deploy_service').inputSchema.strategy;
    expect(strategy.safeParse('sequential').success).toBe(true);
    expect(strategy.safeParse('parallel').success).toBe(true);
    expect(strategy.safeParse(undefined).success).toBe(true); // optional
    expect(strategy.safeParse('rolling').success).toBe(false); // not in the enum
    expect(strategy.safeParse('').success).toBe(false);
  });
});
