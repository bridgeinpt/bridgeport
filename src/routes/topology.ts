import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireOperator } from '../plugins/authorize.js';

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
      const parsed = createConnectionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.issues });
      }

      const data = parsed.data;

      // Prevent self-connections
      if (data.sourceType === data.targetType && data.sourceId === data.targetId) {
        return reply.code(400).send({ error: 'Cannot create a connection from a node to itself' });
      }

      // Verify environment exists
      const environment = await prisma.environment.findUnique({ where: { id: data.environmentId } });
      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      // Verify source exists
      if (data.sourceType === 'service') {
        const service = await prisma.service.findFirst({
          where: { id: data.sourceId, server: { environmentId: data.environmentId } },
        });
        if (!service) {
          return reply.code(404).send({ error: 'Source service not found in this environment' });
        }
      } else {
        const database = await prisma.database.findFirst({
          where: { id: data.sourceId, environmentId: data.environmentId },
        });
        if (!database) {
          return reply.code(404).send({ error: 'Source database not found in this environment' });
        }
      }

      // Verify target exists
      if (data.targetType === 'service') {
        const service = await prisma.service.findFirst({
          where: { id: data.targetId, server: { environmentId: data.environmentId } },
        });
        if (!service) {
          return reply.code(404).send({ error: 'Target service not found in this environment' });
        }
      } else {
        const database = await prisma.database.findFirst({
          where: { id: data.targetId, environmentId: data.environmentId },
        });
        if (!database) {
          return reply.code(404).send({ error: 'Target database not found in this environment' });
        }
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
        if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
          return reply.code(409).send({ error: 'A connection with this source, target, and port already exists' });
        }
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

      const connection = await prisma.serviceConnection.findUnique({ where: { id } });
      if (!connection) {
        return reply.code(404).send({ error: 'Connection not found' });
      }

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
        return { environmentId, positions: {} };
      }

      return {
        id: layout.id,
        environmentId: layout.environmentId,
        positions: JSON.parse(layout.positions),
        updatedAt: layout.updatedAt,
      };
    }
  );

  // Upsert layout for an environment
  fastify.put(
    '/api/diagram-layout',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const parsed = upsertLayoutSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.issues });
      }

      const { environmentId, positions } = parsed.data;

      // Verify environment exists
      const environment = await prisma.environment.findUnique({ where: { id: environmentId } });
      if (!environment) {
        return reply.code(404).send({ error: 'Environment not found' });
      }

      const positionsJson = JSON.stringify(positions);

      const layout = await prisma.diagramLayout.upsert({
        where: { environmentId },
        update: { positions: positionsJson },
        create: { environmentId, positions: positionsJson },
      });

      return {
        id: layout.id,
        environmentId: layout.environmentId,
        positions: JSON.parse(layout.positions),
        updatedAt: layout.updatedAt,
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

      return reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .send(lines.join('\n'));
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
  try {
    const ports = JSON.parse(exposedPortsJson) as Array<{ host?: number; container?: number }>;
    if (ports.length > 0) {
      return String(ports[0].container || ports[0].host || '');
    }
  } catch {
    // ignore
  }
  return null;
}
