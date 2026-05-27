import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireOperator } from '../plugins/authorize.js';
import { safeJsonParse, validateBody, findOrNotFound, handleUniqueConstraint } from '../lib/helpers.js';

// Connection endpoints can be services, databases, or user-placed external
// entities. The DB columns are free-form `String` so this widening is
// non-breaking for existing rows.
const connectionEndpointType = z.enum(['service', 'database', 'external']);

const createConnectionSchema = z.object({
  environmentId: z.string().min(1),
  sourceType: connectionEndpointType,
  sourceId: z.string().min(1),
  sourceHandle: z.string().optional().nullable(),
  targetType: connectionEndpointType,
  targetId: z.string().min(1),
  targetHandle: z.string().optional().nullable(),
  port: z.number().int().positive().optional().nullable(),
  protocol: z.string().optional().nullable(),
  label: z.string().optional().nullable(),
  direction: z.enum(['forward', 'none']).default('none'),
});

// Layout positions accept optional width/height so resizable server boxes
// and cluster containers can persist their size alongside x/y. Older rows
// without width/height continue to work — the renderer falls back to
// computed defaults.
const upsertLayoutSchema = z.object({
  environmentId: z.string().min(1),
  positions: z.record(
    z.string(),
    z.object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
    })
  ),
});

const createExternalEntitySchema = z.object({
  kind: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  iconKey: z.string().max(64).optional().nullable(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive().optional().nullable(),
  height: z.number().positive().optional().nullable(),
});

const updateExternalEntitySchema = z.object({
  kind: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(128).optional(),
  iconKey: z.string().max(64).nullable().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().nullable().optional(),
  height: z.number().positive().nullable().optional(),
});

const createServerClusterSchema = z.object({
  name: z.string().min(1).max(128),
  color: z.string().max(32).optional().nullable(),
  collapsed: z.boolean().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().positive().optional().nullable(),
  height: z.number().positive().optional().nullable(),
});

const updateServerClusterSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  color: z.string().max(32).nullable().optional(),
  collapsed: z.boolean().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().positive().nullable().optional(),
  height: z.number().positive().nullable().optional(),
});

export async function topologyRoutes(fastify: FastifyInstance): Promise<void> {
  // ==================== Connections CRUD ====================

  // List connections for an environment
  fastify.get(
    '/api/connections',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { environmentId } = request.query as { environmentId?: string };
      if (!environmentId) {
        return reply.code(400).send({ error: 'environmentId is required' });
      }

      const connections = await prisma.serviceConnection.findMany({
        where: { environmentId },
        orderBy: { createdAt: 'desc' },
      });

      return { connections };
    }
  );

  // Verify a connection endpoint (service/database/external) exists and belongs
  // to the given environment. Returns true on success; otherwise sends a 404 and
  // returns false. Centralized here so the create-connection handler stays flat.
  const verifyEndpoint = async (
    role: 'Source' | 'Target',
    type: 'service' | 'database' | 'external',
    id: string,
    environmentId: string,
    reply: import('fastify').FastifyReply
  ): Promise<boolean> => {
    if (type === 'service') {
      const ok = await findOrNotFound(
        prisma.service.findFirst({ where: { id, environmentId } }),
        `${role} service in this environment`,
        reply
      );
      return !!ok;
    }
    if (type === 'database') {
      const ok = await findOrNotFound(
        prisma.database.findFirst({ where: { id, environmentId } }),
        `${role} database in this environment`,
        reply
      );
      return !!ok;
    }
    // external
    const ok = await findOrNotFound(
      prisma.externalEntity.findFirst({ where: { id, environmentId } }),
      `${role} external entity in this environment`,
      reply
    );
    return !!ok;
  };

  // Create a connection
  fastify.post(
    '/api/connections',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const data = validateBody(createConnectionSchema, request, reply);
      if (!data) return;

      // Prevent self-connections
      if (data.sourceType === data.targetType && data.sourceId === data.targetId) {
        return reply.code(400).send({ error: 'Cannot create a connection from a node to itself' });
      }

      // Verify environment exists
      const environment = await findOrNotFound(
        prisma.environment.findUnique({ where: { id: data.environmentId } }),
        'Environment',
        reply
      );
      if (!environment) return;

      // Verify endpoints exist in this environment
      if (!(await verifyEndpoint('Source', data.sourceType, data.sourceId, data.environmentId, reply))) return;
      if (!(await verifyEndpoint('Target', data.targetType, data.targetId, data.environmentId, reply))) return;

      // SQLite's unique index treats NULL as distinct, so the @@unique constraint
      // doesn't catch duplicates when port is null. Check explicitly first.
      if (data.port == null) {
        const existing = await prisma.serviceConnection.findFirst({
          where: {
            environmentId: data.environmentId,
            sourceType: data.sourceType,
            sourceId: data.sourceId,
            targetType: data.targetType,
            targetId: data.targetId,
            port: null,
          },
        });
        if (existing) {
          return reply.code(409).send({ error: 'A connection between these endpoints already exists' });
        }
      }

      try {
        const connection = await prisma.serviceConnection.create({
          data: {
            environmentId: data.environmentId,
            sourceType: data.sourceType,
            sourceId: data.sourceId,
            sourceHandle: data.sourceHandle ?? undefined,
            targetType: data.targetType,
            targetId: data.targetId,
            targetHandle: data.targetHandle ?? undefined,
            port: data.port ?? undefined,
            protocol: data.protocol ?? undefined,
            label: data.label ?? undefined,
            direction: data.direction,
          },
        });

        return reply.code(201).send(connection);
      } catch (error: unknown) {
        if (handleUniqueConstraint(error, 'A connection with this source, target, and port already exists', reply)) return;
        throw error;
      }
    }
  );

  // Delete a connection
  fastify.delete(
    '/api/connections/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const connection = await findOrNotFound(prisma.serviceConnection.findUnique({ where: { id } }), 'Connection', reply);
      if (!connection) return;

      await prisma.serviceConnection.delete({ where: { id } });

      return { success: true };
    }
  );

  // ==================== Layout Persistence ====================

  // Get layout for an environment
  fastify.get(
    '/api/diagram-layout',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { environmentId } = request.query as { environmentId?: string };
      if (!environmentId) {
        return reply.code(400).send({ error: 'environmentId is required' });
      }

      const layout = await prisma.diagramLayout.findUnique({
        where: { environmentId },
      });

      if (!layout) {
        return { layout: null };
      }

      return {
        layout: {
          id: layout.id,
          environmentId: layout.environmentId,
          positions: safeJsonParse(layout.positions, {}),
          updatedAt: layout.updatedAt,
        },
      };
    }
  );

  // Upsert layout for an environment
  fastify.put(
    '/api/diagram-layout',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const parsed = validateBody(upsertLayoutSchema, request, reply);
      if (!parsed) return;

      const { environmentId, positions } = parsed;

      // Verify environment exists
      const environment = await findOrNotFound(
        prisma.environment.findUnique({ where: { id: environmentId } }),
        'Environment',
        reply
      );
      if (!environment) return;

      const positionsJson = JSON.stringify(positions);

      const layout = await prisma.diagramLayout.upsert({
        where: { environmentId },
        update: { positions: positionsJson },
        create: { environmentId, positions: positionsJson },
      });

      return {
        layout: {
          id: layout.id,
          environmentId: layout.environmentId,
          positions: safeJsonParse(layout.positions, {}),
          updatedAt: layout.updatedAt,
        },
      };
    }
  );

  // ==================== External Entities CRUD ====================

  // List external entities for an environment
  fastify.get(
    '/api/environments/:envId/external-entities',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const entities = await prisma.externalEntity.findMany({
        where: { environmentId: envId },
        orderBy: { createdAt: 'asc' },
      });
      return { externalEntities: entities };
    }
  );

  // Create an external entity scoped to an environment
  fastify.post(
    '/api/environments/:envId/external-entities',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const data = validateBody(createExternalEntitySchema, request, reply);
      if (!data) return;

      const env = await findOrNotFound(
        prisma.environment.findUnique({ where: { id: envId } }),
        'Environment',
        reply
      );
      if (!env) return;

      const entity = await prisma.externalEntity.create({
        data: {
          environmentId: envId,
          kind: data.kind,
          label: data.label,
          iconKey: data.iconKey ?? undefined,
          x: data.x,
          y: data.y,
          width: data.width ?? undefined,
          height: data.height ?? undefined,
        },
      });
      return reply.code(201).send({ externalEntity: entity });
    }
  );

  // Update an external entity
  fastify.patch(
    '/api/external-entities/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const data = validateBody(updateExternalEntitySchema, request, reply);
      if (!data) return;

      const existing = await findOrNotFound(
        prisma.externalEntity.findUnique({ where: { id } }),
        'External entity',
        reply
      );
      if (!existing) return;

      const entity = await prisma.externalEntity.update({
        where: { id },
        data: {
          ...(data.kind !== undefined ? { kind: data.kind } : {}),
          ...(data.label !== undefined ? { label: data.label } : {}),
          ...(data.iconKey !== undefined ? { iconKey: data.iconKey } : {}),
          ...(data.x !== undefined ? { x: data.x } : {}),
          ...(data.y !== undefined ? { y: data.y } : {}),
          ...(data.width !== undefined ? { width: data.width } : {}),
          ...(data.height !== undefined ? { height: data.height } : {}),
        },
      });
      return { externalEntity: entity };
    }
  );

  // Delete an external entity. Connections referencing it are not auto-deleted
  // (the DB columns are free-form String, so there's no FK cascade). The
  // frontend filters out connections with missing endpoints when rendering.
  fastify.delete(
    '/api/external-entities/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const existing = await findOrNotFound(
        prisma.externalEntity.findUnique({ where: { id } }),
        'External entity',
        reply
      );
      if (!existing) return;
      // Best-effort cleanup of dangling connections referencing this entity so
      // the diagram doesn't render orphan edges.
      await prisma.$transaction([
        prisma.serviceConnection.deleteMany({
          where: {
            environmentId: existing.environmentId,
            OR: [
              { sourceType: 'external', sourceId: id },
              { targetType: 'external', targetId: id },
            ],
          },
        }),
        prisma.externalEntity.delete({ where: { id } }),
      ]);
      return { success: true };
    }
  );

  // ==================== Server Clusters CRUD ====================

  // List clusters for an environment
  fastify.get(
    '/api/environments/:envId/server-clusters',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const clusters = await prisma.serverCluster.findMany({
        where: { environmentId: envId },
        orderBy: { createdAt: 'asc' },
        include: { servers: { select: { id: true, name: true } } },
      });
      return { serverClusters: clusters };
    }
  );

  // Create a server cluster
  fastify.post(
    '/api/environments/:envId/server-clusters',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const data = validateBody(createServerClusterSchema, request, reply);
      if (!data) return;

      const env = await findOrNotFound(
        prisma.environment.findUnique({ where: { id: envId } }),
        'Environment',
        reply
      );
      if (!env) return;

      try {
        const cluster = await prisma.serverCluster.create({
          data: {
            environmentId: envId,
            name: data.name,
            color: data.color ?? undefined,
            collapsed: data.collapsed ?? false,
            x: data.x,
            y: data.y,
            width: data.width ?? undefined,
            height: data.height ?? undefined,
          },
        });
        return reply.code(201).send({ serverCluster: cluster });
      } catch (error: unknown) {
        if (handleUniqueConstraint(error, 'A cluster with this name already exists in this environment', reply)) return;
        throw error;
      }
    }
  );

  // Update a server cluster (name, collapsed flag, position, size)
  fastify.patch(
    '/api/server-clusters/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const data = validateBody(updateServerClusterSchema, request, reply);
      if (!data) return;

      const existing = await findOrNotFound(
        prisma.serverCluster.findUnique({ where: { id } }),
        'Server cluster',
        reply
      );
      if (!existing) return;

      try {
        const cluster = await prisma.serverCluster.update({
          where: { id },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.color !== undefined ? { color: data.color } : {}),
            ...(data.collapsed !== undefined ? { collapsed: data.collapsed } : {}),
            ...(data.x !== undefined ? { x: data.x } : {}),
            ...(data.y !== undefined ? { y: data.y } : {}),
            ...(data.width !== undefined ? { width: data.width } : {}),
            ...(data.height !== undefined ? { height: data.height } : {}),
          },
        });
        return { serverCluster: cluster };
      } catch (error: unknown) {
        if (handleUniqueConstraint(error, 'A cluster with this name already exists in this environment', reply)) return;
        throw error;
      }
    }
  );

  // Delete a server cluster. Servers in the cluster are NOT deleted — their
  // clusterId is set to NULL via the FK's onDelete: SetNull.
  fastify.delete(
    '/api/server-clusters/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const existing = await findOrNotFound(
        prisma.serverCluster.findUnique({ where: { id } }),
        'Server cluster',
        reply
      );
      if (!existing) return;
      await prisma.serverCluster.delete({ where: { id } });
      return { success: true };
    }
  );

  // ==================== Mermaid Export ====================

  // Export topology as Mermaid diagram
  fastify.get(
    '/api/diagram-export',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { environmentId, format } = request.query as { environmentId?: string; format?: string };
      if (!environmentId) {
        return reply.code(400).send({ error: 'environmentId is required' });
      }
      if (format !== 'mermaid') {
        return reply.code(400).send({ error: 'Only "mermaid" format is supported' });
      }

      // Fetch all data for the environment in parallel.
      const [servers, databases, connections, externalEntities] = await Promise.all([
        prisma.server.findMany({
          where: { environmentId },
          include: { serviceDeployments: { include: { service: true } } },
        }),
        prisma.database.findMany({
          where: { environmentId },
        }),
        prisma.serviceConnection.findMany({
          where: { environmentId },
        }),
        prisma.externalEntity.findMany({
          where: { environmentId },
        }),
      ]);

      // Build Mermaid graph
      const lines: string[] = ['graph TD'];

      // Build a set of database IDs that are placed inside a server
      const dbOnServer = new Set<string>();

      // Server subgraphs with their services and databases
      for (const server of servers) {
        const safeName = sanitizeMermaidId(server.id);
        const label = escapeMermaidLabel(server.name);
        lines.push(`  subgraph ${safeName}["${label}"]`);

        for (const sd of server.serviceDeployments) {
          // Mermaid nodes are per-deployment so a template fanning out to N servers
          // produces N distinct nodes (one inside each server's subgraph). Using
          // svc_${sd.service.id} would emit duplicate node ids across subgraphs.
          const depId = sanitizeMermaidId(`dep_${sd.id}`);
          const portSuffix = getServicePrimaryPort(sd.exposedPorts);
          const svcLabel = escapeMermaidLabel(sd.service.name) + (portSuffix ? ` (${portSuffix})` : '');
          lines.push(`    ${depId}["${svcLabel}"]`);
        }

        // Databases on this server
        for (const db of databases) {
          if (db.serverId === server.id) {
            dbOnServer.add(db.id);
            const dbId = sanitizeMermaidId(`db_${db.id}`);
            const dbLabel = escapeMermaidLabel(db.name) + (db.port ? ` (${db.port})` : '');
            lines.push(`    ${dbId}[("${dbLabel}")]`);
          }
        }

        lines.push('  end');
      }

      // Standalone databases (not on any server)
      for (const db of databases) {
        if (!dbOnServer.has(db.id)) {
          const dbId = sanitizeMermaidId(`db_${db.id}`);
          const dbLabel = escapeMermaidLabel(db.name) + (db.port ? ` (${db.port})` : '');
          lines.push(`  ${dbId}[("${dbLabel}")]`);
        }
      }

      // External entities — render as stadium-shape nodes so they're visually
      // distinct from services (rectangles) and databases (cylinders).
      for (const ext of externalEntities) {
        const extId = sanitizeMermaidId(`ext_${ext.id}`);
        const extLabel = escapeMermaidLabel(ext.label);
        lines.push(`  ${extId}(["${extLabel}"])`);
      }

      // Build a map: Service.id -> [deployment node ids] so service-typed
      // connections can fan out across all deployments of the referenced service.
      const deploymentNodesByService = new Map<string, string[]>();
      for (const server of servers) {
        for (const sd of server.serviceDeployments) {
          const list = deploymentNodesByService.get(sd.service.id) ?? [];
          list.push(sanitizeMermaidId(`dep_${sd.id}`));
          deploymentNodesByService.set(sd.service.id, list);
        }
      }

      const resolveEndpoints = (type: string, id: string): string[] => {
        if (type === 'service') {
          // Fall back to a synthetic svc node only when the service has no
          // deployments (rare, but keeps the diagram valid).
          return deploymentNodesByService.get(id) ?? [sanitizeMermaidId(`svc_${id}`)];
        }
        if (type === 'external') {
          return [sanitizeMermaidId(`ext_${id}`)];
        }
        return [sanitizeMermaidId(`db_${id}`)];
      };

      // Connections
      for (const conn of connections) {
        const sources = resolveEndpoints(conn.sourceType, conn.sourceId);
        const targets = resolveEndpoints(conn.targetType, conn.targetId);

        const arrow = conn.direction === 'forward' ? '-->' : '---';
        const label = conn.label ? `|${escapeMermaidLabel(conn.label)}|` : '';

        for (const sourceId of sources) {
          for (const targetId of targets) {
            lines.push(`  ${sourceId} ${arrow}${label} ${targetId}`);
          }
        }
      }

      return { mermaid: lines.join('\n') };
    }
  );
}

function sanitizeMermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function escapeMermaidLabel(label: string): string {
  return label.replace(/"/g, '#quot;');
}

function getServicePrimaryPort(exposedPortsJson: string | null): string | null {
  if (!exposedPortsJson) return null;
  const ports = safeJsonParse(exposedPortsJson, [] as Array<{ host?: number; container?: number }>);
  if (ports.length > 0) {
    return String(ports[0].container || ports[0].host || '');
  }
  return null;
}
