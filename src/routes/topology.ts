import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireOperator } from '../plugins/authorize.js';
import { safeJsonParse, validateBody, findOrNotFound, handleUniqueConstraint } from '../lib/helpers.js';

const createConnectionSchema = z.object({
  environmentId: z.string().min(1),
  sourceType: z.enum(['service', 'database']),
  sourceId: z.string().min(1),
  targetType: z.enum(['service', 'database']),
  targetId: z.string().min(1),
  port: z.number().int().positive().optional().nullable(),
  protocol: z.string().optional().nullable(),
  label: z.string().optional().nullable(),
  direction: z.enum(['forward', 'none']).default('none'),
});

const upsertLayoutSchema = z.object({
  environmentId: z.string().min(1),
  positions: z.record(z.object({ x: z.number(), y: z.number() })),
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

      // Verify source exists
      if (data.sourceType === 'service') {
        const service = await findOrNotFound(
          prisma.service.findFirst({
            where: { id: data.sourceId, server: { environmentId: data.environmentId } },
          }),
          'Source service in this environment',
          reply
        );
        if (!service) return;
      } else {
        const database = await findOrNotFound(
          prisma.database.findFirst({
            where: { id: data.sourceId, environmentId: data.environmentId },
          }),
          'Source database in this environment',
          reply
        );
        if (!database) return;
      }

      // Verify target exists
      if (data.targetType === 'service') {
        const service = await findOrNotFound(
          prisma.service.findFirst({
            where: { id: data.targetId, server: { environmentId: data.environmentId } },
          }),
          'Target service in this environment',
          reply
        );
        if (!service) return;
      } else {
        const database = await findOrNotFound(
          prisma.database.findFirst({
            where: { id: data.targetId, environmentId: data.environmentId },
          }),
          'Target database in this environment',
          reply
        );
        if (!database) return;
      }

      try {
        const connection = await prisma.serviceConnection.create({
          data: {
            environmentId: data.environmentId,
            sourceType: data.sourceType,
            sourceId: data.sourceId,
            targetType: data.targetType,
            targetId: data.targetId,
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

      // Fetch all data for the environment
      const [servers, databases, connections] = await Promise.all([
        prisma.server.findMany({
          where: { environmentId },
          include: { services: true },
        }),
        prisma.database.findMany({
          where: { environmentId },
        }),
        prisma.serviceConnection.findMany({
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

        for (const service of server.services) {
          const svcId = sanitizeMermaidId(`svc_${service.id}`);
          const portSuffix = getServicePrimaryPort(service.exposedPorts);
          const svcLabel = escapeMermaidLabel(service.name) + (portSuffix ? ` (${portSuffix})` : '');
          lines.push(`    ${svcId}["${svcLabel}"]`);
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

      // Connections
      for (const conn of connections) {
        const sourceId = sanitizeMermaidId(
          conn.sourceType === 'service' ? `svc_${conn.sourceId}` : `db_${conn.sourceId}`
        );
        const targetId = sanitizeMermaidId(
          conn.targetType === 'service' ? `svc_${conn.targetId}` : `db_${conn.targetId}`
        );

        const arrow = conn.direction === 'forward' ? '-->' : '---';
        const label = conn.label ? `|${escapeMermaidLabel(conn.label)}|` : '';

        lines.push(`  ${sourceId} ${arrow}${label} ${targetId}`);
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
