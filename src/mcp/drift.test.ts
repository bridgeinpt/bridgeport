/**
 * envScoped drift guard (FIX 7).
 *
 * The other tests assert `envScoped` against itself; this one derives the flag
 * INDEPENDENTLY from the actual route each tool/resource reaches and asserts the
 * declared flag agrees. The rule:
 *
 *   envScoped === true  iff  the backing path starts with `/api/environments/`
 *                            (an env-prefixed route an env-scoped token can reach)
 *                            OR the entry is an explicit documented exception.
 *
 * We discover each entry's path by driving it with a capturing fake `app.inject`
 * (tools: invoke the handler; resources: invoke the read callback with placeholder
 * URI variables). No-inject/local entries (get_capabilities, the capabilities
 * resource, get_version→/health) never call inject and are listed as exceptions.
 *
 * This catches hand-tag drift: if a new tool's `envScoped` no longer matches its
 * route, this fails — independent of the value the author typed.
 */
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ALL_TOOLS } from './tools.js';
import { ALL_RESOURCES, configFileUri, configFragmentUri } from './resources.js';
import type { McpToolContext, McpResourceContext } from './types.js';
import type { ReadResourceTemplateCallback } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Explicit, documented exceptions whose `envScoped` is NOT derived from an
 * `/api/environments/` path prefix:
 *   - get_version → GET /health (no-scope route, always reachable) → true
 *   - get_capabilities → synthesized locally, no inject → true
 *   - capabilities (resource) → synthesized locally, no inject → true
 *   - list_environments → GET /api/environments (no trailing slash; the
 *     scope-EXEMPT env list that returns the token's own allowlist, so reachable
 *     by an env-scoped token) → true. The path lacks the `/api/environments/`
 *     prefix the deriver keys on, so it's an explicit exception.
 *   - get_environment_settings → /api/environments/:id/settings/:module IS
 *     env-prefixed, so it derives true the normal way (NOT listed here).
 */
const ENV_SCOPED_EXCEPTIONS = new Set([
  'get_version',
  'get_capabilities',
  'capabilities',
  'list_environments',
]);

/** A fake Fastify whose `inject` records the URL it was asked to hit. */
function capturingApp(captured: { url?: string }): FastifyInstance {
  return {
    inject: async (opts: { url: string }) => {
      captured.url = opts.url;
      // Return a benign 200 envelope so the handler's success path runs.
      return { statusCode: 200, payload: JSON.stringify({}) };
    },
  } as unknown as FastifyInstance;
}

/** Placeholder args covering every input field a buildUrl might read. */
const PLACEHOLDER_ARGS: Record<string, unknown> = {
  id: 'placeholder-id',
  envId: 'placeholder-env',
  environmentId: 'placeholder-env',
  depId: 'placeholder-dep',
  module: 'general',
};

function toolCtx(captured: { url?: string }): McpToolContext {
  return {
    app: capturingApp(captured),
    bearer: 'b',
    callerIp: '203.0.113.1',
    authUser: { id: 'u1', email: 'a@test', name: null, role: 'admin' },
    registeredToolNames: [],
  };
}

function resourceCtx(captured: { url?: string }): McpResourceContext {
  return {
    app: capturingApp(captured),
    bearer: 'b',
    callerIp: '203.0.113.1',
    authUser: { id: 'u1', email: 'a@test', name: null, role: 'admin' },
    registeredToolNames: [],
    registeredResourceNames: [],
  };
}

/** Derive envScoped purely from the path the entry reaches. */
function deriveEnvScopedFromPath(path: string): boolean {
  return path.startsWith('/api/environments/');
}

describe('envScoped reflects route reachability (FIX 7 drift guard)', () => {
  for (const tool of ALL_TOOLS) {
    it(`tool ${tool.name}`, async () => {
      if (ENV_SCOPED_EXCEPTIONS.has(tool.name)) {
        expect(tool.envScoped).toBe(true);
        return;
      }
      const captured: { url?: string } = {};
      await tool.handler(PLACEHOLDER_ARGS, toolCtx(captured));
      expect(captured.url, `${tool.name} should have injected a URL`).toBeDefined();
      const path = captured.url!.split('?')[0];
      expect(tool.envScoped).toBe(deriveEnvScopedFromPath(path));
    });
  }

  for (const resource of ALL_RESOURCES) {
    it(`resource ${resource.name}`, async () => {
      if (ENV_SCOPED_EXCEPTIONS.has(resource.name)) {
        expect(resource.envScoped).toBe(true);
        return;
      }
      const captured: { url?: string } = {};
      const ctx = resourceCtx(captured);
      // The config-file/fragment resources READ through a per-id global route.
      // Drive the read callback with a placeholder id to capture that route.
      const uriStr =
        resource.name === 'config-files'
          ? configFileUri('placeholder-id')
          : configFragmentUri('placeholder-id');
      const read = resource.read(ctx) as ReadResourceTemplateCallback;
      await read(new URL(uriStr), { id: 'placeholder-id' }, {} as never);
      expect(captured.url, `${resource.name} should have injected a URL`).toBeDefined();
      const path = captured.url!.split('?')[0];
      expect(resource.envScoped).toBe(deriveEnvScopedFromPath(path));
    });
  }
});
