/**
 * MCP tool registry (issue #208).
 *
 * Each entry is a thin projection of an existing API route. Read tools are
 * backed by side-effect-free GETs and are available to any valid token (every
 * role has `*:read`). Write tools require a `*:write` scope (operator/admin),
 * carry destructive MCP annotations, and inject an `Idempotency-Key` so #126's
 * middleware dedupes retried identical calls.
 *
 * Output is passthrough JSON of the API envelope, with two deliberate
 * exceptions:
 *   - `list_vars` strips the plaintext `value` field (the route returns it for
 *     every role; the tool must expose keys + usage only — issue #208).
 *   - `get_capabilities` is synthesized locally (no inject) from the caller's
 *     scopes + the registered tool list.
 *
 * Hand-written zod input schemas live here per tool. We intentionally do NOT
 * reuse the OpenAPI/route JSON-Schemas: several target routes (e.g.
 * /api/audit-logs) have no schema, and the tool inputs are a narrow,
 * curated subset of each route's params/query anyway.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { appVersion } from '../lib/version.js';
import { computeScopes } from '../lib/scopes.js';
import { injectApi } from './inject.js';
import type { McpToolContext, McpToolDef, McpToolResult } from './types.js';

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** Wrap any JSON-serializable value as a passthrough MCP text result. */
function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Build an MCP error result from a `code: message` pair. */
function errorResult(code: string, message: string): McpToolResult {
  return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true };
}

/**
 * Derive a stable Idempotency-Key for a write tool call:
 *   sha256(toolName + ':' + canonicalJSON(args))
 * A duplicated/retried identical call therefore dedupes automatically. Callers
 * may override by passing an explicit `idempotencyKey` arg (handled by the
 * caller of this function).
 *
 * Canonical JSON sorts object keys so semantically-identical args (different key
 * order) hash to the same key. The optional `idempotencyKey` arg is excluded
 * from the hash input (it is not part of the logical operation).
 */
export function deriveIdempotencyKey(toolName: string, args: Record<string, unknown>): string {
  const { idempotencyKey: _omit, ...rest } = args;
  void _omit;
  return createHash('sha256').update(`${toolName}:${canonicalJson(rest)}`).digest('hex');
}

/** Deterministic JSON.stringify with sorted object keys (arrays keep order). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

/**
 * Build a read tool: GETs the URL produced by `buildUrl(args)` and returns the
 * API body verbatim (or an MCP error result on non-2xx). `transform` optionally
 * post-processes the parsed body (used to strip var values).
 */
function readTool(opts: {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  buildUrl: (args: Record<string, unknown>) => string;
  transform?: (body: unknown) => unknown;
}): McpToolDef {
  return {
    name: opts.name,
    title: opts.title,
    description: opts.description,
    inputSchema: opts.inputSchema,
    requiredScope: null, // every valid token has *:read
    destructive: false,
    readOnly: true,
    isWrite: false,
    handler: async (args, ctx) => {
      const url = opts.buildUrl(args);
      const res = await injectApi(ctx.app, { method: 'GET', url, bearer: ctx.bearer });
      if (!res.ok) {
        return errorResult(res.error?.code ?? 'ERROR', res.error?.message ?? `Request failed (${res.status})`);
      }
      return jsonResult(opts.transform ? opts.transform(res.body) : res.body);
    },
  };
}

/**
 * Build a write tool: POSTs to the URL produced by `buildUrl(args)` with an
 * optional JSON body from `buildBody(args)`, injecting an Idempotency-Key. The
 * key is the caller-provided `idempotencyKey` arg if present, else a stable
 * hash of the tool name + canonical args.
 */
function writeTool(opts: {
  name: string;
  title: string;
  description: string;
  requiredScope: string;
  inputSchema: Record<string, z.ZodType>;
  buildUrl: (args: Record<string, unknown>) => string;
  buildBody?: (args: Record<string, unknown>) => Record<string, unknown> | undefined;
}): McpToolDef {
  // Every write tool also accepts an optional idempotencyKey override.
  const inputSchema: Record<string, z.ZodType> = {
    ...opts.inputSchema,
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Optional Idempotency-Key override. If omitted, a stable key is derived from the tool name + arguments so an identical retried call is deduplicated.'
      ),
  };
  return {
    name: opts.name,
    title: opts.title,
    description: opts.description,
    inputSchema,
    requiredScope: opts.requiredScope,
    destructive: true,
    readOnly: false,
    isWrite: true,
    handler: async (args, ctx) => {
      const url = opts.buildUrl(args);
      const body = opts.buildBody ? opts.buildBody(args) : undefined;
      const override = typeof args.idempotencyKey === 'string' ? args.idempotencyKey.trim() : '';
      const idempotencyKey = override || deriveIdempotencyKey(opts.name, args);
      const res = await injectApi(ctx.app, {
        method: 'POST',
        url,
        bearer: ctx.bearer,
        idempotencyKey,
        body,
      });
      if (!res.ok) {
        return errorResult(res.error?.code ?? 'ERROR', res.error?.message ?? `Request failed (${res.status})`);
      }
      return jsonResult(res.body);
    },
  };
}

// Small shared schema fragments.
const id = z.string().min(1).describe('Resource id (cuid).');
const envId = z.string().min(1).describe('Environment id (cuid).');

// ---------------------------------------------------------------------------
// READ TOOLS (backed by side-effect-free GETs; available to any valid token)
// ---------------------------------------------------------------------------

const readTools: McpToolDef[] = [
  readTool({
    name: 'list_environments',
    title: 'List environments',
    description: 'List all environments the caller can access.',
    inputSchema: {},
    buildUrl: () => '/api/environments',
  }),
  readTool({
    name: 'get_environment',
    title: 'Get environment',
    description: 'Get a single environment by id.',
    inputSchema: { id },
    buildUrl: (a) => `/api/environments/${encodeURIComponent(String(a.id))}`,
  }),
  readTool({
    name: 'list_servers',
    title: 'List servers',
    description: 'List servers in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${encodeURIComponent(String(a.envId))}/servers`,
  }),
  readTool({
    name: 'get_server',
    title: 'Get server',
    description:
      'Get a single server by id, including its cached last-health-check fields. Pass includeServices=true to also list its deployments.',
    inputSchema: { id, includeServices: z.boolean().optional().describe('Include the flattened services array.') },
    buildUrl: (a) =>
      `/api/servers/${encodeURIComponent(String(a.id))}${a.includeServices ? '?include=services' : ''}`,
  }),
  readTool({
    name: 'get_server_health',
    title: 'Get health status',
    description:
      'Get the current cached health status of all servers, services, and databases in an environment (read-only; reads denormalized columns, never triggers a live SSH check).',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${encodeURIComponent(String(a.envId))}/health-status`,
  }),
  readTool({
    name: 'list_services',
    title: 'List services',
    description: 'List service templates in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${encodeURIComponent(String(a.envId))}/services`,
  }),
  readTool({
    name: 'get_service',
    title: 'Get service',
    description: 'Get a single service template by id, including its deployments.',
    inputSchema: { id },
    buildUrl: (a) => `/api/services/${encodeURIComponent(String(a.id))}`,
  }),
  readTool({
    name: 'get_service_logs',
    title: 'Get deployment logs',
    description:
      'Fetch recent container logs for a specific deployment of a service. Logs may contain sensitive output — see the data-egress note in the MCP docs.',
    inputSchema: {
      id,
      depId: z.string().min(1).describe('ServiceDeployment id (per-server runtime). Get it from get_service.'),
      tail: z.number().int().min(1).max(10000).optional().describe('Number of trailing log lines (default from system settings).'),
    },
    buildUrl: (a) => {
      const base = `/api/services/${encodeURIComponent(String(a.id))}/deployments/${encodeURIComponent(String(a.depId))}/logs`;
      return a.tail !== undefined ? `${base}?tail=${encodeURIComponent(String(a.tail))}` : base;
    },
  }),
  readTool({
    name: 'list_config_files',
    title: 'List config files',
    description: 'List config files in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${encodeURIComponent(String(a.envId))}/config-files`,
  }),
  readTool({
    name: 'get_config_file',
    title: 'Get config file',
    description: 'Get a single config file by id (includes its content).',
    inputSchema: { id },
    buildUrl: (a) => `/api/config-files/${encodeURIComponent(String(a.id))}`,
  }),
  readTool({
    name: 'list_config_fragments',
    title: 'List config fragments',
    description: 'List reusable config fragments in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${encodeURIComponent(String(a.envId))}/config-fragments`,
  }),
  readTool({
    name: 'list_secrets',
    title: 'List secrets',
    description:
      'List secret keys and metadata (usage info) in an environment. Decrypted secret VALUES are never returned by this tool.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${encodeURIComponent(String(a.envId))}/secrets`,
  }),
  readTool({
    name: 'list_vars',
    title: 'List vars',
    description:
      'List variable keys, descriptions, and usage info in an environment. Variable VALUES are intentionally stripped from this tool’s output.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${encodeURIComponent(String(a.envId))}/vars`,
    // The underlying route returns plaintext `value` for every role. Strip it
    // so the tool exposes key/description/usage/timestamps only (issue #208).
    transform: (body) => {
      if (!body || typeof body !== 'object' || !Array.isArray((body as Record<string, unknown>).vars)) {
        return body;
      }
      const vars = (body as { vars: Array<Record<string, unknown>> }).vars.map((v) => {
        const { value: _value, ...rest } = v;
        void _value;
        return rest;
      });
      return { ...(body as Record<string, unknown>), vars };
    },
  }),
  readTool({
    name: 'get_server_metrics',
    title: 'Get server metrics',
    description: 'Get recent metrics samples for a server.',
    inputSchema: { id },
    buildUrl: (a) => `/api/servers/${encodeURIComponent(String(a.id))}/metrics`,
  }),
  readTool({
    name: 'get_service_metrics',
    title: 'Get service metrics',
    description: 'Get recent metrics samples for a service.',
    inputSchema: { id },
    buildUrl: (a) => `/api/services/${encodeURIComponent(String(a.id))}/metrics`,
  }),
  readTool({
    name: 'get_metrics_history',
    title: 'Get metrics history',
    description: 'Get aggregated server metrics history for an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${encodeURIComponent(String(a.envId))}/metrics/history`,
  }),
  readTool({
    name: 'list_health_checks',
    title: 'List health-check logs',
    description: 'List recent health-check log entries for an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${encodeURIComponent(String(a.envId))}/health-logs`,
  }),
  readTool({
    name: 'get_deployments',
    title: 'Get deployment history',
    description: 'Get the deployment history for a service template.',
    inputSchema: { id },
    buildUrl: (a) => `/api/services/${encodeURIComponent(String(a.id))}/deployments-history`,
  }),
  readTool({
    name: 'list_deployment_plans',
    title: 'List deployment plans',
    description: 'List deployment plans for an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${encodeURIComponent(String(a.envId))}/deployment-plans`,
  }),
  readTool({
    name: 'get_deployment_plan',
    title: 'Get deployment plan',
    description: 'Get a single deployment plan by id.',
    inputSchema: { id },
    buildUrl: (a) => `/api/deployment-plans/${encodeURIComponent(String(a.id))}`,
  }),
  readTool({
    name: 'get_drift',
    title: 'Get server drift',
    description:
      'Compute configuration drift between BridgePort’s stored view and actual host state for every deployment on a server (read-only).',
    inputSchema: { id },
    buildUrl: (a) => `/api/servers/${encodeURIComponent(String(a.id))}/drift`,
  }),
  readTool({
    name: 'query_audit_log',
    title: 'Query audit log',
    description: 'Query the audit log with optional filters.',
    inputSchema: {
      environmentId: z.string().min(1).optional().describe('Filter by environment id.'),
      resourceType: z.string().min(1).optional().describe('Filter by resource type (e.g. "service", "secret").'),
      resourceId: z.string().min(1).optional().describe('Filter by a specific resource id.'),
      action: z.string().min(1).optional().describe('Filter by action (e.g. "deploy", "create").'),
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 50).'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0).'),
    },
    buildUrl: (a) => {
      const params = new URLSearchParams();
      for (const key of ['environmentId', 'resourceType', 'resourceId', 'action', 'limit', 'offset'] as const) {
        if (a[key] !== undefined && a[key] !== null) params.set(key, String(a[key]));
      }
      const qs = params.toString();
      return qs ? `/api/audit-logs?${qs}` : '/api/audit-logs';
    },
  }),
  readTool({
    name: 'get_version',
    title: 'Get version',
    description: 'Get the running BridgePort app, bundled agent, and CLI versions.',
    inputSchema: {},
    // There is no /api/version route (#199 shipped as policy docs, not an
    // endpoint); /health returns version/bundledAgentVersion/cliVersion.
    buildUrl: () => '/health',
  }),
];

// ---------------------------------------------------------------------------
// META TOOL — get_capabilities (synthesized, no inject)
// ---------------------------------------------------------------------------

const getCapabilitiesTool: McpToolDef = {
  name: 'get_capabilities',
  title: 'Get capabilities',
  description:
    'Describe what this MCP session can do: the BridgePort version, the caller’s derived scopes, and the names of the tools available to this token.',
  inputSchema: {},
  requiredScope: null,
  destructive: false,
  readOnly: true,
  isWrite: false,
  handler: async (_args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolResult> => {
    return jsonResult({
      version: appVersion,
      scopes: computeScopes(ctx.authUser),
      tools: ctx.registeredToolNames,
    });
  },
};

// ---------------------------------------------------------------------------
// WRITE TOOLS (require a *:write scope; destructive; inject Idempotency-Key)
//
// All gated on `services:write`, which computeScopes grants to operator+admin
// only — the exact role set the underlying routes admit (the global
// enforceRoleForMethod blocks viewers on every POST; the backup and config-sync
// routes additionally use requireOperator). `databases:write` is intentionally
// NOT used because computeScopes does not emit it.
// ---------------------------------------------------------------------------

const writeTools: McpToolDef[] = [
  writeTool({
    name: 'deploy_service',
    title: 'Deploy service',
    description:
      'Deploy a service template across all of its deployments. DESTRUCTIVE: cycles running containers. Injects an Idempotency-Key so a retried identical call is deduplicated.',
    requiredScope: 'services:write',
    inputSchema: {
      id,
      imageTag: z.string().min(1).optional().describe('Image tag to deploy (defaults to the service’s configured tag).'),
      pullImage: z.boolean().optional().describe('Pull the image before deploying.'),
      generateArtifacts: z.boolean().optional().describe('Regenerate compose/env artifacts before deploying.'),
      strategy: z.string().min(1).optional().describe('Deploy strategy override.'),
    },
    buildUrl: (a) => `/api/services/${encodeURIComponent(String(a.id))}/deploy`,
    buildBody: (a) => {
      const body: Record<string, unknown> = {};
      for (const key of ['imageTag', 'pullImage', 'generateArtifacts', 'strategy'] as const) {
        if (a[key] !== undefined) body[key] = a[key];
      }
      return body;
    },
  }),
  writeTool({
    name: 'execute_deployment_plan',
    title: 'Execute deployment plan',
    description:
      'Execute a pending deployment plan. Pass dryRun=true for a non-mutating preview. DESTRUCTIVE when dryRun is false. Injects an Idempotency-Key.',
    requiredScope: 'services:write',
    inputSchema: {
      id,
      dryRun: z.boolean().optional().describe('Preview the plan without executing it.'),
    },
    buildUrl: (a) =>
      `/api/deployment-plans/${encodeURIComponent(String(a.id))}/execute${a.dryRun ? '?dryRun=true' : ''}`,
  }),
  writeTool({
    name: 'restart_deployment',
    title: 'Restart deployment',
    description:
      'Restart the container backing a specific deployment. DESTRUCTIVE: bounces the running container. Injects an Idempotency-Key.',
    requiredScope: 'services:write',
    inputSchema: {
      id,
      depId: z.string().min(1).describe('ServiceDeployment id. Get it from get_service.'),
    },
    buildUrl: (a) =>
      `/api/services/${encodeURIComponent(String(a.id))}/deployments/${encodeURIComponent(String(a.depId))}/restart`,
  }),
  writeTool({
    name: 'rollback_deployment_plan',
    title: 'Rollback deployment plan',
    description:
      'Manually trigger rollback for a completed or failed deployment plan. DESTRUCTIVE: re-deploys previous images. Injects an Idempotency-Key.',
    requiredScope: 'services:write',
    inputSchema: { id },
    buildUrl: (a) => `/api/deployment-plans/${encodeURIComponent(String(a.id))}/rollback`,
  }),
  writeTool({
    name: 'run_database_backup',
    title: 'Run database backup',
    description:
      'Trigger a backup for a database (requires operator role). Injects an Idempotency-Key so a retried identical call is deduplicated.',
    requiredScope: 'services:write',
    inputSchema: { id },
    buildUrl: (a) => `/api/databases/${encodeURIComponent(String(a.id))}/backups`,
  }),
  writeTool({
    name: 'sync_config_file',
    title: 'Sync config file',
    description:
      'Sync a config file to every (service, server) attachment (requires operator role). Pass dryRun=true for a non-mutating diff preview. Injects an Idempotency-Key.',
    requiredScope: 'services:write',
    inputSchema: {
      id,
      dryRun: z.boolean().optional().describe('Preview the diff without writing to hosts.'),
    },
    buildUrl: (a) =>
      `/api/config-files/${encodeURIComponent(String(a.id))}/sync-all${a.dryRun ? '?dryRun=true' : ''}`,
  }),
];

/** The full tool registry: meta + read + write groups. */
export const ALL_TOOLS: McpToolDef[] = [getCapabilitiesTool, ...readTools, ...writeTools];
