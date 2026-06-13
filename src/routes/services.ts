import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma, isPrismaNotFoundError } from '../lib/db.js';
import {
  deployService,
  deployServiceDryRun,
  deployServiceTemplate,
  getDeploymentHistory,
  getDeployment,
  getContainerLogs,
  getLatestImageTags,
} from '../services/deploy.js';
import { DockerSSH, createClientForServer, shellEscape } from '../lib/ssh.js';
import { runExclusive } from '../lib/keyed-lock.js';
import { getEnvironmentSshKey } from './environments.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { userIdForFk } from '../services/auth.js';
import { logHealthCheck } from '../services/health-checks.js';
import { checkServiceUpdate } from '../lib/scheduler.js';
import { determineHealthStatus, determineOverallStatus } from '../services/servers.js';
import { getSystemSettings } from '../services/system-settings.js';
import { HEALTH_STATUS, CONTAINER_STATUS, DISCOVERY_STATUS, HEALTH_CHECK_STATUS } from '../lib/constants.js';
import { validateBody, validateUpdateBody, findOrNotFound, handleUniqueConstraint, getErrorMessage, parsePaginationQuery, flattenDeploymentOntoService } from '../lib/helpers.js';
import { isDryRun } from '../lib/dry-run.js';
import { computeServiceDrift } from '../services/drift.js';
import { routeSchema } from '../lib/openapi-schema.js';

// --- secret sanitizers for the service-detail relations ---
//
// GET /api/services/:id eager-loads `environment`, `containerImage.registryConnection`,
// and `serviceDeployments[].server` as full Prisma rows. Those rows carry encrypted
// credential columns (Environment.sshPrivateKey, RegistryConnection.encrypted*/nonce*,
// Server.agentToken) which must NOT be serialized to clients. The route has no 200
// response schema, so without explicit stripping the raw rows leak. These helpers
// remove ONLY the secret columns and PRESERVE every non-secret field (id, name,
// hostname, etc.) so the UI keeps working; for the registry connection we mirror the
// registries endpoint's safe projection (hasToken/hasPassword booleans, never the
// encrypted blob — see src/services/registries.ts toOutput).

/** Strip Environment.sshPrivateKey (encrypted key material), keep all else. */
function sanitizeEnvironment<T extends Record<string, unknown>>(env: T): Omit<T, 'sshPrivateKey'> {
  const { sshPrivateKey: _sshPrivateKey, ...rest } = env;
  void _sshPrivateKey;
  return rest;
}

/** Strip Server.agentToken (per-server agent secret), keep all else. */
function sanitizeServer<T extends Record<string, unknown> | null>(
  server: T
): T extends null ? null : Omit<NonNullable<T>, 'agentToken'> {
  if (!server) return null as never;
  const { agentToken: _agentToken, ...rest } = server as Record<string, unknown>;
  void _agentToken;
  return rest as never;
}

/**
 * Strip RegistryConnection encrypted credential columns and surface presence
 * booleans, mirroring the registries endpoint's safe projection. Keeps all
 * non-secret metadata (id, name, type, registryUrl, repositoryPrefix, username,
 * isDefault, autoLinkPattern, …).
 */
function sanitizeRegistryConnection<T extends Record<string, unknown> | null>(
  conn: T
): (Record<string, unknown> & { hasToken: boolean; hasPassword: boolean }) | null {
  if (!conn) return null;
  const {
    encryptedToken,
    tokenNonce: _tokenNonce,
    encryptedPassword,
    passwordNonce: _passwordNonce,
    ...rest
  } = conn as Record<string, unknown>;
  void _tokenNonce;
  void _passwordNonce;
  return { ...rest, hasToken: !!encryptedToken, hasPassword: !!encryptedPassword };
}

// --- param schemas (documentation only) ---

const idParamsSchema = z.object({ id: z.string() });
const envIdParamsSchema = z.object({ envId: z.string() });
const serverIdParamsSchema = z.object({ serverId: z.string() });
const depParamsSchema = z.object({ id: z.string(), depId: z.string() });

// --- schemas ---

const createServiceSchema = z.object({
  name: z.string().min(1),
  containerImageId: z.string().min(1),
  imageTag: z.string().default('latest'),
  composeTemplate: z.string().nullable().optional(),
  healthCheckUrl: z.string().nullable().optional(),
  baseEnv: z.record(z.string(), z.string()).optional(),
  deployStrategy: z.enum(['sequential', 'parallel']).optional(),
});

const updateServiceSchema = z.object({
  name: z.string().min(1).optional(),
  containerImageId: z.string().min(1).optional(),
  imageTag: z.string().optional(),
  composeTemplate: z.string().nullable().optional(),
  healthCheckUrl: z.string().nullable().optional(),
  baseEnv: z.record(z.string(), z.string()).nullable().optional(),
  deployStrategy: z.enum(['sequential', 'parallel']).optional(),
  serviceTypeId: z.string().nullable().optional(),
  healthWaitMs: z.number().int().min(0).optional(),
  healthRetries: z.number().int().min(1).optional(),
  healthIntervalMs: z.number().int().min(0).optional(),
});

const createDeploymentSchema = z.object({
  serverId: z.string().min(1),
  containerName: z.string().min(1),
  composePath: z.string().nullable().optional(),
  envOverrides: z.record(z.string(), z.string()).optional(),
});

const updateDeploymentSchema = z.object({
  containerName: z.string().min(1).optional(),
  composePath: z.string().nullable().optional(),
  envOverrides: z.record(z.string(), z.string()).nullable().optional(),
});

const runCommandSchema = z.object({
  commandName: z.string().min(1),
});

const deploySchema = z.object({
  imageTag: z.string().optional(),
  generateArtifacts: z.boolean().default(true),
  pullImage: z.boolean().default(true),
  strategy: z.enum(['sequential', 'parallel']).optional(),
});

// --- helpers ---

function serializeJsonField(value: Record<string, string> | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return JSON.stringify(value);
}

export async function serviceRoutes(fastify: FastifyInstance): Promise<void> {
  // --- LIST / GET ---

  // List services (templates) attached to a server via their deployments.
  fastify.get(
    '/api/servers/:serverId/services',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'List services deployed on a server',
        params: serverIdParamsSchema,
        errors: [401],
      }),
    },
    async (request) => {
      const { serverId } = request.params as { serverId: string };

      // omit lastHealthCheckError: the column is TEXT and can carry multi-KB
      // error messages. Polling after an incident bloats responses unboundedly;
      // detail views still load it explicitly when needed.
      const deployments = await prisma.serviceDeployment.findMany({
        where: { serverId },
        omit: { lastHealthCheckError: true },
        include: { service: { include: { containerImage: true, serviceType: true } } },
        orderBy: { service: { name: 'asc' } },
      });

      // Return as service rows (with deployment runtime flattened on) for backwards compatibility.
      const services = deployments.map((d) => flattenDeploymentOntoService(d));
      return { services };
    }
  );

  // List services (templates) for an environment.
  fastify.get(
    '/api/environments/:envId/services',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'List service templates in an environment',
        params: envIdParamsSchema,
        errors: [401],
      }),
    },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const { limit, offset } = parsePaginationQuery(request.query as Record<string, unknown>);

      const where = { environmentId: envId };

      const [services, total] = await Promise.all([
        prisma.service.findMany({
          where,
          include: {
            containerImage: true,
            serviceType: true,
            serviceDeployments: {
              // See note on the per-server list above — keep large error blobs
              // out of paginated list responses. The cache lives on deployments.
              omit: { lastHealthCheckError: true },
              include: { server: { select: { id: true, name: true } } },
            },
          },
          orderBy: { name: 'asc' },
          take: limit,
          skip: offset,
        }),
        prisma.service.count({ where }),
      ]);

      // Back-compat: surface the first deployment's runtime/server on the service row.
      const enriched = services.map((s) => {
        const first = s.serviceDeployments[0];
        if (!first) return s;
        return {
          ...s,
          containerName: first.containerName,
          composePath: first.composePath,
          status: first.status,
          containerStatus: first.containerStatus,
          healthStatus: first.healthStatus,
          exposedPorts: first.exposedPorts,
          discoveryStatus: first.discoveryStatus,
          lastCheckedAt: first.lastCheckedAt,
          lastDiscoveredAt: first.lastDiscoveredAt,
          serverId: first.serverId,
          server: first.server,
        };
      });

      return { services: enriched, total };
    }
  );

  // Service types in use across an environment, with per-type service counts.
  // Populates the Services list filter chips. Services with no serviceTypeId are
  // excluded here — the UI surfaces a separate "No type" chip computed client-side.
  fastify.get(
    '/api/environments/:envId/services/type-counts',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Count services per service type within an environment',
        params: envIdParamsSchema,
        errors: [401],
      }),
    },
    async (request) => {
      const { envId } = request.params as { envId: string };

      const grouped = await prisma.service.groupBy({
        by: ['serviceTypeId'],
        where: { environmentId: envId, serviceTypeId: { not: null } },
        _count: { _all: true },
      });

      const ids = grouped
        .map((row) => row.serviceTypeId)
        .filter((id): id is string => id !== null);

      const serviceTypes = ids.length
        ? await prisma.serviceType.findMany({
            where: { id: { in: ids } },
            select: { id: true, displayName: true },
          })
        : [];
      const displayNameById = new Map(serviceTypes.map((t) => [t.id, t.displayName]));

      const types = grouped
        .filter((row): row is typeof row & { serviceTypeId: string } => row.serviceTypeId !== null)
        .map((row) => ({
          id: row.serviceTypeId,
          // Fall back to the id if the ServiceType was deleted out from under a
          // lingering FK (SetNull should prevent this, but stay defensive).
          displayName: displayNameById.get(row.serviceTypeId) ?? row.serviceTypeId,
          count: row._count._all,
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));

      return { types };
    }
  );

  // Get service template
  fastify.get(
    '/api/services/:id',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Get a service template with its deployments',
        params: idParamsSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await findOrNotFound(
        prisma.service.findUnique({
          where: { id },
          include: {
            environment: true,
            serviceType: {
              include: {
                commands: { orderBy: { sortOrder: 'asc' } },
              },
            },
            containerImage: {
              include: { registryConnection: true },
            },
            serviceDeployments: {
              include: { server: true },
            },
          },
        }),
        'Service',
        reply
      );
      if (!service) return;

      // Strip encrypted credential columns from the eager-loaded relations before
      // returning (this route has no 200 response schema, so raw rows would leak):
      // Environment.sshPrivateKey, containerImage.registryConnection.encrypted*/nonce*,
      // and every serviceDeployments[].server.agentToken. Non-secret fields are kept.
      const safeService = {
        ...service,
        environment: sanitizeEnvironment(service.environment),
        containerImage: service.containerImage
          ? {
              ...service.containerImage,
              registryConnection: sanitizeRegistryConnection(service.containerImage.registryConnection),
            }
          : service.containerImage,
        serviceDeployments: service.serviceDeployments.map((d) => ({
          ...d,
          server: sanitizeServer(d.server),
        })),
      };

      // Back-compat flatten: the legacy UI consumes top-level container/server fields.
      // Surface the first deployment's runtime state on the service object so existing
      // components keep working. New UI code reads `serviceDeployments` directly.
      const first = safeService.serviceDeployments[0];
      const enriched = first
        ? {
            ...safeService,
            containerName: first.containerName,
            composePath: first.composePath,
            status: first.status,
            containerStatus: first.containerStatus,
            healthStatus: first.healthStatus,
            exposedPorts: first.exposedPorts,
            discoveryStatus: first.discoveryStatus,
            lastCheckedAt: first.lastCheckedAt,
            lastDiscoveredAt: first.lastDiscoveredAt,
            serverId: first.serverId,
            server: first.server,
            agentHealthSuccess: first.agentHealthSuccess,
            agentHealthStatusCode: first.agentHealthStatusCode,
            agentHealthDurationMs: first.agentHealthDurationMs,
            agentHealthCheckedAt: first.agentHealthCheckedAt,
            agentTcpCheckResults: first.agentTcpCheckResults,
            agentTcpCheckedAt: first.agentTcpCheckedAt,
            agentCertCheckResults: first.agentCertCheckResults,
            agentCertCheckedAt: first.agentCertCheckedAt,
          }
        : safeService;

      return { service: enriched };
    }
  );

  // Drift: diff BRIDGEPORT's stored view of a service against actual host state.
  // Read-only (viewer-accessible) — never mutates host state. Results are keyed
  // per-deployment since runtime lives on ServiceDeployment.
  fastify.get(
    '/api/services/:id/drift',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Compute configuration drift for a service across its deployments',
        params: idParamsSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await computeServiceDrift(id);
      if (!result) {
        return reply.code(404).send({ error: 'Service not found' });
      }
      return result;
    }
  );

  // --- CREATE / UPDATE / DELETE template ---

  // Create service template (decoupled from servers).
  fastify.post(
    '/api/environments/:envId/services',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Create a service template in an environment',
        params: envIdParamsSchema,
        body: createServiceSchema,
        errors: [400, 401, 409],
      }),
    },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(createServiceSchema, request, reply);
      if (!body) return;

      try {
        // Verify containerImage exists and is in the same environment
        const containerImage = await prisma.containerImage.findUnique({
          where: { id: body.containerImageId },
        });
        if (!containerImage) {
          return reply.code(400).send({ error: 'Container image not found' });
        }
        if (containerImage.environmentId !== envId) {
          return reply.code(400).send({ error: 'Container image must be in the same environment' });
        }

        const service = await prisma.service.create({
          data: {
            name: body.name,
            containerImageId: body.containerImageId,
            imageTag: body.imageTag,
            composeTemplate: body.composeTemplate ?? null,
            healthCheckUrl: body.healthCheckUrl ?? null,
            baseEnv: body.baseEnv ? JSON.stringify(body.baseEnv) : null,
            deployStrategy: body.deployStrategy ?? 'sequential',
            environmentId: envId,
          },
        });

        await logAudit({
          action: 'create',
          resourceType: 'service',
          resourceId: service.id,
          resourceName: service.name,
          details: { containerImageId: service.containerImageId },
          ...actorFrom(request),
          environmentId: envId,
        });

        return { service };
      } catch (error) {
        if (handleUniqueConstraint(error, 'Service already exists', reply)) return;
        throw error;
      }
    }
  );

  // Legacy create-under-server endpoint: creates the template (env-scoped) and a deployment row.
  // Retained for backwards compatibility with the CLI / older UI flows.
  fastify.post(
    '/api/servers/:serverId/services',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Create a service template and attach a deployment on a server (legacy)',
        params: serverIdParamsSchema,
        // Mirrors the validateBody(...) call below (single source: the same Zod
        // expression). Docs-only; runtime validation stays with validateBody.
        body: createServiceSchema.extend({ containerName: z.string().min(1).optional() }),
        errors: [400, 401, 404, 409],
      }),
    },
    async (request, reply) => {
      const { serverId } = request.params as { serverId: string };
      const body = validateBody(
        createServiceSchema.extend({ containerName: z.string().min(1).optional() }),
        request,
        reply
      );
      if (!body) return;

      try {
        const server = await prisma.server.findUnique({ where: { id: serverId } });
        if (!server) return reply.code(404).send({ error: 'Server not found' });

        const containerImage = await prisma.containerImage.findUnique({
          where: { id: body.containerImageId },
        });
        if (!containerImage) {
          return reply.code(400).send({ error: 'Container image not found' });
        }
        if (containerImage.environmentId !== server.environmentId) {
          return reply.code(400).send({ error: 'Container image must be in the same environment' });
        }

        // Legacy CLI flow attaches the same service name to multiple servers:
        //   bridgeport services create --server A --name redis ...
        //   bridgeport services create --server B --name redis ...
        // Post-2.0 the unique constraint is (environmentId, name) at the
        // template level, so the second call would explode. If a template with
        // this name already exists in the environment with a MATCHING
        // containerImageId, attach a new ServiceDeployment to it instead of
        // creating a duplicate template. If the existing template uses a
        // different image, fail with 409 — the caller must reconcile.
        const existingService = await prisma.service.findUnique({
          where: { environmentId_name: { environmentId: server.environmentId, name: body.name } },
        });

        let service = existingService;
        if (existingService) {
          if (existingService.containerImageId !== body.containerImageId) {
            return reply.code(409).send({
              error: `A service named "${body.name}" already exists in this environment with a different container image. Use a different name or update the existing service.`,
            });
          }
        } else {
          service = await prisma.service.create({
            data: {
              name: body.name,
              containerImageId: body.containerImageId,
              imageTag: body.imageTag,
              composeTemplate: body.composeTemplate ?? null,
              healthCheckUrl: body.healthCheckUrl ?? null,
              baseEnv: body.baseEnv ? JSON.stringify(body.baseEnv) : null,
              deployStrategy: body.deployStrategy ?? 'sequential',
              environmentId: server.environmentId,
            },
          });
        }

        const newDeployment = await prisma.serviceDeployment.create({
          data: {
            serviceId: service!.id,
            serverId: server.id,
            containerName: body.containerName ?? body.name,
            // First-time CLI attach: not deployed yet — keep it out of
            // scheduler health checks until the first deploy runs.
            discoveryStatus: DISCOVERY_STATUS.PENDING,
          },
        });

        await logAudit({
          action: existingService ? 'attach_deployment' : 'create',
          resourceType: 'service',
          resourceId: service!.id,
          resourceName: service!.name,
          details: {
            containerImageId: service!.containerImageId,
            serverId: server.id,
            serviceDeploymentId: newDeployment.id,
            reusedExistingTemplate: !!existingService,
          },
          ...actorFrom(request),
          environmentId: server.environmentId,
        });

        return { service };
      } catch (error) {
        if (handleUniqueConstraint(error, 'Service already exists', reply)) return;
        throw error;
      }
    }
  );

  // Update service template
  fastify.patch(
    '/api/services/:id',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Update a service template',
        params: idParamsSchema,
        body: updateServiceSchema,
        errors: [400, 401, 404, 422],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      // Rejects PATCH of read-only/derived fields (status, exposedPorts, etc.)
      // with 422 BEFORE any DB read/write — see src/lib/readonly-fields.ts.
      const body = validateUpdateBody(updateServiceSchema, 'service', request, reply);
      if (!body) return;

      try {
        const existing = await prisma.service.findUnique({
          where: { id },
        });
        const { baseEnv, ...rest } = body;
        const data: Record<string, unknown> = { ...rest };
        if (baseEnv !== undefined) {
          data.baseEnv = baseEnv === null ? null : JSON.stringify(baseEnv);
        }
        const service = await prisma.service.update({
          where: { id },
          data,
        });

        await logAudit({
          action: 'update',
          resourceType: 'service',
          resourceId: service.id,
          resourceName: service.name,
          details: { changes: body },
          ...actorFrom(request),
          environmentId: existing?.environmentId,
        });

        return { service };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Service not found' });
        }
        throw error;
      }
    }
  );

  // Delete service template (and cascade its deployments).
  fastify.delete(
    '/api/services/:id',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Delete a service template and cascade its deployments',
        params: idParamsSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const service = await prisma.service.findUnique({ where: { id } });
        await prisma.service.delete({ where: { id } });

        if (service) {
          await logAudit({
            action: 'delete',
            resourceType: 'service',
            resourceId: id,
            resourceName: service.name,
            ...actorFrom(request),
            environmentId: service.environmentId,
          });
        }

        return { success: true };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Service not found' });
        }
        throw error;
      }
    }
  );

  // --- ServiceDeployment CRUD ---

  // Add a deployment for an existing service template on a new server.
  fastify.post(
    '/api/services/:id/deployments',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Add a deployment of a service template on a server',
        params: idParamsSchema,
        body: createDeploymentSchema,
        errors: [400, 401, 404, 409],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(createDeploymentSchema, request, reply);
      if (!body) return;

      const service = await prisma.service.findUnique({ where: { id } });
      if (!service) return reply.code(404).send({ error: 'Service not found' });

      const server = await prisma.server.findUnique({ where: { id: body.serverId } });
      if (!server) return reply.code(400).send({ error: 'Server not found' });
      if (server.environmentId !== service.environmentId) {
        return reply.code(400).send({ error: 'Server must be in the same environment as the service' });
      }

      try {
        const deployment = await prisma.serviceDeployment.create({
          data: {
            serviceId: id,
            serverId: body.serverId,
            containerName: body.containerName,
            composePath: body.composePath ?? null,
            envOverrides: serializeJsonField(body.envOverrides) ?? null,
            // Newly attached deployments haven't been deployed yet. Mark them
            // pending so the scheduler's `discoveryStatus='found'` filter skips
            // them — otherwise we'd health-check a non-existent container and
            // fire false SYSTEM_CONTAINER_CRASH alerts. Flips to 'found' after
            // the first successful deploy or container discovery.
            discoveryStatus: DISCOVERY_STATUS.PENDING,
          },
        });

        await logAudit({
          action: 'create',
          resourceType: 'service_deployment',
          resourceId: deployment.id,
          resourceName: `${service.name}@${server.name}`,
          details: { serviceId: id, serverId: body.serverId, containerName: body.containerName },
          ...actorFrom(request),
          environmentId: service.environmentId,
        });

        return { deployment };
      } catch (error) {
        if (handleUniqueConstraint(error, 'Deployment for that server or container name already exists', reply)) return;
        throw error;
      }
    }
  );

  // Update a deployment (container name, compose path, env overrides).
  fastify.patch(
    '/api/services/:id/deployments/:depId',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Update a service deployment',
        params: depParamsSchema,
        body: updateDeploymentSchema,
        errors: [400, 401, 404, 409, 422],
      }),
    },
    async (request, reply) => {
      const { id, depId } = request.params as { id: string; depId: string };
      // Rejects PATCH of derived deployment fields (status, exposedPorts, agent*
      // results, etc.) before mutating the row — see src/lib/readonly-fields.ts.
      const body = validateUpdateBody(updateDeploymentSchema, 'serviceDeployment', request, reply);
      if (!body) return;

      try {
        const data: Record<string, unknown> = {};
        if (body.containerName !== undefined) data.containerName = body.containerName;
        if (body.composePath !== undefined) data.composePath = body.composePath;
        if (body.envOverrides !== undefined) {
          data.envOverrides = body.envOverrides === null ? null : JSON.stringify(body.envOverrides);
        }

        const deployment = await prisma.serviceDeployment.update({
          where: { id: depId },
          data,
          include: { service: true, server: true },
        });

        await logAudit({
          action: 'update',
          resourceType: 'service_deployment',
          resourceId: depId,
          resourceName: `${deployment.service.name}@${deployment.server.name}`,
          details: { changes: body, serviceId: id },
          ...actorFrom(request),
          environmentId: deployment.service.environmentId,
        });

        return { deployment };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Deployment not found' });
        }
        if (handleUniqueConstraint(error, 'Container name already in use on this server', reply)) return;
        throw error;
      }
    }
  );

  // Remove a deployment (does not remove the template).
  fastify.delete(
    '/api/services/:id/deployments/:depId',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Remove a service deployment (template is retained)',
        params: depParamsSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { id, depId } = request.params as { id: string; depId: string };

      try {
        const deployment = await prisma.serviceDeployment.findUnique({
          where: { id: depId },
          include: { service: true, server: true },
        });
        if (!deployment) return reply.code(404).send({ error: 'Deployment not found' });

        await prisma.serviceDeployment.delete({ where: { id: depId } });

        await logAudit({
          action: 'delete',
          resourceType: 'service_deployment',
          resourceId: depId,
          resourceName: `${deployment.service.name}@${deployment.server.name}`,
          details: { serviceId: id, serverId: deployment.serverId },
          ...actorFrom(request),
          environmentId: deployment.service.environmentId,
        });

        return { success: true };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Deployment not found' });
        }
        throw error;
      }
    }
  );

  // --- Deploy ---

  // Deploy a service template across all its deployments (sequential | parallel).
  fastify.post(
    '/api/services/:id/deploy',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Deploy a service template across all of its deployments',
        params: idParamsSchema,
        body: deploySchema,
        errors: [400, 401, 404, 500],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(deploySchema, request, reply);
      if (!body) return;

      const service = await prisma.service.findUnique({ where: { id } });
      if (!service) return reply.code(404).send({ error: 'Service not found' });

      try {
        const outcome = await deployServiceTemplate(
          id,
          request.authUser!.email,
          userIdForFk(request.authUser!),
          {
            imageTag: body.imageTag,
            generateArtifacts: body.generateArtifacts,
            pullImage: body.pullImage,
            strategy: body.strategy,
          }
        );

        // Surface zero-deployment template error as a 400 so CI/release
        // automation doesn't treat a no-op rollout as success.
        if (outcome.error) {
          await logAudit({
            action: 'deploy',
            resourceType: 'service',
            resourceId: id,
            resourceName: service.name,
            details: { imageTag: body.imageTag },
            success: false,
            error: outcome.error,
            ...actorFrom(request),
            environmentId: service.environmentId,
          });
          return reply.code(400).send({ error: outcome.error });
        }

        await logAudit({
          action: 'deploy',
          resourceType: 'service',
          resourceId: id,
          resourceName: service.name,
          details: {
            imageTag: body.imageTag || service.imageTag,
            strategy: body.strategy ?? service.deployStrategy,
            halted: outcome.halted,
            deploymentCount: outcome.results.length,
          },
          ...actorFrom(request),
          environmentId: service.environmentId,
        });

        return outcome;
      } catch (error) {
        const message = getErrorMessage(error, 'Deployment failed');

        await logAudit({
          action: 'deploy',
          resourceType: 'service',
          resourceId: id,
          resourceName: service.name,
          details: { imageTag: body.imageTag },
          success: false,
          error: message,
          ...actorFrom(request),
          environmentId: service.environmentId,
        });

        return reply.code(500).send({ error: message });
      }
    }
  );

  // Deploy a single ServiceDeployment (per-server target).
  fastify.post(
    '/api/services/:id/deployments/:depId/deploy',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Deploy a single service deployment (supports dry-run)',
        params: depParamsSchema,
        body: deploySchema,
        errors: [400, 401, 404, 500],
      }),
    },
    async (request, reply) => {
      const { id, depId } = request.params as { id: string; depId: string };
      const body = validateBody(deploySchema, request, reply);
      if (!body) return;

      const deployment = await prisma.serviceDeployment.findUnique({
        where: { id: depId },
        include: { service: true, server: true },
      });
      if (!deployment) return reply.code(404).send({ error: 'Deployment not found' });

      // Dry-run: return the report without creating a Deployment row, opening
      // an SSH session, or pulling the image. Audit the preview so operators
      // can see who probed which deployment.
      if (isDryRun(request)) {
        try {
          // Honor body.imageTag the same way the real path does — otherwise a
          // caller previewing "deploy v2.0" would still see the current
          // template tag in the rendered compose.
          const report = await deployServiceDryRun(depId, { imageTag: body.imageTag });
          await logAudit({
            action: 'deploy',
            resourceType: 'service_deployment',
            resourceId: depId,
            resourceName: `${deployment.service.name}@${deployment.server.name}`,
            details: { dryRun: true, imageTag: report.imageTag, serviceId: id },
            ...actorFrom(request),
            environmentId: deployment.service.environmentId,
          });
          return report;
        } catch (error) {
          const message = getErrorMessage(error, 'Dry-run failed');
          await logAudit({
            action: 'deploy',
            resourceType: 'service_deployment',
            resourceId: depId,
            resourceName: `${deployment.service.name}@${deployment.server.name}`,
            details: { dryRun: true, serviceId: id },
            success: false,
            error: message,
            ...actorFrom(request),
            environmentId: deployment.service.environmentId,
          });
          return reply.code(500).send({ error: message });
        }
      }

      try {
        const result = await deployService(
          depId,
          request.authUser!.email,
          userIdForFk(request.authUser!),
          {
            imageTag: body.imageTag,
            generateArtifacts: body.generateArtifacts,
            pullImage: body.pullImage,
          }
        );

        await logAudit({
          action: 'deploy',
          resourceType: 'service_deployment',
          resourceId: depId,
          resourceName: `${deployment.service.name}@${deployment.server.name}`,
          details: { imageTag: body.imageTag || deployment.service.imageTag, deploymentId: result.deployment?.id, serviceId: id },
          ...actorFrom(request),
          environmentId: deployment.service.environmentId,
        });

        return result;
      } catch (error) {
        const message = getErrorMessage(error, 'Deployment failed');

        await logAudit({
          action: 'deploy',
          resourceType: 'service_deployment',
          resourceId: depId,
          resourceName: `${deployment.service.name}@${deployment.server.name}`,
          details: { imageTag: body.imageTag, serviceId: id },
          success: false,
          error: message,
          ...actorFrom(request),
          environmentId: deployment.service.environmentId,
        });

        return reply.code(500).send({ error: message });
      }
    }
  );

  // --- History / Logs / Restart / Health ---

  // Get deployment history (per Service template)
  fastify.get(
    '/api/services/:id/deployments-history',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Get deployment history for a service template',
        params: idParamsSchema,
        errors: [401],
      }),
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };

      const deployments = await getDeploymentHistory(id, limit ? parseInt(limit) : 20);
      return { deployments };
    }
  );

  // Get single deployment
  fastify.get(
    '/api/deployments/:id',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Get a single deployment record',
        params: idParamsSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deployment = await findOrNotFound(getDeployment(id), 'Deployment', reply);
      if (!deployment) return;

      return { deployment };
    }
  );

  // Get container logs for a specific deployment.
  fastify.get(
    '/api/services/:id/deployments/:depId/logs',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Fetch recent container logs for a deployment',
        params: depParamsSchema,
        errors: [401, 500],
      }),
    },
    async (request, reply) => {
      const { depId } = request.params as { id: string; depId: string };
      const { tail, before } = request.query as { tail?: string; before?: string };

      try {
        // Fall back to admin-configured defaultLogLines when no explicit tail is given
        // or when the provided tail is unparseable / out of range.
        // Cap to 10000 to align with the admin setting's upper bound.
        const MAX_TAIL = 10000;
        let tailValue: number;
        const parsedTail = tail !== undefined ? parseInt(tail, 10) : NaN;
        if (Number.isFinite(parsedTail) && parsedTail >= 1) {
          tailValue = Math.min(parsedTail, MAX_TAIL);
        } else {
          const settings = await getSystemSettings();
          tailValue = settings.defaultLogLines;
        }

        // `-t` (timestamps) is always on so the UI can paginate via `before=<timestamp>`
        const logs = await getContainerLogs(depId, {
          tail: tailValue,
          until: before,
          timestamps: true,
        });
        return { logs };
      } catch (error) {
        const message = getErrorMessage(error, 'Failed to get logs');
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Stream container logs (SSE) for a specific deployment.
  fastify.get(
    '/api/services/:id/deployments/:depId/logs/stream',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Stream container logs for a deployment over SSE',
        params: depParamsSchema,
        errors: [400, 401, 404],
      }),
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { depId } = request.params as { id: string; depId: string };

      const deployment = await findOrNotFound(
        prisma.serviceDeployment.findUnique({
          where: { id: depId },
          include: { server: true },
        }),
        'Deployment',
        reply
      );
      if (!deployment) return;

      const { client, error } = await createClientForServer(
        deployment.server.hostname,
        deployment.server.environmentId,
        getEnvironmentSshKey,
        { serverType: deployment.server.serverType }
      );
      if (!client) {
        return reply.code(400).send({ error });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      try {
        await client.connect();

        const settings = await getSystemSettings();
        const defaultLogLines = settings.defaultLogLines;

        await client.execStream(
          `export PATH="/usr/local/bin:/usr/bin:$PATH" && docker logs -f --tail ${defaultLogLines} ${shellEscape(deployment.containerName)}`,
          (data, isStderr) => {
            const eventType = isStderr ? 'stderr' : 'stdout';
            reply.raw.write(`event: ${eventType}\n`);
            reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
          }
        );
      } catch (error) {
        const message = getErrorMessage(error, 'Stream error');
        reply.raw.write(`event: error\n`);
        reply.raw.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      } finally {
        client.disconnect();
        reply.raw.end();
      }
    }
  );

  // Get available image tags (template-scoped — tag is shared across deployments).
  fastify.get(
    '/api/services/:id/image-tags',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'List available image tags for a service template',
        params: idParamsSchema,
        errors: [401, 500],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const tags = await getLatestImageTags(id);
        return { tags };
      } catch (error) {
        const message = getErrorMessage(error, 'Failed to get tags');
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Restart a specific deployment's container
  fastify.post(
    '/api/services/:id/deployments/:depId/restart',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Restart the container backing a deployment',
        params: depParamsSchema,
        errors: [400, 401, 404, 500],
      }),
    },
    async (request, reply) => {
      const { id, depId } = request.params as { id: string; depId: string };

      const deployment = await findOrNotFound(
        prisma.serviceDeployment.findUnique({
          where: { id: depId },
          include: { server: true, service: { select: { name: true, environmentId: true } } },
        }),
        'Deployment',
        reply
      );
      if (!deployment) return;

      const { client, error } = await createClientForServer(
        deployment.server.hostname,
        deployment.server.environmentId,
        getEnvironmentSshKey,
        { serverType: deployment.server.serverType }
      );
      if (!client) {
        return reply.code(400).send({ error });
      }

      const docker = new DockerSSH(client);

      try {
        await client.connect();

        // When a service is deployed via compose, plain `docker restart` only
        // bounces the existing container — it does not re-read the compose
        // file or attached config files. Run `compose down` + `compose up
        // --force-recreate` so a NEW container is created and config files
        // are re-read. We deliberately do NOT regenerate compose artifacts
        // here: restart means "down + up with the current on-disk compose".
        if (deployment.composePath) {
          const composePath = deployment.composePath;
          // Same compose file can back multiple deployments — suppress dependency
          // cascade when shared (see deploy.ts), and serialize down+up per
          // (server, compose file) so a manual restart can't race a concurrent
          // deploy on the same file ("removal of container ... already in progress").
          const deploymentsOnComposeFile = await prisma.serviceDeployment.count({
            where: { serverId: deployment.serverId, composePath },
          });
          const sharedCompose = deploymentsOnComposeFile > 1;
          await runExclusive(`${deployment.serverId}::${composePath}`, async () => {
            await docker.composeDown(composePath, deployment.containerName);
            await docker.composeUp(composePath, deployment.containerName, true, sharedCompose);
          });
        } else {
          await docker.restartContainer(deployment.containerName);
        }

        await logAudit({
          action: 'restart',
          resourceType: 'service_deployment',
          resourceId: depId,
          resourceName: `${deployment.service.name}@${deployment.server.name}`,
          details: {
            containerName: deployment.containerName,
            serverName: deployment.server.name,
            serviceId: id,
            mode: deployment.composePath ? 'compose' : 'docker',
          },
          ...actorFrom(request),
          environmentId: deployment.service.environmentId,
        });

        return { success: true };
      } catch (error) {
        const message = getErrorMessage(error, 'Restart failed');

        await logAudit({
          action: 'restart',
          resourceType: 'service_deployment',
          resourceId: depId,
          resourceName: `${deployment.service.name}@${deployment.server.name}`,
          // serviceId is needed by /services/:id/history so failure entries
          // appear in the per-template audit view.
          details: { serviceId: id },
          success: false,
          error: message,
          ...actorFrom(request),
          environmentId: deployment.service.environmentId,
        });

        return reply.code(500).send({ error: message });
      } finally {
        client.disconnect();
      }
    }
  );

  // Refresh runtime status of a specific deployment.
  fastify.post(
    '/api/services/:id/deployments/:depId/health',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Refresh runtime status and health for a deployment',
        params: depParamsSchema,
        errors: [400, 401, 404, 500],
      }),
    },
    async (request, reply) => {
      const { id, depId } = request.params as { id: string; depId: string };

      const deployment = await findOrNotFound(
        prisma.serviceDeployment.findUnique({
          where: { id: depId },
          include: { server: true, service: true },
        }),
        'Deployment',
        reply
      );
      if (!deployment) return;

      const { client, error } = await createClientForServer(
        deployment.server.hostname,
        deployment.server.environmentId,
        getEnvironmentSshKey,
        { serverType: deployment.server.serverType }
      );
      if (!client) {
        return reply.code(400).send({ error });
      }

      const docker = new DockerSSH(client);
      const start = Date.now();

      try {
        await client.connect();

        const containerInfo = await docker.getContainerInfo(deployment.containerName);

        let urlHealth: { success: boolean; statusCode?: number; error?: string } | null = null;
        if (deployment.service.healthCheckUrl) {
          urlHealth = await docker.checkUrl(deployment.service.healthCheckUrl);
        }

        const containerStatus = containerInfo.state;
        const healthStatus = determineHealthStatus(
          containerInfo.health,
          containerInfo.running,
          urlHealth
        );
        const status = determineOverallStatus(
          containerInfo.state,
          containerInfo.running,
          healthStatus
        );

        const exposedPorts = containerInfo.ports.length > 0
          ? JSON.stringify(containerInfo.ports)
          : null;

        // Sync image tag back to the template on discovery.
        const currentImageTag = containerInfo.image ? containerInfo.image.split(':')[1] || deployment.service.imageTag : deployment.service.imageTag;

        await prisma.serviceDeployment.update({
          where: { id: depId },
          data: {
            status,
            containerStatus,
            healthStatus,
            exposedPorts,
            discoveryStatus: containerInfo.state === CONTAINER_STATUS.NOT_FOUND ? DISCOVERY_STATUS.MISSING : DISCOVERY_STATUS.FOUND,
            lastCheckedAt: new Date(),
            lastDiscoveredAt: containerInfo.state !== CONTAINER_STATUS.NOT_FOUND ? new Date() : deployment.lastDiscoveredAt,
          },
        });

        if (currentImageTag !== deployment.service.imageTag) {
          await prisma.service.update({
            where: { id: deployment.serviceId },
            data: { imageTag: currentImageTag },
          });
        }

        const containerHealth = {
          state: containerInfo.state,
          status: containerInfo.running ? 'Running' : `Container is ${containerInfo.state}`,
          health: containerInfo.health,
          running: containerInfo.running,
        };

        let updateInfo: { hasUpdate: boolean; bestTag?: string } | null = null;
        try {
          const updateResult = await checkServiceUpdate(depId);
          if (!updateResult.error) {
            updateInfo = { hasUpdate: updateResult.hasUpdate, bestTag: updateResult.bestTag };
          }
        } catch {
          console.error('[HealthCheck] Failed to check updates for service', deployment.service.name);
        }

        const durationMs = Date.now() - start;
        const isHealthy = containerInfo.running && (urlHealth === null || urlHealth.success);

        await logAudit({
          action: 'health_check',
          resourceType: 'service_deployment',
          resourceId: depId,
          resourceName: deployment.service.name,
          details: { status, containerStatus, healthStatus, containerHealth, urlHealth, exposedPorts, updateInfo, serviceId: id },
          ...actorFrom(request),
          environmentId: deployment.service.environmentId,
        });

        await logHealthCheck({
          environmentId: deployment.service.environmentId,
          resourceType: 'service_deployment',
          resourceId: depId,
          resourceName: deployment.service.name,
          checkType: urlHealth ? 'url' : 'container_health',
          status: isHealthy ? HEALTH_CHECK_STATUS.SUCCESS : HEALTH_CHECK_STATUS.FAILURE,
          durationMs,
          httpStatus: urlHealth?.statusCode,
          errorMessage: urlHealth?.error,
        });

        return {
          status,
          containerStatus,
          healthStatus,
          container: containerHealth,
          url: urlHealth,
          exposedPorts: containerInfo.ports,
          imageTag: currentImageTag,
          lastCheckedAt: new Date().toISOString(),
          updateInfo,
        };
      } catch (error) {
        const durationMs = Date.now() - start;
        const message = getErrorMessage(error, 'Health check failed');

        await prisma.serviceDeployment.update({
          where: { id: depId },
          data: {
            status: HEALTH_STATUS.UNKNOWN,
            containerStatus: HEALTH_STATUS.UNKNOWN,
            healthStatus: HEALTH_STATUS.UNKNOWN,
            lastCheckedAt: new Date(),
          },
        });

        await logAudit({
          action: 'health_check',
          resourceType: 'service_deployment',
          resourceId: depId,
          resourceName: deployment.service.name,
          // serviceId is needed by /services/:id/history so failure entries
          // appear in the per-template audit view.
          details: { serviceId: id },
          success: false,
          error: message,
          ...actorFrom(request),
          environmentId: deployment.service.environmentId,
        });

        await logHealthCheck({
          environmentId: deployment.service.environmentId,
          resourceType: 'service_deployment',
          resourceId: depId,
          resourceName: deployment.service.name,
          checkType: 'url',
          status: HEALTH_CHECK_STATUS.FAILURE,
          durationMs,
          errorMessage: message,
        });

        return reply.code(500).send({ error: message });
      } finally {
        client.disconnect();
      }
    }
  );

  // Get service action history (audit + deployments)
  fastify.get(
    '/api/services/:id/history',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Get audit and deployment history for a service template',
        params: idParamsSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };

      const service = await findOrNotFound(
        prisma.service.findUnique({ where: { id } }),
        'Service',
        reply
      );
      if (!service) return;

      const logs = await prisma.auditLog.findMany({
        where: {
          OR: [
            { resourceType: 'service', resourceId: id },
            { resourceType: 'service_deployment', details: { contains: `"serviceId":"${id}"` } },
          ],
          action: { in: ['deploy', 'restart', 'health_check', 'update', 'create'] },
        },
        orderBy: { createdAt: 'desc' },
        take: limit ? parseInt(limit, 10) : 50,
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      });

      const deployments = await prisma.deployment.findMany({
        where: { serviceId: id },
        orderBy: { startedAt: 'desc' },
        take: limit ? parseInt(limit, 10) : 20,
        select: {
          id: true,
          imageTag: true,
          status: true,
          triggeredBy: true,
          startedAt: true,
          completedAt: true,
          serviceDeploymentId: true,
        },
      });

      return { logs, deployments };
    }
  );

  // Check for image updates (template-scope)
  fastify.post(
    '/api/services/:id/check-updates',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Check for a newer image tag for a service template',
        params: idParamsSchema,
        errors: [400, 401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await findOrNotFound(
        prisma.service.findUnique({
          where: { id },
          include: { containerImage: true },
        }),
        'Service',
        reply
      );
      if (!service) return;

      const result = await checkServiceUpdate(id);

      if (result.error) {
        return reply.code(400).send({ error: result.error });
      }

      const updatedContainerImage = await prisma.containerImage.findUnique({
        where: { id: service.containerImageId },
        select: { lastCheckedAt: true, updateAvailable: true },
      });

      return {
        hasUpdate: result.hasUpdate,
        currentTag: service.imageTag,
        bestTag: result.bestTag,
        newestDigestId: result.newestDigestId,
        lastUpdateCheckAt: updatedContainerImage?.lastCheckedAt,
      };
    }
  );

  // Get predefined command (for CLI). Returns template + command (no per-deployment context).
  fastify.post(
    '/api/services/:id/run-command',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['services'],
        summary: 'Resolve a predefined service-type command for the CLI',
        params: idParamsSchema,
        body: runCommandSchema,
        errors: [400, 401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(runCommandSchema, request, reply);
      if (!body) return;

      const service = await findOrNotFound(
        prisma.service.findUnique({
          where: { id },
          include: {
            serviceType: { include: { commands: true } },
          },
        }),
        'Service',
        reply
      );
      if (!service) return;

      if (!service.serviceType) {
        return reply.code(400).send({ error: 'Service has no service type configured' });
      }

      const command = service.serviceType.commands.find((cmd) => cmd.name === body.commandName);

      if (!command) {
        return reply.code(404).send({
          error: `Command '${body.commandName}' not found`,
          availableCommands: service.serviceType.commands.map((c) => c.name),
        });
      }

      await logAudit({
        action: 'run_command',
        resourceType: 'service',
        resourceId: id,
        resourceName: service.name,
        details: { commandName: body.commandName, command: command.command },
        ...actorFrom(request),
        environmentId: service.environmentId,
      });

      return { command: command.command };
    }
  );
}
