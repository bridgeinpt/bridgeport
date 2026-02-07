import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createDatabase,
  updateDatabase,
  getDatabase,
  listDatabases,
  deleteDatabase,
  createBackup,
  listBackups,
  getBackup,
  deleteBackup,
  setBackupSchedule,
  getBackupSchedule,
  deleteBackupSchedule,
  getBackupDownload,
} from '../services/database-backup.js';
import { logAudit } from '../services/audit.js';
import { prisma } from '../lib/db.js';
import { requireOperator } from '../plugins/authorize.js';
import { collectDatabaseMetrics } from '../services/database-monitoring-collector.js';
import { pingDatabase } from '../services/database-query-executor.js';

const storageTypeSchema = z.enum(['local', 'spaces']);
const backupFormatSchema = z.enum(['plain', 'custom', 'tar']);
const backupCompressionSchema = z.enum(['none', 'gzip']);

const pgDumpOptionsSchema = z.object({
  noOwner: z.boolean().optional(),
  clean: z.boolean().optional(),
  ifExists: z.boolean().optional(),
  schemaOnly: z.boolean().optional(),
  dataOnly: z.boolean().optional(),
});

const createDatabaseSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  databaseTypeId: z.string().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  databaseName: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  filePath: z.string().optional(),
  serverId: z.string().optional(),
  backupStorageType: storageTypeSchema.optional(),
  backupLocalPath: z.string().optional(),
  backupSpacesBucket: z.string().optional(),
  backupSpacesPrefix: z.string().optional(),
  backupFormat: backupFormatSchema.optional(),
  backupCompression: backupCompressionSchema.optional(),
  backupCompressionLevel: z.number().min(1).max(9).optional(),
  pgDumpOptions: pgDumpOptionsSchema.optional(),
  pgDumpTimeoutMs: z.number().min(30000).max(3600000).optional(), // 30s to 1h
});

const updateDatabaseSchema = createDatabaseSchema.partial();

const scheduleSchema = z.object({
  cronExpression: z.string().min(1),
  retentionDays: z.number().min(1).max(365).optional(),
  enabled: z.boolean().optional(),
});

export async function databaseRoutes(fastify: FastifyInstance): Promise<void> {
  // List databases for environment
  fastify.get(
    '/api/environments/:envId/databases',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const databases = await listDatabases(envId);
      return { databases };
    }
  );

  // Create database
  fastify.post(
    '/api/environments/:envId/databases',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = createDatabaseSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        // Resolve databaseTypeId if provided
        let databaseTypeId = body.data.databaseTypeId;
        if (!databaseTypeId) {
          // Look up DatabaseType by name for backward compat
          const dbType = await prisma.databaseType.findUnique({
            where: { name: body.data.type },
          });
          if (dbType) {
            databaseTypeId = dbType.id;
          }
        }

        const database = await createDatabase(envId, body.data, databaseTypeId);

        await logAudit({
          action: 'create',
          resourceType: 'database',
          resourceId: database.id,
          resourceName: database.name,
          details: { type: database.type },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { database };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'Database with this name already exists' });
        }
        throw error;
      }
    }
  );

  // Get database
  fastify.get(
    '/api/databases/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const database = await getDatabase(id);

      if (!database) {
        return reply.code(404).send({ error: 'Database not found' });
      }

      return { database };
    }
  );

  // Update database
  fastify.patch(
    '/api/databases/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateDatabaseSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const existing = await getDatabase(id);
        const database = await updateDatabase(id, body.data);

        await logAudit({
          action: 'update',
          resourceType: 'database',
          resourceId: database.id,
          resourceName: database.name,
          details: { changes: Object.keys(body.data) },
          userId: request.authUser!.id,
          environmentId: existing?.environmentId,
        });

        return { database };
      } catch (error) {
        if (error instanceof Error && error.message === 'Database not found') {
          return reply.code(404).send({ error: 'Database not found' });
        }
        throw error;
      }
    }
  );

  // Delete database
  fastify.delete(
    '/api/databases/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const existing = await getDatabase(id);
      if (!existing) {
        return reply.code(404).send({ error: 'Database not found' });
      }

      if (existing._count && existing._count.backups > 0) {
        return reply.code(400).send({
          error: 'Cannot delete database with existing backups. Delete backups first.',
        });
      }

      await deleteDatabase(id);

      await logAudit({
        action: 'delete',
        resourceType: 'database',
        resourceId: id,
        resourceName: existing.name,
        userId: request.authUser!.id,
        environmentId: existing.environmentId,
      });

      return { success: true };
    }
  );

  // Create backup
  fastify.post(
    '/api/databases/:id/backups',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const database = await getDatabase(id);
      if (!database) {
        return reply.code(404).send({ error: 'Database not found' });
      }

      try {
        const { backupId } = await createBackup(id, request.authUser!.id);

        await logAudit({
          action: 'backup',
          resourceType: 'database',
          resourceId: id,
          resourceName: database.name,
          details: { backupId },
          userId: request.authUser!.id,
          environmentId: database.environmentId,
        });

        return { backupId, message: 'Backup started' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Backup failed';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // List backups
  fastify.get(
    '/api/databases/:id/backups',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit, offset } = request.query as { limit?: string; offset?: string };

      const database = await getDatabase(id);
      if (!database) {
        return reply.code(404).send({ error: 'Database not found' });
      }

      const { backups, total } = await listBackups(id, {
        limit: limit ? parseInt(limit) : 50,
        offset: offset ? parseInt(offset) : 0,
      });

      // Check if downloads are allowed
      const dataSettings = await prisma.dataSettings.findUnique({
        where: { environmentId: database.environmentId },
      });
      const allowDownload = dataSettings?.allowBackupDownload ?? false;

      return {
        backups: backups.map((b) => ({
          ...b,
          size: Number(b.size), // Convert BigInt to number for JSON
        })),
        total,
        allowDownload,
      };
    }
  );

  // Get backup details
  fastify.get(
    '/api/backups/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const backup = await getBackup(id);
      if (!backup) {
        return reply.code(404).send({ error: 'Backup not found' });
      }

      // Check if downloads are allowed
      const dataSettings = await prisma.dataSettings.findUnique({
        where: { environmentId: backup.database.environmentId },
      });
      const allowDownload = dataSettings?.allowBackupDownload ?? false;

      return {
        backup: {
          ...backup,
          size: Number(backup.size),
        },
        allowDownload,
      };
    }
  );

  // Download backup
  fastify.get(
    '/api/backups/:id/download',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const result = await getBackupDownload(id);

        if (result.type === 'url') {
          // Redirect to presigned URL for Spaces
          return { downloadUrl: result.url };
        } else {
          // Stream file content for local storage
          reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);
          reply.header('Content-Type', 'application/octet-stream');
          return reply.send(result.content);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Download failed';
        return reply.code(400).send({ error: message });
      }
    }
  );

  // Delete backup
  fastify.delete(
    '/api/backups/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const backup = await getBackup(id);
      if (!backup) {
        return reply.code(404).send({ error: 'Backup not found' });
      }

      await deleteBackup(id);

      await logAudit({
        action: 'delete',
        resourceType: 'backup',
        resourceId: id,
        resourceName: backup.filename,
        userId: request.authUser!.id,
        environmentId: backup.database.environmentId,
      });

      return { success: true };
    }
  );

  // Get backup schedule
  fastify.get(
    '/api/databases/:id/schedule',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const database = await getDatabase(id);
      if (!database) {
        return reply.code(404).send({ error: 'Database not found' });
      }

      const schedule = await getBackupSchedule(id);
      return { schedule };
    }
  );

  // Set backup schedule
  fastify.put(
    '/api/databases/:id/schedule',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = scheduleSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const database = await getDatabase(id);
      if (!database) {
        return reply.code(404).send({ error: 'Database not found' });
      }

      const schedule = await setBackupSchedule(
        id,
        body.data.cronExpression,
        body.data.retentionDays,
        body.data.enabled
      );

      await logAudit({
        action: 'update',
        resourceType: 'backup_schedule',
        resourceId: schedule.id,
        resourceName: database.name,
        details: { ...body.data },
        userId: request.authUser!.id,
        environmentId: database.environmentId,
      });

      return { schedule };
    }
  );

  // Delete backup schedule
  fastify.delete(
    '/api/databases/:id/schedule',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const database = await getDatabase(id);
      if (!database) {
        return reply.code(404).send({ error: 'Database not found' });
      }

      await deleteBackupSchedule(id);

      await logAudit({
        action: 'delete',
        resourceType: 'backup_schedule',
        resourceName: database.name,
        userId: request.authUser!.id,
        environmentId: database.environmentId,
      });

      return { success: true };
    }
  );

  // ==================== Database Monitoring Endpoints ====================

  // Get aggregate database metrics history for charts
  fastify.get(
    '/api/environments/:envId/databases/metrics/history',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const { hours } = request.query as { hours?: string };
      const hoursNum = hours ? parseInt(hours) : 24;
      const since = new Date();
      since.setHours(since.getHours() - hoursNum);

      // Get all monitored databases with server and type info
      const databases = await prisma.database.findMany({
        where: { environmentId: envId, monitoringEnabled: true },
        include: {
          server: { select: { id: true, name: true, tags: true } },
          databaseType: { select: { id: true, name: true, displayName: true, monitoringConfig: true } },
        },
      });

      // Fetch metrics for all databases in parallel
      const metricsPerDb = await Promise.all(
        databases.map(async (db) => {
          const metrics = await prisma.databaseMetrics.findMany({
            where: { databaseId: db.id, collectedAt: { gte: since } },
            orderBy: { collectedAt: 'asc' },
          });
          return { db, metrics };
        })
      );

      // Group databases by type
      const typeGroups = new Map<string, {
        type: string;
        typeName: string;
        queryMeta: Array<{ name: string; displayName: string; resultType: string; unit?: string; chartGroup?: string; resultMapping?: Record<string, string> }>;
        databases: Array<{ id: string; name: string; serverId: string | null; serverName: string | null; data: Array<Record<string, unknown>> }>;
      }>();

      for (const { db, metrics } of metricsPerDb) {
        const dbType = db.type;
        const typeName = db.databaseType?.displayName || db.type;

        if (!typeGroups.has(dbType)) {
          // Build queryMeta for this type
          const queryMeta: Array<{ name: string; displayName: string; resultType: string; unit?: string; chartGroup?: string; resultMapping?: Record<string, string> }> = [];
          if (db.databaseType?.monitoringConfig) {
            const config = JSON.parse(db.databaseType.monitoringConfig) as {
              queries: Array<{ name: string; displayName: string; resultType: string; unit?: string; chartGroup?: string; resultMapping?: Record<string, string> }>;
            };
            for (const q of config.queries) {
              queryMeta.push({
                name: q.name,
                displayName: q.displayName,
                resultType: q.resultType,
                unit: q.unit,
                chartGroup: q.chartGroup,
                resultMapping: q.resultMapping,
              });
            }
          }
          typeGroups.set(dbType, { type: dbType, typeName, queryMeta, databases: [] });
        }

        // Build time-series data for this database
        const data = metrics.map((m) => {
          const parsed = JSON.parse(m.metricsJson) as Record<string, unknown>;
          const point: Record<string, unknown> = { time: m.collectedAt.toISOString() };

          for (const [key, value] of Object.entries(parsed)) {
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
              // Row result — flatten fields
              for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
                point[`${key}.${field}`] = fieldValue;
              }
            } else {
              // Scalar or rows (array) — keep as-is
              point[key] = value;
            }
          }
          return point;
        });

        typeGroups.get(dbType)!.databases.push({
          id: db.id,
          name: db.name,
          serverId: db.server?.id || null,
          serverName: db.server?.name || null,
          data,
        });
      }

      return {
        types: Array.from(typeGroups.values()),
      };
    }
  );

  // Get monitoring summary for all databases in an environment
  fastify.get(
    '/api/environments/:envId/databases/monitoring-summary',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };

      const databases = await prisma.database.findMany({
        where: { environmentId: envId },
        include: {
          server: { select: { name: true } },
          databaseType: {
            select: { displayName: true, monitoringConfig: true },
          },
          metrics: {
            orderBy: { collectedAt: 'desc' },
            take: 1,
          },
        },
      });

      const result = databases.map((db) => ({
        id: db.id,
        name: db.name,
        type: db.type,
        typeName: db.databaseType?.displayName || db.type,
        serverName: db.server?.name || null,
        monitoringEnabled: db.monitoringEnabled,
        monitoringStatus: db.monitoringStatus,
        lastCollectedAt: db.lastCollectedAt,
        lastMonitoringError: db.lastMonitoringError,
        latestMetrics: db.metrics[0] ? JSON.parse(db.metrics[0].metricsJson) : null,
        monitoringConfig: db.databaseType?.monitoringConfig
          ? JSON.parse(db.databaseType.monitoringConfig)
          : null,
      }));

      return { databases: result };
    }
  );

  // Get metrics history for a specific database
  fastify.get(
    '/api/environments/:envId/databases/:id/metrics',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { envId: string; id: string };
      const { hours } = request.query as { hours?: string };

      const database = await prisma.database.findUnique({
        where: { id },
        include: {
          databaseType: { select: { monitoringConfig: true } },
        },
      });

      if (!database) {
        return reply.code(404).send({ error: 'Database not found' });
      }

      const hoursNum = hours ? parseInt(hours) : 24;
      const since = new Date();
      since.setHours(since.getHours() - hoursNum);

      const metrics = await prisma.databaseMetrics.findMany({
        where: {
          databaseId: id,
          collectedAt: { gte: since },
        },
        orderBy: { collectedAt: 'asc' },
      });

      return {
        metrics: metrics.map((m) => ({
          collectedAt: m.collectedAt,
          data: JSON.parse(m.metricsJson),
        })),
        monitoringConfig: database.databaseType?.monitoringConfig
          ? JSON.parse(database.databaseType.monitoringConfig)
          : null,
      };
    }
  );

  // Test database connection (lightweight ping)
  fastify.post(
    '/api/environments/:envId/databases/:id/test-connection',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId, id } = request.params as { envId: string; id: string };

      const database = await prisma.database.findUnique({
        where: { id },
        include: { databaseType: true, server: true },
      });
      if (!database) {
        return reply.code(404).send({ error: 'Database not found' });
      }

      try {
        const result = await pingDatabase(database, envId);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Connection failed';
        return { success: false, latencyMs: null, error: message };
      }
    }
  );

  // Update monitoring configuration for a database
  fastify.patch(
    '/api/environments/:envId/databases/:id/monitoring',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { envId: string; id: string };
      const body = request.body as {
        monitoringEnabled?: boolean;
        collectionIntervalSec?: number;
      };

      const database = await prisma.database.findUnique({ where: { id } });
      if (!database) {
        return reply.code(404).send({ error: 'Database not found' });
      }

      const updated = await prisma.database.update({
        where: { id },
        data: {
          ...(body.monitoringEnabled !== undefined && { monitoringEnabled: body.monitoringEnabled }),
          ...(body.collectionIntervalSec !== undefined && { collectionIntervalSec: body.collectionIntervalSec }),
        },
      });

      await logAudit({
        action: 'update',
        resourceType: 'database',
        resourceId: id,
        resourceName: database.name,
        details: { monitoringConfigUpdated: body },
        userId: request.authUser!.id,
        environmentId: database.environmentId,
      });

      return {
        monitoringEnabled: updated.monitoringEnabled,
        collectionIntervalSec: updated.collectionIntervalSec,
        monitoringStatus: updated.monitoringStatus,
      };
    }
  );
}
