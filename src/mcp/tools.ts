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

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { appVersion } from '../lib/version.js';
import { computeScopes } from '../lib/scopes.js';
import { canonicalizeJson } from '../lib/canonical-json.js';
import { injectApi, type InjectApiResult } from './inject.js';
import { redactSensitive } from './redact.js';
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

/**
 * Wrap any JSON-serializable value as a passthrough MCP text result. The value is
 * first run through `redactSensitive` (FIX 1) so NO secret-named field (encrypted
 * ciphertext, nonces/IVs, token hashes, raw SSH/agent tokens) can ever leave the
 * MCP boundary — a defense-in-depth net independent of route behavior. Shared by
 * the tool factories AND the resource reads (resources.ts) so success formatting
 * and redaction are identical everywhere.
 */
export function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(redactSensitive(value), null, 2) }] };
}

/**
 * Map a non-ok `injectApi` result to an MCP error result, LOSSLESSLY: the HTTP
 * status plus the canonical envelope's `code`, `message`, and (when present)
 * `field` / `hint` are all surfaced so an agent can self-correct (e.g. fix the
 * offending field, or follow the hint). For a non-envelope error body we fall
 * back to the status and any string message. Used by BOTH the read and write
 * factories so the mapping is identical everywhere.
 */
export function mapResult(res: InjectApiResult): McpToolResult {
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
 *
 * We assemble the canonical input string (toolName + bucket + canonicalJSON(args))
 * and hash it DIRECTLY in one pass — `canonicalizeJson` already produces a stable
 * string, so re-canonicalizing it (e.g. via `hashCanonicalBody`, which would wrap
 * the whole string in JSON quotes) would only add a redundant transform. The key
 * stays fully deterministic and sensitive to tool/args/window exactly as before.
 */
export function deriveIdempotencyKey(toolName: string, args: Record<string, unknown>): string {
  const { idempotencyKey: _omit, ...rest } = args;
  void _omit;
  const timeBucket = Math.floor(Date.now() / IDEMPOTENCY_DEDUP_WINDOW_MS);
  return createHash('sha256')
    .update(`${toolName}:${timeBucket}:${canonicalizeJson(rest)}`)
    .digest('hex');
}

/**
 * URL-segment encoder. Coerces to string and percent-encodes so an id/value
 * interpolated into a path can never break out of its segment or inject query
 * syntax. Used by every `buildUrl` so safe encoding is the default and a future
 * tool can't accidentally drop it.
 */
export const seg = (v: unknown): string => encodeURIComponent(String(v));

/**
 * Append an optional query string to `base`. For each key in `keys`, if the arg
 * is neither `undefined` nor `null` it is String()-coerced and added as a query
 * param; otherwise it is skipped. Returns `base` unchanged when no param is set,
 * else `base?<qs>`. Shared by every `buildUrl` with optional query filters so the
 * "skip null/undefined, coerce, join" idiom lives in one place.
 */
export function appendQuery(
  base: string,
  args: Record<string, unknown>,
  keys: readonly string[]
): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const v = args[key];
    if (v !== undefined && v !== null) params.set(key, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

/**
 * Build a read tool: GETs the URL produced by `buildUrl(args)` and returns the
 * API body verbatim (or an MCP error result on non-2xx). `transform` optionally
 * post-processes the parsed body (used to strip var values / credential fields).
 *
 * `envScoped` declares whether the backing route is reachable by an
 * environment-scoped API token: `true` for env routes (`/api/environments/:envId/...`,
 * `GET /api/environments`, `GET /api/environments/:id`) and no-scope routes
 * (`/health`); `false` for global routes (`/api/servers/:id`, `/api/audit-logs`,
 * …), which always FORBIDDEN_SCOPE for such a token. See `McpToolDef.envScoped`.
 *
 * `requiredScope` defaults to `null` (every valid token has `*:read`). Set it to
 * an admin scope (`admin:*`, `tokens:manage`) for a read whose backing route is
 * `requireAdmin`-gated, so the advertised list stays TRUTHFUL: a non-admin token
 * wouldn't be able to call the route, so the tool is withheld from it.
 */
function readTool(opts: {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  buildUrl: (args: Record<string, unknown>) => string;
  envScoped: boolean;
  requiredScope?: string | null;
  transform?: (body: unknown) => unknown;
}): McpToolDef {
  return {
    name: opts.name,
    title: opts.title,
    description: opts.description,
    inputSchema: opts.inputSchema,
    requiredScope: opts.requiredScope ?? null, // default: every valid token has *:read
    destructive: false,
    readOnly: true,
    envScoped: opts.envScoped,
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
    // Every write tool targets a GLOBAL route (no `:envId` in the path), so it
    // always FORBIDDEN_SCOPEs for an env-scoped token — never env-scoped.
    envScoped: false,
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
    envScoped: true, // GET /api/environments — scope-exempt (returns the token's allowlist)
  }),
  readTool({
    name: 'get_environment',
    title: 'Get environment',
    description: 'Get a single environment by id.',
    inputSchema: { id },
    buildUrl: (a) => `/api/environments/${seg(a.id)}`,
    envScoped: true, // GET /api/environments/:id — enforceTokenScope resolves :id as the envId
  }),
  readTool({
    name: 'list_servers',
    title: 'List servers',
    description: 'List servers in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/servers`,
    envScoped: true, // /api/environments/:envId/servers — env route
  }),
  readTool({
    name: 'get_server',
    title: 'Get server',
    description:
      'Get a single server by id, including its cached last-health-check fields. Pass includeServices=true to also list its deployments.',
    inputSchema: { id, includeServices: z.boolean().optional().describe('Include the flattened services array.') },
    buildUrl: (a) =>
      `/api/servers/${seg(a.id)}${a.includeServices ? '?include=services' : ''}`,
    envScoped: false, // /api/servers/:id — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'get_server_health',
    title: 'Get health status',
    description:
      'Get the current cached health status of all servers, services, and databases in an environment (read-only; reads denormalized columns, never triggers a live SSH check).',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/health-status`,
    envScoped: true, // /api/environments/:envId/health-status — env route
  }),
  readTool({
    name: 'list_services',
    title: 'List services',
    description: 'List service templates in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/services`,
    envScoped: true, // /api/environments/:envId/services — env route
  }),
  readTool({
    name: 'get_service',
    title: 'Get service',
    description: 'Get a single service template by id, including its deployments.',
    inputSchema: { id },
    buildUrl: (a) => `/api/services/${seg(a.id)}`,
    envScoped: false, // /api/services/:id — global route (FORBIDDEN_SCOPE for env-scoped tokens)
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
    envScoped: false, // /api/services/:id/deployments/:depId/logs — global route
  }),
  readTool({
    name: 'list_config_files',
    title: 'List config files',
    description: 'List config files in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/config-files`,
    envScoped: true, // /api/environments/:envId/config-files — env route
  }),
  readTool({
    name: 'get_config_file',
    title: 'Get config file',
    description: 'Get a single config file by id (includes its content).',
    inputSchema: { id },
    buildUrl: (a) => `/api/config-files/${seg(a.id)}`,
    envScoped: false, // /api/config-files/:id — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'list_config_fragments',
    title: 'List config fragments',
    description: 'List reusable config fragments in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/config-fragments`,
    envScoped: true, // /api/environments/:envId/config-fragments — env route
  }),
  readTool({
    name: 'list_secrets',
    title: 'List secrets',
    description:
      'List secret keys and metadata (usage info) in an environment. Decrypted secret VALUES are never returned by this tool.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/secrets`,
    envScoped: true, // /api/environments/:envId/secrets — env route
  }),
  readTool({
    name: 'list_vars',
    title: 'List vars',
    description:
      'List variable keys, descriptions, and usage info in an environment. Variable VALUES are intentionally stripped from this tool’s output.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/vars`,
    envScoped: true, // /api/environments/:envId/vars — env route
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
    envScoped: false, // /api/servers/:id/metrics — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'get_service_metrics',
    title: 'Get service metrics',
    description: 'Get recent metrics samples for a service.',
    inputSchema: { id },
    buildUrl: (a) => `/api/services/${seg(a.id)}/metrics`,
    envScoped: false, // /api/services/:id/metrics — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'get_metrics_history',
    title: 'Get metrics history',
    description: 'Get aggregated server metrics history for an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/metrics/history`,
    envScoped: true, // /api/environments/:envId/metrics/history — env route
  }),
  readTool({
    name: 'list_health_checks',
    title: 'List health-check logs',
    description: 'List recent health-check log entries for an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/health-logs`,
    envScoped: true, // /api/environments/:envId/health-logs — env route
  }),
  readTool({
    name: 'get_deployments',
    title: 'Get deployment history',
    description: 'Get the deployment history for a service template.',
    inputSchema: { id },
    buildUrl: (a) => `/api/services/${seg(a.id)}/deployments-history`,
    envScoped: false, // /api/services/:id/deployments-history — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'list_deployment_plans',
    title: 'List deployment plans',
    description: 'List deployment plans for an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/deployment-plans`,
    envScoped: true, // /api/environments/:envId/deployment-plans — env route
  }),
  readTool({
    name: 'get_deployment_plan',
    title: 'Get deployment plan',
    description: 'Get a single deployment plan by id.',
    inputSchema: { id },
    buildUrl: (a) => `/api/deployment-plans/${seg(a.id)}`,
    envScoped: false, // /api/deployment-plans/:id — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'get_drift',
    title: 'Get server drift',
    description:
      'Compute configuration drift between BridgePort’s stored view and actual host state for every deployment on a server (read-only — does not change anything). COST: performs a LIVE query to the target host over SSH/Docker (not a cached read) — slower and not free, so avoid tight polling.',
    inputSchema: { id },
    buildUrl: (a) => `/api/servers/${seg(a.id)}/drift`,
    envScoped: false, // /api/servers/:id/drift — global per-server route (FORBIDDEN_SCOPE for env-scoped tokens)
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
    buildUrl: (a) =>
      appendQuery('/api/audit-logs', a, [
        'environmentId',
        'resourceType',
        'resourceId',
        'action',
        'limit',
        'offset',
      ]),
    envScoped: false, // /api/audit-logs — global route (FORBIDDEN_SCOPE for env-scoped tokens, even with an environmentId filter)
  }),
  readTool({
    name: 'get_version',
    title: 'Get version',
    description: 'Get the running BridgePort app, bundled agent, and CLI versions.',
    inputSchema: {},
    // There is no /api/version route (#199 shipped as policy docs, not an
    // endpoint); /health returns version/bundledAgentVersion/cliVersion.
    buildUrl: () => '/health',
    envScoped: true, // /health — unauthenticated/no-scope route (always reachable)
  }),

  // ---- Databases (metadata only; credentials are never returned by the route:
  // the service projects `hasCredentials` and omits encryptedCredentials) ----
  readTool({
    name: 'list_databases',
    title: 'List databases',
    description:
      'List databases in an environment (metadata, backup config, monitoring state). Connection credentials are never returned — only a hasCredentials flag.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/databases`,
    envScoped: true, // /api/environments/:envId/databases — env route
  }),
  readTool({
    name: 'get_database',
    title: 'Get database',
    description:
      'Get a single database by id (metadata, backup config, monitoring state). Connection credentials are never returned — only a hasCredentials flag.',
    inputSchema: { id },
    buildUrl: (a) => `/api/databases/${seg(a.id)}`,
    envScoped: false, // /api/databases/:id — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'list_database_backups',
    title: 'List database backups',
    description: 'List backup history for a database (status, size, timestamps).',
    inputSchema: {
      id,
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 50).'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0).'),
    },
    buildUrl: (a) => appendQuery(`/api/databases/${seg(a.id)}/backups`, a, ['limit', 'offset']),
    envScoped: false, // /api/databases/:id/backups — global route
  }),

  // ---- Notifications ----
  readTool({
    name: 'list_notifications',
    title: 'List notifications',
    description: 'List in-app notifications for the calling principal.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 50).'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0).'),
      unreadOnly: z.boolean().optional().describe('Only return unread notifications.'),
      environmentId: z.string().min(1).optional().describe('Filter by environment id.'),
      category: z.enum(['user', 'system']).optional().describe('Filter by category.'),
    },
    buildUrl: (a) =>
      appendQuery('/api/notifications', a, [
        'limit',
        'offset',
        'unreadOnly',
        'environmentId',
        'category',
      ]),
    envScoped: false, // /api/notifications — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),

  // ---- Registries (metadata only; the route projects hasToken/hasPassword and
  // NEVER returns encrypted blobs or decrypted credentials) ----
  readTool({
    name: 'list_registries',
    title: 'List registry connections',
    description:
      'List container-registry connections in an environment (type, URL, prefix, defaults). Credentials are NEVER returned — only hasToken/hasPassword booleans and the (non-secret) username.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/registries`,
    envScoped: true, // /api/environments/:envId/registries — env route
  }),
  readTool({
    name: 'get_registry',
    title: 'Get registry connection',
    description:
      'Get a single registry connection by id (type, URL, prefix, defaults). Credentials are NEVER returned — only hasToken/hasPassword booleans and the (non-secret) username.',
    inputSchema: { id },
    buildUrl: (a) => `/api/registries/${seg(a.id)}`,
    envScoped: false, // /api/registries/:id — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),

  // ---- Topology ----
  readTool({
    name: 'get_topology',
    title: 'Get topology diagram',
    description:
      'Export the environment topology (servers, services, databases, external entities, and their connections) as a Mermaid graph.',
    inputSchema: { environmentId: z.string().min(1).describe('Environment id (cuid).') },
    buildUrl: (a) => `/api/diagram-export?environmentId=${seg(a.environmentId)}&format=mermaid`,
    envScoped: false, // /api/diagram-export — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'list_connections',
    title: 'List topology connections',
    description: 'List the topology connections (edges) between nodes in an environment.',
    inputSchema: { environmentId: z.string().min(1).describe('Environment id (cuid).') },
    buildUrl: (a) => `/api/connections?environmentId=${seg(a.environmentId)}`,
    envScoped: false, // /api/connections — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'list_external_entities',
    title: 'List external entities',
    description:
      'List external topology entities (CDNs, clients, third-party deps) placed on an environment’s diagram.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/external-entities`,
    envScoped: true, // /api/environments/:envId/external-entities — env route
  }),
  readTool({
    name: 'list_server_clusters',
    title: 'List server clusters',
    description: 'List server clusters (logical server groupings) in an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/server-clusters`,
    envScoped: true, // /api/environments/:envId/server-clusters — env route
  }),

  // ---- Service dependencies ----
  readTool({
    name: 'get_service_dependencies',
    title: 'Get service dependencies',
    description: 'Get a service’s dependencies and dependents (the services it relies on / that rely on it).',
    inputSchema: { id },
    buildUrl: (a) => `/api/services/${seg(a.id)}/dependencies`,
    envScoped: false, // /api/services/:id/dependencies — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'get_dependency_graph',
    title: 'Get dependency graph',
    description:
      'Get the full service dependency graph (nodes, edges) and the computed deployment order for an environment.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/dependency-graph`,
    envScoped: true, // /api/environments/:envId/dependency-graph — env route
  }),

  // ---- Container images ----
  readTool({
    name: 'list_container_images',
    title: 'List container images',
    description: 'List container images tracked in an environment (latest digest, best tag, update availability).',
    inputSchema: {
      envId,
      limit: z.number().int().min(1).max(500).optional().describe('Max rows.'),
      offset: z.number().int().min(0).optional().describe('Pagination offset.'),
    },
    buildUrl: (a) =>
      appendQuery(`/api/environments/${seg(a.envId)}/container-images`, a, ['limit', 'offset']),
    envScoped: true, // /api/environments/:envId/container-images — env route
  }),
  readTool({
    name: 'get_container_image',
    title: 'Get container image',
    description: 'Get a single container image by id, including its digests and linked services.',
    inputSchema: { id },
    buildUrl: (a) => `/api/container-images/${seg(a.id)}`,
    envScoped: false, // /api/container-images/:id — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'list_image_digests',
    title: 'List image digests',
    description: 'List the discovered manifest digests for a container image (paginated).',
    inputSchema: {
      id,
      limit: z.number().int().min(1).max(500).optional().describe('Max rows (default 20).'),
      offset: z.number().int().min(0).optional().describe('Pagination offset (default 0).'),
    },
    buildUrl: (a) =>
      appendQuery(`/api/container-images/${seg(a.id)}/digests`, a, ['limit', 'offset']),
    envScoped: false, // /api/container-images/:id/digests — global route
  }),

  // ---- Compose ----
  readTool({
    name: 'get_service_compose',
    title: 'Get service compose preview',
    description:
      'Preview the generated deployment artifacts (rendered docker-compose + env files) for a service WITHOUT deploying. Resolved secret values are redacted in the preview.',
    inputSchema: { id },
    buildUrl: (a) => `/api/services/${seg(a.id)}/compose/preview`,
    envScoped: false, // /api/services/:id/compose/preview — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),

  // ---- Plugin types (any authenticated role; tagged admin in OpenAPI but the
  // GET routes only require `authenticate`) ----
  readTool({
    name: 'list_service_types',
    title: 'List service types',
    description: 'List plugin-defined service types and their predefined commands (shell, migrate, etc.).',
    inputSchema: {},
    buildUrl: () => '/api/settings/service-types',
    envScoped: false, // /api/settings/service-types — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'list_database_types',
    title: 'List database types',
    description:
      'List plugin-defined database types and their predefined commands. Connection-field definitions describe shape only (no credential values).',
    inputSchema: {},
    buildUrl: () => '/api/settings/database-types',
    envScoped: false, // /api/settings/database-types — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),

  // ---- Settings ----
  readTool({
    name: 'get_system_settings',
    title: 'Get system settings',
    description:
      'Get the global system settings (timeouts, retention, agent thresholds, public URL). The route masks the only secret field (the DO registry token → ****-suffixed), so no credential is returned.',
    inputSchema: {},
    buildUrl: () => '/api/settings/system',
    envScoped: false, // /api/settings/system — global route (FORBIDDEN_SCOPE for env-scoped tokens)
  }),
  readTool({
    name: 'get_environment_settings',
    title: 'Get environment settings',
    description:
      'Get an environment settings module (general | monitoring | operations | data | configuration) and its field definitions. ADMIN-ONLY (the route is requireAdmin-gated).',
    inputSchema: {
      id: z.string().min(1).describe('Environment id (cuid).'),
      module: z
        .enum(['general', 'monitoring', 'operations', 'data', 'configuration'])
        .describe('Which settings module to read.'),
    },
    buildUrl: (a) => `/api/environments/${seg(a.id)}/settings/${seg(a.module)}`,
    // /api/environments/:id/settings/:module — env-path route, but requireAdmin.
    // Reachable by an env-scoped ADMIN token for its own env, so envScoped:true.
    envScoped: true,
    requiredScope: 'admin:*',
  }),

  // ---- Webhook subscriptions (the service projects `hasSecret` and NEVER
  // returns the signing secret) ----
  readTool({
    name: 'list_webhook_subscriptions',
    title: 'List webhook subscriptions',
    description:
      'List env-scoped webhook subscriptions (URL, events, enabled state). The signing secret is NEVER returned — only a hasSecret boolean.',
    inputSchema: { envId },
    buildUrl: (a) => `/api/environments/${seg(a.envId)}/webhooks`,
    envScoped: true, // /api/environments/:envId/webhooks — env route
  }),

  // ---- Service accounts & API tokens (ADMIN / tokens:manage; metadata only,
  // NEVER token values or hashes) ----
  readTool({
    name: 'list_service_accounts',
    title: 'List service accounts',
    description:
      'List machine-identity service accounts (name, role, disabled flag, token count). ADMIN-ONLY. No token values or hashes are returned.',
    inputSchema: {},
    buildUrl: () => '/api/admin/service-accounts',
    envScoped: false, // /api/admin/service-accounts — global admin route
    requiredScope: 'admin:*',
  }),
  readTool({
    name: 'list_api_tokens',
    title: 'List API tokens',
    description:
      'List API tokens (name, non-secret prefix, role, scope, owner, expiry, last-used). Requires tokens:manage (admin). The token VALUE/HASH is NEVER returned — only the short prefix.',
    inputSchema: {
      ownerUserId: z.string().min(1).optional().describe('Filter by owning user id.'),
      ownerServiceAccountId: z.string().min(1).optional().describe('Filter by owning service-account id.'),
    },
    buildUrl: (a) => appendQuery('/api/admin/tokens', a, ['ownerUserId', 'ownerServiceAccountId']),
    envScoped: false, // /api/admin/tokens — global admin route
    requiredScope: 'tokens:manage',
  }),
];

// ---------------------------------------------------------------------------
// META TOOL — get_capabilities (synthesized, no inject)
// ---------------------------------------------------------------------------

/**
 * The common capabilities payload synthesized locally (no inject) from the
 * caller's session: the BridgePort version, the caller's derived scopes, and the
 * names of the tools registered for this session. Shared by the `get_capabilities`
 * tool AND the `capabilities` resource (resources.ts), which spreads it and adds
 * the registered resource names — so the two stay identical.
 */
export function buildCapabilities(ctx: {
  authUser: McpToolContext['authUser'];
  registeredToolNames: string[];
}): { version: string; scopes: string[]; tools: string[] } {
  return {
    version: appVersion,
    scopes: computeScopes(ctx.authUser),
    tools: ctx.registeredToolNames,
  };
}

const getCapabilitiesTool: McpToolDef = {
  name: 'get_capabilities',
  title: 'Get capabilities',
  description:
    'Describe what this MCP session can do: the BridgePort version, the caller’s derived scopes, and the names of the tools available to this token.',
  inputSchema: {},
  requiredScope: null,
  destructive: false,
  readOnly: true,
  // Synthesized locally (no inject), so no route to scope-check — usable by any
  // token, including an env-scoped one.
  envScoped: true,
  handler: async (_args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolResult> => {
    return jsonResult(buildCapabilities(ctx));
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
  writeTool({
    name: 'refresh_server_health',
    title: 'Refresh server health',
    description:
      'Trigger a LIVE health check against a server (requires operator role). COST: performs a live query to the target host over SSH (not a cached read) and updates the stored health columns. Identical calls within ~60s dedupe as retries (the original result replays); a later repeat runs a NEW live check. Pass a unique idempotencyKey to force or extend that safety.',
    requiredScope: 'services:write',
    inputSchema: { id },
    buildUrl: (a) => `/api/servers/${seg(a.id)}/health`,
  }),
  writeTool({
    name: 'execute_sync_batch',
    title: 'Execute sync batch',
    description:
      'Atomically sync MULTIPLE config files in one all-or-nothing (or best-effort) batch (requires operator role). DESTRUCTIVE: each op pushes config content to its attached hosts. With rollbackOnFailure=true (default) a mid-batch failure rolls back the already-applied ops. There is NO dry-run for batches — preview individual files with sync_config_file(dryRun=true) first. The route consumes the injected Idempotency-Key itself: identical calls within ~60s dedupe (the original batch result replays); a later repeat runs a NEW batch. Same key + a different body → conflict. Pass a unique idempotencyKey to force or extend that safety.',
    requiredScope: 'services:write',
    inputSchema: {
      operations: z
        .array(
          z.object({
            configFileId: z.string().min(1).describe('ConfigFile id to sync.'),
          })
        )
        .min(1)
        .max(50)
        .describe('1–50 config-file-sync operations. All files must live in the SAME environment.'),
      rollbackOnFailure: z
        .boolean()
        .optional()
        .describe('Roll back already-applied ops if a later op fails (default true).'),
    },
    buildUrl: () => '/api/sync/batch',
    buildBody: (a) => {
      const ops = Array.isArray(a.operations) ? (a.operations as Array<{ configFileId: string }>) : [];
      const body: Record<string, unknown> = {
        // The route's discriminated union requires the literal `type` tag.
        operations: ops.map((op) => ({ type: 'config-file-sync', configFileId: op.configFileId })),
      };
      if (a.rollbackOnFailure !== undefined) body.rollbackOnFailure = a.rollbackOnFailure;
      return body;
    },
  }),
];

/** The full tool registry: meta + read + write groups. */
export const ALL_TOOLS: McpToolDef[] = [getCapabilitiesTool, ...readTools, ...writeTools];

/**
 * Public, non-sensitive metadata for a single tool — the safe projection used by
 * the admin MCP status page (`GET /api/admin/mcp`). Deliberately OMITS the
 * `handler`/`buildUrl`/`buildBody` internals (which would leak the backing route
 * shapes); it exposes only the declarative annotations a viewer needs.
 */
export interface McpToolMetadata {
  name: string;
  title: string;
  description: string;
  requiredScope: string | null;
  destructive: boolean;
  readOnly: boolean;
  envScoped: boolean;
}

/** Project a tool def to its public metadata (drops handler/buildUrl internals). */
export function toToolMetadata(tool: McpToolDef): McpToolMetadata {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    requiredScope: tool.requiredScope,
    destructive: tool.destructive,
    readOnly: tool.readOnly,
    envScoped: tool.envScoped,
  };
}

/** Public metadata for every registered tool, in registry order. */
export function listToolMetadata(): McpToolMetadata[] {
  return ALL_TOOLS.map(toToolMetadata);
}
