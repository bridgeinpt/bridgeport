/**
 * Read-only field registry for PATCH endpoints (issue #127).
 *
 * BRIDGEPORT models carry plenty of *derived* fields — health/discovery status,
 * `lastCheckedAt`, agent-pushed metrics, etc. — that should never be updated by
 * a client. Historically these were silently dropped by the Zod update schema
 * (any extra fields fall off because `.strict()` was not used), so a PATCH that
 * tried to set `status: "healthy"` would return 200 OK and do nothing. That's a
 * "silent success" failure mode: the client thinks the change took effect but
 * the next GET shows the old value.
 *
 * This module makes those drops loud. `assertNoReadonlyFields(model, body)`
 * throws an `ApiError('READONLY_FIELD', …)` (HTTP 422) if the request body
 * names any field listed here. The check runs BEFORE Zod parsing so a PATCH
 * that mixes one readonly field with otherwise-valid fields is rejected
 * atomically — no partial application, no DB write.
 *
 * **Adding a model**: extend `ReadonlyModelName` and add an entry to
 * `READONLY_FIELDS_BY_MODEL`. Anything in the Prisma model that isn't user-editable
 * (id/timestamps, derived status, agent-pushed metrics, computed counters, FKs to
 * deployed-state) belongs here. The author also has the option to register a
 * per-field hint via `HINTS_BY_FIELD` keyed by `${model}.${field}` so the error
 * envelope carries actionable guidance (e.g. `service.exposedPorts` → "Change
 * the ports mapping in the compose file at composePath and redeploy.").
 */

import { ApiError } from './errors.js';

export type ReadonlyModelName =
  | 'service'
  | 'serviceDeployment'
  | 'server'
  | 'configFile'
  | 'configFragment'
  | 'containerImage'
  | 'database'
  | 'registry'
  | 'secret'
  | 'var'
  | 'user';

/**
 * Derived / system-managed fields per model.
 *
 * Discovery process for each entry: read the Prisma model and remove every
 * field that appears in the matching Zod update schema. The remainder are
 * candidates for this list. Cross-check the route handler — sometimes a field
 * is explicitly read but stripped before the Prisma update.
 */
export const READONLY_FIELDS_BY_MODEL: Record<ReadonlyModelName, ReadonlySet<string>> = {
  service: new Set([
    'id',
    'createdAt',
    'updatedAt',
    'environmentId',
    // Per-deployment runtime state used to live on Service (pre-2.0). Surface
    // these on the template PATCH for explicit feedback to callers still POSTing
    // legacy payloads.
    'status',
    'containerStatus',
    'healthStatus',
    'discoveryStatus',
    'exposedPorts',
    'lastCheckedAt',
    'lastDiscoveredAt',
    'lastDeployedAt',
    'lastHealthCheckAt',
    'lastHealthCheckStatus',
    'lastHealthCheckType',
    'lastHealthCheckDurationMs',
    'lastHealthCheckError',
    // Agent-reported fields are sourced from the agent push pipeline.
    'agentHealthSuccess',
    'agentHealthStatusCode',
    'agentHealthDurationMs',
    'agentHealthCheckedAt',
    'agentTcpCheckResults',
    'agentTcpCheckedAt',
    'agentCertCheckResults',
    'agentCertCheckedAt',
    // Per-deployment runtime ownership now lives on ServiceDeployment.
    // `serverId`, `containerName`, and `composePath` are still surfaced by the
    // Configure modal on the Service detail page (UI flattens deployment fields
    // onto the service for backwards compatibility) — leave them off this list
    // so the PATCH doesn't 422 on legitimate saves; Zod silently drops them and
    // the dedicated deployment PATCH endpoint owns the real write.
    'envOverrides',
    'imageDigestId',
  ]),
  serviceDeployment: new Set([
    'id',
    'createdAt',
    'updatedAt',
    'serviceId',
    'serverId',
    'status',
    'containerStatus',
    'healthStatus',
    'discoveryStatus',
    'exposedPorts',
    'lastCheckedAt',
    'lastDiscoveredAt',
    'lastDeployedAt',
    'lastHealthCheckAt',
    'lastHealthCheckStatus',
    'lastHealthCheckType',
    'lastHealthCheckDurationMs',
    'lastHealthCheckError',
    'imageDigestId',
    'agentHealthSuccess',
    'agentHealthStatusCode',
    'agentHealthDurationMs',
    'agentHealthCheckedAt',
    'agentTcpCheckResults',
    'agentTcpCheckedAt',
    'agentCertCheckResults',
    'agentCertCheckedAt',
  ]),
  server: new Set([
    'id',
    'createdAt',
    'updatedAt',
    'environmentId',
    'status',
    'serverType',
    'agentToken',
    'agentStatus',
    'agentVersion',
    'agentStatusChangedAt',
    'lastAgentPushAt',
    'lastCheckedAt',
    'lastHealthCheckAt',
    'lastHealthCheckStatus',
    'lastHealthCheckType',
    'lastHealthCheckDurationMs',
    'lastHealthCheckError',
    // metricsMode has a dedicated endpoint (`PATCH /api/servers/:id/metrics-mode`)
    // that runs deploy/remove side-effects; bypassing it via the generic PATCH
    // leaves the agent half-installed.
    'metricsMode',
  ]),
  configFile: new Set([
    'id',
    'createdAt',
    'updatedAt',
    'environmentId',
    // Settable on create only — server tracks them but the PATCH schema doesn't.
    // Treat as derived from upload metadata.
  ]),
  configFragment: new Set([
    'id',
    'createdAt',
    'updatedAt',
    'environmentId',
  ]),
  containerImage: new Set([
    'id',
    'createdAt',
    'updatedAt',
    'environmentId',
    // `imageName` IS user-editable from the Edit Image modal — leave it off so
    // the PATCH doesn't 422 on legitimate edits. (It's not in the Zod update
    // schema, so it's silently dropped today; surfacing that is a separate
    // concern from the no-silent-success initiative.)
    'lastCheckedAt',
    // updateAvailable is set by the scheduled update-check job; cleared on deploy.
    'updateAvailable',
    // deployedDigestId is set when a deploy succeeds; cleared never.
    'deployedDigestId',
  ]),
  database: new Set([
    'id',
    'createdAt',
    'updatedAt',
    'environmentId',
    // Encrypted secret material is set indirectly via `password`/`username` fields.
    'encryptedCredentials',
    'credentialsNonce',
    // Monitoring state is managed by the monitoring collector; configuration
    // lives on a dedicated endpoint (`PATCH /api/environments/:envId/databases/:id/monitoring`).
    'monitoringStatus',
    'lastCollectedAt',
    'lastMonitoringError',
  ]),
  registry: new Set([
    'id',
    'createdAt',
    'updatedAt',
    'environmentId',
    'encryptedToken',
    'tokenNonce',
    'encryptedPassword',
    'passwordNonce',
    'lastRefreshAt',
  ]),
  secret: new Set([
    'id',
    'createdAt',
    'updatedAt',
    'environmentId',
    'key',
    // Encrypted material is set indirectly via `value`.
    'encryptedValue',
    'nonce',
  ]),
  var: new Set([
    'id',
    'createdAt',
    'updatedAt',
    'environmentId',
    'key',
  ]),
  user: new Set([
    'id',
    'createdAt',
    'updatedAt',
    // Email/password have dedicated flows; surfacing them on the generic PATCH
    // produced a silent-success today (Zod drops them).
    'email',
    'passwordHash',
    'lastActiveAt',
  ]),
};

/**
 * Per-field hint keyed by `${model}.${field}`. Optional — `assertNoReadonlyFields`
 * falls back to a generic hint when no entry exists.
 */
export const HINTS_BY_FIELD: Record<string, string> = {
  'service.exposedPorts':
    'Exposed ports are discovered from the running container. Change the ports mapping in the compose file at composePath and redeploy.',
  'service.status':
    'Service status is derived from container + URL health checks. Trigger a health check via POST /api/services/:id/deployments/:depId/health to refresh.',
  'service.containerStatus':
    'Container status is derived from `docker inspect`. Trigger a health check or container discovery to refresh.',
  'service.discoveryStatus':
    'Discovery status flips automatically when the container is found/missing on a health check or scheduler scan.',
  'serviceDeployment.exposedPorts':
    'Exposed ports are discovered from the running container. Change the ports mapping in the compose file at composePath and redeploy.',
  'serviceDeployment.status':
    'Status is derived from container + URL health checks. Trigger a health check to refresh.',
  'serviceDeployment.containerStatus':
    'Container status is derived from `docker inspect`. Trigger a health check or container discovery to refresh.',
  'serviceDeployment.discoveryStatus':
    'Discovery status flips automatically when the container is found/missing on a health check or scheduler scan.',
  'server.status':
    'Server status is computed by `POST /api/servers/:id/health` and the scheduled health-check job.',
  'server.agentStatus':
    'Agent status is reported by the agent push pipeline; switch agent mode via PATCH /api/servers/:id/metrics-mode instead.',
  'server.metricsMode':
    'Use PATCH /api/servers/:id/metrics-mode — it deploys/removes the agent as part of the mode flip.',
  'containerImage.updateAvailable':
    'Set by the scheduled image-update check; cleared on successful deploy.',
  'containerImage.deployedDigestId':
    'Set when a deploy succeeds. Trigger a deploy to update.',
  'database.monitoringStatus':
    'Monitoring status is set by the monitoring collector; configure monitoring via PATCH /api/environments/:envId/databases/:id/monitoring.',
  'var.key':
    'Var keys cannot be changed after creation. Delete and recreate to change the key.',
  'var.environmentId':
    'Vars cannot be moved between environments. Delete and recreate in the target environment.',
  'user.email':
    'Email cannot be changed via this endpoint. Use the dedicated email-change flow.',
  'user.passwordHash':
    'Passwords must be changed via the password-reset / change-password flow, not the generic PATCH.',
  'user.lastActiveAt':
    'lastActiveAt is updated by the auth middleware on each authenticated request.',
};

const DEFAULT_HINT = 'This field is derived/system-managed and cannot be set via PATCH. Remove it from the request body.';

/**
 * Throws an `ApiError('READONLY_FIELD', …)` if `body` contains any field listed
 * in `READONLY_FIELDS_BY_MODEL[model]`. Multiple offenders surface the first one
 * via `field` so the envelope stays single-field (envelope shape only carries
 * one `field`); the message lists every offender to aid debugging.
 *
 * Safe to call with non-object/null bodies — they pass through (the Zod step
 * will produce its own VALIDATION_ERROR).
 */
export function assertNoReadonlyFields(model: ReadonlyModelName, body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;

  const readonlySet = READONLY_FIELDS_BY_MODEL[model];
  const offenders: string[] = [];
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (readonlySet.has(key)) offenders.push(key);
  }

  if (offenders.length === 0) return;

  const first = offenders[0];
  const hint = HINTS_BY_FIELD[`${model}.${first}`] ?? DEFAULT_HINT;
  const message =
    offenders.length === 1
      ? `Field "${first}" is read-only and cannot be set via PATCH.`
      : `Fields ${offenders.map((f) => `"${f}"`).join(', ')} are read-only and cannot be set via PATCH.`;

  throw new ApiError('READONLY_FIELD', message, {
    field: first,
    hint,
  });
}
