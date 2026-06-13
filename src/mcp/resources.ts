/**
 * MCP resource registry (issue #208).
 *
 * Resources are the read-only, browse-and-attach counterpart to the tools in
 * `tools.ts`. Like every tool, each resource is a THIN PROJECTION of an existing
 * GET route: the content is fetched through the SAME `injectApi` mechanism
 * (caller's bearer → real route → full auth/scope/audit), so enforcement is
 * identical to the REST API. There is NO new business logic and NO bypass of
 * scope/role here.
 *
 * Three resource families are exposed:
 *
 *   1. Config files     — template `bridgeport:///config-files/{id}`
 *   2. Config fragments  — template `bridgeport:///config-fragments/{id}`
 *   3. Capabilities      — static `bridgeport:///capabilities`
 *
 * The two templates use a LAZY list callback: nothing is enumerated at connect.
 * On `resources/list` the callback walks the caller's accessible environments
 * (`GET /api/environments` — already filtered to the token's env allowlist) and,
 * for each, the env-prefixed list route (`/api/environments/:envId/config-files`
 * | `.../config-fragments`). This means env-scoping falls out of the inject
 * mechanism for free: an env-scoped token only ever enumerates through env
 * routes it can reach, so a global read that would 403 is never advertised. On
 * `resources/read` the per-id GET route runs the real scope/role check — an
 * env-scoped token reading a file in another env gets the same FORBIDDEN_SCOPE
 * it would from REST.
 *
 * SECRET SAFETY: the per-id routes (`GET /api/config-files/:id`,
 * `GET /api/config-fragments/:id`) return the *templated* content straight from
 * the DB column — they do NOT resolve `${KEY}` placeholders or decrypt secrets
 * (that only happens on the separate `/preview` and compose routes, which
 * additionally redact). So the content surfaced here is the same non-secret form
 * the existing `get_config_file` tool already exposes.
 */

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ListResourcesResult,
  ReadResourceResult,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { z } from 'zod';
import { appVersion } from '../lib/version.js';
import { computeScopes } from '../lib/scopes.js';
import { injectApi } from './inject.js';
import type { McpResourceContext, McpResourceDef } from './types.js';

// ---------------------------------------------------------------------------
// URI scheme
// ---------------------------------------------------------------------------

/**
 * The custom URI scheme for every BridgePort resource. The triple slash is the
 * conventional MCP "no authority" form (`scheme:///path`), so the host segment
 * is empty and the path carries the resource identity.
 */
export const RESOURCE_URI_SCHEME = 'bridgeport';

/** `bridgeport:///config-files/{id}` — one readable config file by id. */
export const CONFIG_FILE_URI_TEMPLATE = 'bridgeport:///config-files/{id}';
/** `bridgeport:///config-fragments/{id}` — one readable config fragment by id. */
export const CONFIG_FRAGMENT_URI_TEMPLATE = 'bridgeport:///config-fragments/{id}';
/** `bridgeport:///capabilities` — the static session capabilities resource. */
export const CAPABILITIES_URI = 'bridgeport:///capabilities';

/**
 * Build a concrete config-file resource URI for a given id. Mirrors the
 * `seg()` percent-encoding the tools use so an id can never break out of its
 * path segment.
 */
export function configFileUri(id: string): string {
  return `${RESOURCE_URI_SCHEME}:///config-files/${encodeURIComponent(id)}`;
}

/** Build a concrete config-fragment resource URI for a given id. */
export function configFragmentUri(id: string): string {
  return `${RESOURCE_URI_SCHEME}:///config-fragments/${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------------------
// Enumeration helpers (shared by the two template list callbacks)
// ---------------------------------------------------------------------------

/** Minimal shape of an environment row from `GET /api/environments`. */
const envRowSchema = z.object({ id: z.string(), name: z.string().optional() });

/**
 * Enumerate the ids of the caller's accessible environments via
 * `GET /api/environments`. That route already filters to the token's env
 * allowlist (env-scoped tokens see only their envs; all-environments tokens and
 * JWT sessions see all), so this is the single env-scoping anchor for the list
 * callbacks — no per-env scope logic is duplicated here.
 */
async function listAccessibleEnvironments(
  ctx: McpResourceContext
): Promise<Array<{ id: string; name?: string }>> {
  const res = await injectApi(ctx.app, {
    method: 'GET',
    url: '/api/environments',
    bearer: ctx.bearer,
    remoteAddress: ctx.callerIp,
  });
  if (!res.ok || !res.body || typeof res.body !== 'object') return [];
  const envs = (res.body as { environments?: unknown }).environments;
  if (!Array.isArray(envs)) return [];
  const out: Array<{ id: string; name?: string }> = [];
  for (const row of envs) {
    const parsed = envRowSchema.safeParse(row);
    if (parsed.success) out.push({ id: parsed.data.id, name: parsed.data.name });
  }
  return out;
}

/**
 * Generic enumerator for an env-scoped collection. For each accessible
 * environment it GETs `/api/environments/:envId/<collection>` and maps the rows
 * (via `mapRow`) into MCP `Resource` descriptors. A non-ok response for a single
 * env is skipped (best-effort listing) rather than failing the whole list.
 */
async function enumerateEnvCollection(
  ctx: McpResourceContext,
  collection: 'config-files' | 'config-fragments',
  pluck: (body: unknown) => Array<Record<string, unknown>>,
  mapRow: (row: Record<string, unknown>, env: { id: string; name?: string }) => Resource | null
): Promise<Resource[]> {
  const envs = await listAccessibleEnvironments(ctx);
  const resources: Resource[] = [];
  for (const env of envs) {
    const res = await injectApi(ctx.app, {
      method: 'GET',
      url: `/api/environments/${encodeURIComponent(env.id)}/${collection}`,
      bearer: ctx.bearer,
      remoteAddress: ctx.callerIp,
    });
    if (!res.ok) continue;
    for (const row of pluck(res.body)) {
      const resource = mapRow(row, env);
      if (resource) resources.push(resource);
    }
  }
  return resources;
}

/** Extract a string field from a row, or undefined when absent/non-string. */
function str(row: Record<string, unknown>, key: string): string | undefined {
  const v = row[key];
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Read-callback helper
// ---------------------------------------------------------------------------

/**
 * Fetch a single resource's content via a per-id GET route and wrap it as an
 * MCP `ReadResourceResult`. The fetched JSON envelope is pretty-printed as the
 * resource text (same passthrough style as the tools). On a non-ok response we
 * throw so the SDK surfaces a resource read error to the client (read callbacks
 * have no `isError` channel — a throw is the contract).
 */
async function readViaInject(
  ctx: McpResourceContext,
  uri: URL,
  apiUrl: string,
  mimeType: string
): Promise<ReadResourceResult> {
  const res = await injectApi(ctx.app, {
    method: 'GET',
    url: apiUrl,
    bearer: ctx.bearer,
    remoteAddress: ctx.callerIp,
  });
  if (!res.ok) {
    const code = res.error?.code ?? 'ERROR';
    const message = res.error?.message ?? 'Request failed';
    throw new Error(`${code}: ${message} | status: ${res.status}`);
  }
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType,
        text: JSON.stringify(res.body, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Resource definitions
// ---------------------------------------------------------------------------

/**
 * Config files as readable resources. URI: `bridgeport:///config-files/{id}`.
 *
 * - list: enumerate the caller's accessible config files (across their envs)
 *   via the env-prefixed list route. The list route returns metadata only (no
 *   content), which is exactly what a resource descriptor needs.
 * - read: GET `/api/config-files/:id` — the same secret-safe route the
 *   `get_config_file` tool uses (templated content, placeholders intact).
 */
const configFilesResource: McpResourceDef = {
  name: 'config-files',
  title: 'Config files',
  description:
    'Browse and read config files across your accessible environments. Content is the stored, TEMPLATED form (with `${KEY}` placeholders intact) — resolved/decrypted secret values are never included. URI: bridgeport:///config-files/{id}.',
  mimeType: 'application/json',
  requiredScope: null, // every valid token has *:read
  // READ hits the global GET /api/config-files/:id route → FORBIDDEN_SCOPE for
  // an env-scoped token (mirrors the get_config_file tool, also envScoped:false).
  envScoped: false,
  build: (ctx) =>
    new ResourceTemplate(CONFIG_FILE_URI_TEMPLATE, {
      list: async (): Promise<ListResourcesResult> => {
        const resources = await enumerateEnvCollection(
          ctx,
          'config-files',
          (body) => {
            const files = (body as { configFiles?: unknown })?.configFiles;
            return Array.isArray(files) ? (files as Array<Record<string, unknown>>) : [];
          },
          (row, env) => {
            const id = str(row, 'id');
            if (!id) return null;
            const name = str(row, 'name') ?? id;
            const filename = str(row, 'filename');
            const envLabel = env.name ?? env.id;
            return {
              uri: configFileUri(id),
              name: `${envLabel}: ${name}`,
              title: filename ? `${name} (${filename})` : name,
              description: str(row, 'description') ?? undefined,
              mimeType: 'application/json',
            };
          }
        );
        return { resources };
      },
    }),
  read: (ctx) => async (uri: URL, variables: Variables) => {
    const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
    return readViaInject(
      ctx,
      uri,
      `/api/config-files/${encodeURIComponent(String(id))}`,
      'application/json'
    );
  },
};

/**
 * Config fragments as readable resources. URI:
 * `bridgeport:///config-fragments/{id}`. Same pattern as config files.
 *
 * - read: GET `/api/config-fragments/:id` — returns the fragment's templated
 *   content straight from the DB (no secret resolution).
 */
const configFragmentsResource: McpResourceDef = {
  name: 'config-fragments',
  title: 'Config fragments',
  description:
    'Browse and read reusable config fragments across your accessible environments. Content is the stored, TEMPLATED text — resolved/decrypted secret values are never included. URI: bridgeport:///config-fragments/{id}.',
  mimeType: 'application/json',
  requiredScope: null, // every valid token has *:read
  // READ hits the global GET /api/config-fragments/:id route → FORBIDDEN_SCOPE
  // for an env-scoped token, so withheld from env-scoped tokens.
  envScoped: false,
  build: (ctx) =>
    new ResourceTemplate(CONFIG_FRAGMENT_URI_TEMPLATE, {
      list: async (): Promise<ListResourcesResult> => {
        const resources = await enumerateEnvCollection(
          ctx,
          'config-fragments',
          (body) => {
            const frags = (body as { fragments?: unknown })?.fragments;
            return Array.isArray(frags) ? (frags as Array<Record<string, unknown>>) : [];
          },
          (row, env) => {
            const id = str(row, 'id');
            if (!id) return null;
            const name = str(row, 'name') ?? id;
            const envLabel = env.name ?? env.id;
            return {
              uri: configFragmentUri(id),
              name: `${envLabel}: ${name}`,
              title: name,
              description: str(row, 'description') ?? undefined,
              mimeType: 'application/json',
            };
          }
        );
        return { resources };
      },
    }),
  read: (ctx) => async (uri: URL, variables: Variables) => {
    const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
    return readViaInject(
      ctx,
      uri,
      `/api/config-fragments/${encodeURIComponent(String(id))}`,
      'application/json'
    );
  },
};

/**
 * Capabilities / server-info as a single STATIC resource. URI:
 * `bridgeport:///capabilities`. No inject needed — synthesized locally from the
 * caller's scopes plus the registered tool/resource names (the same shape as the
 * `get_capabilities` tool, extended with `resources`).
 */
const capabilitiesResource: McpResourceDef = {
  name: 'capabilities',
  title: 'Capabilities',
  description:
    'BridgePort version, the caller’s derived scopes, and the names of the tools and resources available to this session. Synthesized locally (no API call).',
  mimeType: 'application/json',
  requiredScope: null,
  // Synthesized locally (no inject), so no route to scope-check — usable by any
  // token, including an env-scoped one.
  envScoped: true,
  uri: CAPABILITIES_URI,
  read: (ctx) => async (uri: URL) => {
    const payload = {
      version: appVersion,
      scopes: computeScopes(ctx.authUser),
      tools: ctx.registeredToolNames,
      resources: ctx.registeredResourceNames,
    };
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  },
};

/**
 * The full resource registry. Templates first, then the static capabilities
 * resource. `buildMcpResources` (server.ts) registers each one with the SDK.
 */
export const ALL_RESOURCES: McpResourceDef[] = [
  configFilesResource,
  configFragmentsResource,
  capabilitiesResource,
];
