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
import { appVersion } from '../lib/version.js';
import { computeScopes } from '../lib/scopes.js';
import { canonicalizeJson, hashCanonicalBody } from '../lib/canonical-json.js';
import { injectApi, type InjectApiResult } from './inject.js';
import type { McpToolContext, McpToolDef, McpToolResult } from './types.js';

/**
 * Dedup window for derived Idempotency-Keys. The derived key folds in a time
 * bucket of this size, so two IDENTICAL calls within the same ~window dedupe as
 * retries (the original result replays), while an INTENDED repeat of the same
 * operation later (a different bucket) executes normally instead of silently
 * replaying a stale success. Callers can pass an explicit `idempotencyKey` to
 * force dedup across windows or to extend the safety net.
 */
export const IDEMPOTENCY_DEDUP_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** Wrap any JSON-serializable value as a passthrough MCP text result. */
function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * Map a non-ok `injectApi` result to an MCP error result, LOSSLESSLY: the HTTP
 * status plus the canonical envelope's `code`, `message`, and (when present)
 * `field` / `hint` are all surfaced so an agent can self-correct (e.g. fix the
 * offending field, or follow the hint). For a non-envelope error body we fall
 * back to the status and any string message. Used by BOTH the read and write
 * factories so the mapping is identical everywhere.
 */
function mapResult(res: InjectApiResult): McpToolResult {
  const parts: string[] = [];
  if (res.error) {
    parts.push(`${res.error.code}: ${res.error.message}`);
    if (res.error.field) parts.push(`field: ${res.error.field}`);
    if (res.error.hint) parts.push(`hint: ${res.error.hint}`);
  } else if (typeof res.body === 'string' && res.body.trim() !== '') {
    parts.push(res.body);
  } else if (
    res.body &&
    typeof res.body === 'object' &&
    typeof (res.body as Record<string, unknown>).error === 'string'
  ) {
    // Legacy `{ error: "..." }` body (some routes still emit this on 404).
    parts.push((res.body as { error: string }).error);
  } else {
    parts.push('Request failed');
  }
  parts.push(`status: ${res.status}`);
  return { content: [{ type: 'text', text: parts.join(' | ') }], isError: true };
}

/**
 * Derive a stable Idempotency-Key for a write tool call:
 *   sha256(toolName + ':' + timeBucket + ':' + canonicalJSON(args))
 *
 * The time bucket (`Math.floor(Date.now() / IDEMPOTENCY_DEDUP_WINDOW_MS)`) means
 * only TRUE retries within the window dedupe; an intended repeat of the same
 * operation in a later window derives a different key and executes normally
 * (rather than silently replaying a stale cached success). Callers may override
 * with an explicit `idempotencyKey` arg (handled by the caller of this function),
 * which is excluded from the hashed args here.
 *
 * Canonical JSON sorts object keys so semantically-identical args (different key
 * order) hash to the same key.
 */
export function deriveIdempotencyKey(toolName: string, args: Record<string, unknown>): string {
  const { idempotencyKey: _omit, ...rest } = args;
  void _omit;
  const timeBucket = Math.floor(Date.now() / IDEMPOTENCY_DEDUP_WINDOW_MS);
  return hashCanonicalBody(`${toolName}:${timeBucket}:${canonicalizeJson(rest)}`);
}

/**
 * URL-segment encoder. Coerces to string and percent-encodes so an id/value
 * interpolated into a path can never break out of its segment or inject query
 * syntax. Used by every `buildUrl` so safe encoding is the default and a future
 * tool can't accidentally drop it.
 */
const seg = (v: unknown): string => encodeURIComponent(String(v));

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
      const res = await injectApi(ctx.app, {
        method: 'GET',
        url,
        bearer: ctx.bearer,
        remoteAddress: ctx.callerIp,
      });
      if (!res.ok) {
        return mapResult(res);
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
        'Optional Idempotency-Key override. If omitted, a key is derived from the tool name + arguments + a ~60s time bucket, so an identical retried call within that window dedupes (the original result replays) while a later repeat executes. Pass an explicit value to force dedup across windows (e.g. tie to an external job id) or to extend the safety net. Ignored for dryRun previews (never cached).'
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
      // A dry-run is a non-mutating preview — it must NOT be cached, or a second
      // identical preview would replay a stale diff instead of recomputing. So
      // attach NO Idempotency-Key for dryRun=true; otherwise use the caller's
      // explicit override or the time-bucketed derived key.
      const isDryRun = args.dryRun === true;
      const override = typeof args.idempotencyKey === 'string' ? args.idempotencyKey.trim() : '';
      const idempotencyKey = isDryRun
        ? undefined
        : override || deriveIdempotencyKey(opts.name, args);
      const res = await injectApi(ctx.app, {
        method: 'POST',
        url,
        bearer: ctx.bearer,
        idempotencyKey,
        body,
        remoteAddress: ctx.callerIp,
      });
      if (!res.ok) {
        return mapResult(res);
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
    buildUrl: (a) => `/api/environments/${seg(a.id)}`,
  }),
  readTool({
    name: 'list_servers',
    title: 'List servers',
    description: 'List servers in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/servers`,
  }),
  readTool({
    name: 'get_server',
    title: 'Get server',
    description:
      'Get a single server by id, including its cached last-health-check fields. Pass includeServices=true to also list its deployments.',
    inputSchema: { id, includeServices: z.boolean().optional().describe('Include the flattened services array.') },
    buildUrl: (a) =>
      `/api/servers/${seg(a.id)}${a.includeServices ? '?include=services' : ''}`,
  }),
  readTool({
    name: 'get_server_health',
    title: 'Get health status',
    description:
      'Get the current cached health status of all servers, services, and databases in an environment (read-only; reads denormalized columns, never triggers a live SSH check).',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/health-status`,
  }),
  readTool({
    name: 'list_services',
    title: 'List services',
    description: 'List service templates in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/services`,
  }),
  readTool({
    name: 'get_service',
    title: 'Get service',
    description: 'Get a single service template by id, including its deployments.',
    inputSchema: { id },
    buildUrl: (a) => `/api/services/${seg(a.id)}`,
  }),
  readTool({
    name: 'get_service_logs',
    title: 'Get deployment logs',
    description:
      'Fetch recent container logs for a specific deployment of a service. COST: performs a LIVE query to the target host over SSH/Docker (not a cached read) — slower and not free, so avoid tight polling. Logs may contain sensitive output — see the data-egress note in the MCP docs.',
    inputSchema: {
      id,
      depId: z.string().min(1).describe('ServiceDeployment id (per-server runtime). Get it from get_service.'),
      tail: z.number().int().min(1).max(10000).optional().describe('Number of trailing log lines (default from system settings).'),
    },
    buildUrl: (a) => {
      const base = `/api/services/${seg(a.id)}/deployments/${seg(a.depId)}/logs`;
      return a.tail !== undefined ? `${base}?tail=${seg(a.tail)}` : base;
    },
  }),
  readTool({
    name: 'list_config_files',
    title: 'List config files',
    description: 'List config files in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/config-files`,
  }),
  readTool({
    name: 'get_config_file',
    title: 'Get config file',
    description: 'Get a single config file by id (includes its content).',
    inputSchema: { id },
    buildUrl: (a) => `/api/config-files/${seg(a.id)}`,
  }),
  readTool({
    name: 'list_config_fragments',
    title: 'List config fragments',
    description: 'List reusable config fragments in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/config-fragments`,
  }),
  readTool({
    name: 'list_secrets',
    title: 'List secrets',
    description:
      'List secret keys and metadata (usage info) in an environment. Decrypted secret VALUES are never returned by this tool.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/secrets`,
  }),
  readTool({
    name: 'list_vars',
    title: 'List vars',
    description:
      'List variable keys, descriptions, and usage info in an environment. Variable VALUES are intentionally stripped from this tool’s output.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/vars`,
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
    buildUrl: (a) => `/api/servers/${seg(a.id)}/metrics`,
  }),
  readTool({
    name: 'get_service_metrics',
    title: 'Get service metrics',
    description: 'Get recent metrics samples for a service.',
    inputSchema: { id },
    buildUrl: (a) => `/api/services/${seg(a.id)}/metrics`,
  }),
  readTool({
    name: 'get_metrics_history',
    title: 'Get metrics history',
    description: 'Get aggregated server metrics history for an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/metrics/history`,
  }),
  readTool({
    name: 'list_health_checks',
    title: 'List health-check logs',
    description: 'List recent health-check log entries for an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/health-logs`,
  }),
  readTool({
    name: 'get_deployments',
    title: 'Get deployment history',
    description: 'Get the deployment history for a service template.',
    inputSchema: { id },
    buildUrl: (a) => `/api/services/${seg(a.id)}/deployments-history`,
  }),
  readTool({
    name: 'list_deployment_plans',
    title: 'List deployment plans',
    description: 'List deployment plans for an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/deployment-plans`,
  }),
  readTool({
    name: 'get_deployment_plan',
    title: 'Get deployment plan',
    description: 'Get a single deployment plan by id.',
    inputSchema: { id },
    buildUrl: (a) => `/api/deployment-plans/${seg(a.id)}`,
  }),
  readTool({
    name: 'get_drift',
    title: 'Get server drift',
    description:
      'Compute configuration drift between BridgePort’s stored view and actual host state for every deployment on a server (read-only — does not change anything). COST: performs a LIVE query to the target host over SSH/Docker (not a cached read) — slower and not free, so avoid tight polling.',
    inputSchema: { id },
    buildUrl: (a) => `/api/servers/${seg(a.id)}/drift`,
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
      'Deploy a service template across all of its deployments. DESTRUCTIVE: cycles running containers. Identical calls within ~60s dedupe as retries (the original result replays); a later repeat executes. Pass a unique idempotencyKey to force or extend that safety.',
    requiredScope: 'services:write',
    inputSchema: {
      id,
      imageTag: z.string().min(1).optional().describe('Image tag to deploy (defaults to the service’s configured tag).'),
      pullImage: z.boolean().optional().describe('Pull the image before deploying.'),
      generateArtifacts: z.boolean().optional().describe('Regenerate compose/env artifacts before deploying.'),
      strategy: z
        .enum(['sequential', 'parallel'])
        .optional()
        .describe('Deploy strategy override: "sequential" or "parallel". Defaults to the service’s configured strategy.'),
    },
    buildUrl: (a) => `/api/services/${seg(a.id)}/deploy`,
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
      'Execute a pending deployment plan. Pass dryRun=true for a non-mutating preview (previews are never cached and always recompute). DESTRUCTIVE when dryRun is false: identical real calls within ~60s dedupe as retries (the original result replays); a later repeat executes. Pass a unique idempotencyKey to force or extend that safety.',
    requiredScope: 'services:write',
    inputSchema: {
      id,
      dryRun: z.boolean().optional().describe('Preview the plan without executing it (not cached).'),
    },
    buildUrl: (a) =>
      `/api/deployment-plans/${seg(a.id)}/execute${a.dryRun ? '?dryRun=true' : ''}`,
  }),
  writeTool({
    name: 'restart_deployment',
    title: 'Restart deployment',
    description:
      'Restart the container backing a specific deployment. DESTRUCTIVE: bounces the running container. Identical calls within ~60s dedupe as retries (the original result replays); a later repeat executes. Pass a unique idempotencyKey to force or extend that safety.',
    requiredScope: 'services:write',
    inputSchema: {
      id,
      depId: z.string().min(1).describe('ServiceDeployment id. Get it from get_service.'),
    },
    buildUrl: (a) =>
      `/api/services/${seg(a.id)}/deployments/${seg(a.depId)}/restart`,
  }),
  writeTool({
    name: 'rollback_deployment_plan',
    title: 'Rollback deployment plan',
    description:
      'Manually trigger rollback for a completed or failed deployment plan. DESTRUCTIVE: re-deploys previous images. Identical calls within ~60s dedupe as retries (the original result replays); a later repeat executes. Pass a unique idempotencyKey to force or extend that safety.',
    requiredScope: 'services:write',
    inputSchema: { id },
    buildUrl: (a) => `/api/deployment-plans/${seg(a.id)}/rollback`,
  }),
  writeTool({
    name: 'run_database_backup',
    title: 'Run database backup',
    description:
      'Trigger a backup for a database (requires operator role). Identical calls within ~60s dedupe as retries (the original result replays); a later repeat runs a NEW backup. Pass a unique idempotencyKey to force or extend that safety.',
    requiredScope: 'services:write',
    inputSchema: { id },
    buildUrl: (a) => `/api/databases/${seg(a.id)}/backups`,
  }),
  writeTool({
    name: 'sync_config_file',
    title: 'Sync config file',
    description:
      'Sync a config file to every (service, server) attachment (requires operator role). Pass dryRun=true for a non-mutating diff preview (previews are never cached and always recompute). For a real sync, identical calls within ~60s dedupe as retries (the original result replays); a later repeat executes. Pass a unique idempotencyKey to force or extend that safety.',
    requiredScope: 'services:write',
    inputSchema: {
      id,
      dryRun: z.boolean().optional().describe('Preview the diff without writing to hosts (not cached).'),
    },
    buildUrl: (a) =>
      `/api/config-files/${seg(a.id)}/sync-all${a.dryRun ? '?dryRun=true' : ''}`,
  }),
];

/** The full tool registry: meta + read + write groups. */
export const ALL_TOOLS: McpToolDef[] = [getCapabilitiesTool, ...readTools, ...writeTools];
