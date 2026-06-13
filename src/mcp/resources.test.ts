/**
 * Unit tests for the MCP resource registry + scope/env gating (issue #208).
 *
 * Pure logic only — no SDK transport, no real Fastify/DB. We exercise:
 *   - the registry shape (one static capabilities resource, two templates) and
 *     their scope/env flags;
 *   - URI building + the URI-scheme constants;
 *   - `selectResourcesForScopes` (the pure env/scope gate, parallel to
 *     `selectToolsForScopes`);
 *   - the template `list` callbacks' ENV-SCOPING: a FAKE `app.inject` returns
 *     only the caller's accessible environments, and we assert the enumeration
 *     walks exactly those envs (a token scoped to env A never enumerates env B);
 *   - the capabilities read callback shape;
 *   - the config-file/fragment read callbacks pass the API body through
 *     verbatim (so TEMPLATED, non-secret content is what flows out).
 */
import { describe, it, expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ALL_RESOURCES,
  configFileUri,
  configFragmentUri,
  RESOURCE_URI_SCHEME,
  CONFIG_FILE_URI_TEMPLATE,
  CONFIG_FRAGMENT_URI_TEMPLATE,
  CAPABILITIES_URI,
} from './resources.js';
import { selectResourcesForScopes } from './server.js';
import type { McpResourceContext, McpResourceDef } from './types.js';
import type { ReadResourceTemplateCallback, ReadResourceCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import type { ListResourcesResult } from '@modelcontextprotocol/sdk/types.js';
import type { AuthUser } from '../services/auth.js';
import { appVersion } from '../lib/version.js';
import { computeScopes } from '../lib/scopes.js';

function resource(name: string): McpResourceDef {
  const def = ALL_RESOURCES.find((r) => r.name === name);
  if (!def) throw new Error(`resource ${name} not found in registry`);
  return def;
}

/**
 * Build a resource context whose `app.inject` is a programmable stub keyed by
 * the request URL. `routes` maps a URL to a JSON-stringified payload (status
 * 200); an unmatched URL returns 404. Only `inject` is used by the callbacks.
 */
function fakeCtx(
  routes: Record<string, unknown>,
  opts: {
    authUser?: AuthUser;
    registeredToolNames?: string[];
    registeredResourceNames?: string[];
  } = {}
): McpResourceContext {
  const app = {
    inject: async ({ url }: { url: string }) => {
      if (url in routes) {
        return { statusCode: 200, payload: JSON.stringify(routes[url]) };
      }
      return { statusCode: 404, payload: JSON.stringify({ code: 'NOT_FOUND', message: 'Not found' }) };
    },
  } as unknown as FastifyInstance;
  return {
    app,
    bearer: 'test-bearer',
    callerIp: '203.0.113.7',
    authUser: opts.authUser ?? { id: 'u1', email: 'a@test', name: null, role: 'admin' },
    registeredToolNames: opts.registeredToolNames ?? [],
    registeredResourceNames: opts.registeredResourceNames ?? [],
  };
}

const user = (role: AuthUser['role']): AuthUser => ({ id: `u-${role}`, email: `${role}@test`, name: null, role });

describe('resource URI scheme + builders', () => {
  it('uses the bridgeport:/// scheme for the templates and capabilities', () => {
    expect(RESOURCE_URI_SCHEME).toBe('bridgeport');
    expect(CONFIG_FILE_URI_TEMPLATE).toBe('bridgeport:///config-files/{id}');
    expect(CONFIG_FRAGMENT_URI_TEMPLATE).toBe('bridgeport:///config-fragments/{id}');
    expect(CAPABILITIES_URI).toBe('bridgeport:///capabilities');
  });

  it('builds concrete URIs and percent-encodes the id', () => {
    expect(configFileUri('abc123')).toBe('bridgeport:///config-files/abc123');
    expect(configFragmentUri('abc123')).toBe('bridgeport:///config-fragments/abc123');
    // A nasty id can't break out of its path segment.
    expect(configFileUri('a/b?c')).toBe('bridgeport:///config-files/a%2Fb%3Fc');
  });
});

describe('resource registry shape', () => {
  it('has exactly three resources: two templates + one static capabilities', () => {
    expect(ALL_RESOURCES).toHaveLength(3);
    const templates = ALL_RESOURCES.filter((r) => typeof r.build === 'function');
    const statics = ALL_RESOURCES.filter((r) => typeof r.uri === 'string');
    expect(templates.map((r) => r.name).sort()).toEqual(['config-files', 'config-fragments']);
    expect(statics.map((r) => r.name)).toEqual(['capabilities']);
  });

  it('every resource sets exactly one of build / uri (template XOR static)', () => {
    for (const r of ALL_RESOURCES) {
      const hasBuild = typeof r.build === 'function';
      const hasUri = typeof r.uri === 'string';
      expect(hasBuild !== hasUri).toBe(true);
    }
  });

  it('config-file/fragment resources are envScoped:false (global read route); capabilities is envScoped:true', () => {
    expect(resource('config-files').envScoped).toBe(false);
    expect(resource('config-fragments').envScoped).toBe(false);
    expect(resource('capabilities').envScoped).toBe(true);
  });

  it('all resources require no special scope (null) — every valid token has *:read', () => {
    for (const r of ALL_RESOURCES) {
      expect(r.requiredScope).toBeNull();
    }
  });

  it('the config templates carry their URI template pattern', () => {
    const ctx = fakeCtx({});
    expect(resource('config-files').build!(ctx).uriTemplate.toString()).toBe(CONFIG_FILE_URI_TEMPLATE);
    expect(resource('config-fragments').build!(ctx).uriTemplate.toString()).toBe(
      CONFIG_FRAGMENT_URI_TEMPLATE
    );
  });
});

describe('selectResourcesForScopes (pure scope/env gate)', () => {
  it('a non-env-scoped token sees all three resources', () => {
    const names = selectResourcesForScopes(computeScopes(user('viewer'))).map((r) => r.name);
    expect([...names].sort()).toEqual(['capabilities', 'config-files', 'config-fragments']);
  });

  it('an env-scoped token sees ONLY capabilities (config resources read via a global route)', () => {
    // Same for every role: the config resources are withheld (envScoped:false),
    // capabilities remains (envScoped:true).
    for (const role of ['admin', 'operator', 'viewer'] as const) {
      const names = selectResourcesForScopes(computeScopes(user(role)), true).map((r) => r.name);
      expect(names).toEqual(['capabilities']);
    }
  });

  it('defaults to NOT env-scoped (omitting the flag keeps all three)', () => {
    expect(selectResourcesForScopes([]).map((r) => r.name).sort()).toEqual([
      'capabilities',
      'config-files',
      'config-fragments',
    ]);
  });
});

describe('template list callbacks enforce env-scoping via /api/environments', () => {
  // The list callback walks ONLY the environments /api/environments returns —
  // which is already filtered to the token's allowlist. So a stub that returns
  // env "A" (not "B") must yield only A's resources, never B's.
  const listCallbackOf = (name: string, ctx: McpResourceContext) => {
    const tmpl = resource(name).build!(ctx);
    const cb = tmpl.listCallback;
    if (!cb) throw new Error('expected a list callback');
    return cb;
  };

  it('config-files: enumerates only the accessible env’s files (env B is invisible)', async () => {
    const ctx = fakeCtx({
      // The token can see env A only.
      '/api/environments': { environments: [{ id: 'envA', name: 'Alpha' }] },
      '/api/environments/envA/config-files': {
        configFiles: [
          { id: 'cfA1', name: 'app.env', filename: 'app.env' },
          { id: 'cfA2', name: 'web.env', filename: 'web.env' },
        ],
      },
      // env B's route is wired but should NEVER be hit (not in the env list).
      '/api/environments/envB/config-files': {
        configFiles: [{ id: 'cfB1', name: 'secret.env', filename: 'secret.env' }],
      },
    });
    const result = (await listCallbackOf('config-files', ctx)(undefined as never)) as ListResourcesResult;
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toEqual([configFileUri('cfA1'), configFileUri('cfA2')]);
    // env B's file is NOT enumerated.
    expect(uris).not.toContain(configFileUri('cfB1'));
    // Each descriptor is labelled with the env name and carries the json mime.
    expect(result.resources[0].name).toContain('Alpha');
    expect(result.resources[0].mimeType).toBe('application/json');
  });

  it('config-fragments: enumerates only the accessible env’s fragments', async () => {
    const ctx = fakeCtx({
      '/api/environments': { environments: [{ id: 'envA', name: 'Alpha' }] },
      '/api/environments/envA/config-fragments': {
        fragments: [{ id: 'frA1', name: 'headers', description: 'shared' }],
      },
      '/api/environments/envB/config-fragments': {
        fragments: [{ id: 'frB1', name: 'other' }],
      },
    });
    const result = (await listCallbackOf('config-fragments', ctx)(
      undefined as never
    )) as ListResourcesResult;
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toEqual([configFragmentUri('frA1')]);
    expect(uris).not.toContain(configFragmentUri('frB1'));
  });

  it('returns an empty list when the caller has no accessible environments', async () => {
    const ctx = fakeCtx({ '/api/environments': { environments: [] } });
    const result = (await listCallbackOf('config-files', ctx)(undefined as never)) as ListResourcesResult;
    expect(result.resources).toEqual([]);
  });

  it('skips an environment whose list route returns a non-ok response (best-effort)', async () => {
    // env A lists fine; env B's list route is absent → 404 → skipped, not thrown.
    const ctx = fakeCtx({
      '/api/environments': {
        environments: [
          { id: 'envA', name: 'Alpha' },
          { id: 'envB', name: 'Bravo' },
        ],
      },
      '/api/environments/envA/config-files': { configFiles: [{ id: 'cfA1', name: 'a', filename: 'a' }] },
      // envB/config-files intentionally NOT defined → 404.
    });
    const result = (await listCallbackOf('config-files', ctx)(undefined as never)) as ListResourcesResult;
    expect(result.resources.map((r) => r.uri)).toEqual([configFileUri('cfA1')]);
  });
});

describe('read callbacks', () => {
  /**
   * Narrow a ReadResourceResult's first content block to its text. The SDK
   * types `contents[]` as a text|blob union; our read callbacks only ever emit
   * text, so this narrows (and asserts) that.
   */
  function textOf(out: { contents: Array<{ uri: string; mimeType?: string }> }): {
    text: string;
    uri: string;
    mimeType?: string;
  } {
    const block = out.contents[0] as { uri: string; mimeType?: string; text?: string };
    if (typeof block.text !== 'string') throw new Error('expected a text content block');
    return { text: block.text, uri: block.uri, mimeType: block.mimeType };
  }

  it('config-files read passes the API body through verbatim (templated, non-secret content)', async () => {
    const ctx = fakeCtx({
      '/api/config-files/cf1': {
        configFile: { id: 'cf1', content: 'DATABASE_URL=${MCP_DB_URL}\nPORT=8080' },
      },
    });
    const read = resource('config-files').read(ctx) as ReadResourceTemplateCallback;
    const out = await read(new URL(configFileUri('cf1')), { id: 'cf1' } as Variables, {} as never);
    expect(out.contents).toHaveLength(1);
    const block = textOf(out);
    // The `${KEY}` placeholder is present verbatim (no resolution/decryption).
    expect(block.text).toContain('${MCP_DB_URL}');
    expect(block.uri).toBe(configFileUri('cf1'));
    expect(block.mimeType).toBe('application/json');
  });

  it('config-files read THROWS a code+status error for a missing id (no isError channel)', async () => {
    const ctx = fakeCtx({}); // every URL 404s
    const read = resource('config-files').read(ctx) as ReadResourceTemplateCallback;
    await expect(
      read(new URL(configFileUri('missing')), { id: 'missing' } as Variables, {} as never)
    ).rejects.toThrow(/NOT_FOUND.*status: 404/);
  });

  it('config-fragments read passes the fragment body through verbatim', async () => {
    const ctx = fakeCtx({
      '/api/config-fragments/fr1': { fragment: { id: 'fr1', content: 'X-Frame-Options: DENY' } },
    });
    const read = resource('config-fragments').read(ctx) as ReadResourceTemplateCallback;
    const out = await read(new URL(configFragmentUri('fr1')), { id: 'fr1' } as Variables, {} as never);
    expect(textOf(out).text).toContain('X-Frame-Options: DENY');
  });

  it('capabilities read synthesizes { version, scopes, tools, resources } WITHOUT injecting', async () => {
    const authUser = user('operator');
    // An inject stub that THROWS if called — proving the capabilities read is local.
    const app = {
      inject: async () => {
        throw new Error('capabilities resource must not inject');
      },
    } as unknown as FastifyInstance;
    const ctx: McpResourceContext = {
      app,
      bearer: 'b',
      callerIp: '198.51.100.4',
      authUser,
      registeredToolNames: ['get_capabilities', 'list_services'],
      registeredResourceNames: ['config-files', 'config-fragments', 'capabilities'],
    };
    const read = resource('capabilities').read(ctx) as ReadResourceCallback;
    const out = await read(new URL(CAPABILITIES_URI), {} as never);
    const body = JSON.parse(textOf(out).text) as {
      version: string;
      scopes: string[];
      tools: string[];
      resources: string[];
    };
    expect(body.version).toBe(appVersion);
    expect(body.scopes).toEqual(computeScopes(authUser));
    expect(body.tools).toEqual(['get_capabilities', 'list_services']);
    expect(body.resources).toEqual(['config-files', 'config-fragments', 'capabilities']);
  });
});
