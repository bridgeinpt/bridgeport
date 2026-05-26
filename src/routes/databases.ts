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
import { logAudit, actorFrom } from '../services/audit.js';
import { userIdForFk } from '../services/auth.js';
import { prisma } from '../lib/db.js';
import { requireOperator } from '../plugins/authorize.js';
import { collectDatabaseMetrics } from '../services/database-monitoring-collector.js';
import { pingDatabase } from '../services/database-query-executor.js';
import {
  safeJsonParse,
  validateBody,
  findOrNotFound,
  getErrorMessage,
  handleUniqueConstraint,
  parsePaginationQuery,
} from '../lib/helpers.js';

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
  useSsl: z.boolean().optional(),
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
      const { limit, offset } = parsePaginationQuery(request.query as Record<string, unknown>);
      return listDatabases(envId, { limit, offset });
    }
  );

  // Create database
  fastify.post(
    '/api/environments/:envId/databases',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = validateBody(createDatabaseSchema, request, reply);
      if (!body) return;

      try {
        // Resolve databaseTypeId if provided
        let databaseTypeId = body.databaseTypeId;
        if (!databaseTypeId) {
          // Look up DatabaseType by name for backward compat
          const dbType = await prisma.databaseType.findUnique({
            where: { name: body.type },
          });
          if (dbType) {
            databaseTypeId = dbType.id;
          }
        }

        const database = await createDatabase(envId, body, databaseTypeId);

        await logAudit({
          action: 'create',
          resourceType: 'database',
          resourceId: database.id,
          resourceName: database.name,
          details: { type: database.type },
          ...actorFrom(request),
          environmentId: envId,
        });

        return { database };
      } catch (error) {
        if (handleUniqueConstraint(error, 'Database with this name already exists', reply)) return;
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
      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

      return { database };
    }
  );

  // Update database
  fastify.patch(
    '/api/databases/:id',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(updateDatabaseSchema, request, reply);
      if (!body) return;

      try {
        const existing = await getDatabase(id);
        const database = await updateDatabase(id, body);

        await logAudit({
          action: 'update',
          resourceType: 'database',
          resourceId: database.id,
          resourceName: database.name,
          details: { changes: Object.keys(body) },
          ...actorFrom(request),
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

      const existing = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!existing) return;

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
        ...actorFrom(request),
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

      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

      try {
        const { backupId } = await createBackup(id, userIdForFk(request.authUser!));

        await logAudit({
          action: 'backup',
          resourceType: 'database',
          resourceId: id,
          resourceName: database.name,
          details: { backupId },
          ...actorFrom(request),
          environmentId: database.environmentId,
        });

        return { backupId, message: 'Backup started' };
      } catch (error) {
        const message = getErrorMessage(error, 'Backup failed');
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
      const { limit, offset } = parsePaginationQuery(request.query as Record<string, unknown>, { limit: 50, offset: 0 });

      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

      const { backups, total } = await listBackups(id, { limit, offset });

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

      const backup = await findOrNotFound(getBackup(id), 'Backup', reply);
      if (!backup) return;

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
        const message = getErrorMessage(error, 'Download failed');
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

      const backup = await findOrNotFound(getBackup(id), 'Backup', reply);
      if (!backup) return;

      await deleteBackup(id);

      await logAudit({
        action: 'delete',
        resourceType: 'backup',
        resourceId: id,
        resourceName: backup.filename,
        ...actorFrom(request),
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

      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

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
      const body = validateBody(scheduleSchema, request, reply);
      if (!body) return;

      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

      const schedule = await setBackupSchedule(
        id,
        body.cronExpression,
        body.retentionDays,
        body.enabled
      );

      await logAudit({
        action: 'update',
        resourceType: 'backup_schedule',
        resourceId: schedule.id,
        resourceName: database.name,
        details: { ...body },
        ...actorFrom(request),
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

      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

      await deleteBackupSchedule(id);

      await logAudit({
        action: 'delete',
        resourceType: 'backup_schedule',
        resourceName: database.name,
        ...actorFrom(request),
        environmentId: database.environmentId,
      });

      return { success: true };
    }
  );

  // ==================== Database Monitoring Endpoints ====================

  // Get aggregate database metrics history for charts
  //
  // Columnar shape — issue #139. Per type-group we emit a shared `timestamps[]`
  // plus a `series` keyed by query name:
  //   - scalar queries           → number[][]              (db × time)
  //   - row/rows queries (object/array) → { rows: unknown[][] } (db × time of object/array)
  // The nested row-result shape preserves the original structure so the UI
  // doesn't need to reconstruct objects; only the per-point repetition of the
  // outer envelope (id/name/time) is what we collapse.
  fastify.get(
    '/api/environments/:envId/databases/metrics/history',
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              types: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    typeName: { type: 'string' },
                    queryMeta: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          displayName: { type: 'string' },
                          resultType: { type: 'string' },
                          unit: { type: 'string' },
                          chartGroup: { type: 'string' },
                          resultMapping: { type: 'object', additionalProperties: { type: 'string' } },
                        },
                      },
                    },
                    databases: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          serverId: { type: ['string', 'null'] },
                          serverName: { type: ['string', 'null'] },
                        },
                      },
                    },
                    timestamps: { type: 'array', items: { type: 'string' } },
                    // series carries query-name keyed entries whose shape
                    // depends on the query's resultType — declare loose here.
                    series: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
        },
      },
    },
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

      type QueryMeta = { name: string; displayName: string; resultType: string; unit?: string; chartGroup?: string; resultMapping?: Record<string, string> };
      type DbBucket = {
        id: string;
        name: string;
        serverId: string | null;
        serverName: string | null;
        // Parsed per-point payloads paired with their ISO timestamp. We hold
        // these here until we know the full timestamp union for the group.
        points: Array<{ time: string; parsed: Record<string, unknown> }>;
      };
      type Group = {
        type: string;
        typeName: string;
        queryMeta: QueryMeta[];
        databases: DbBucket[];
      };

      // Group databases by type (preserves insertion order = entity order).
      const typeGroups = new Map<string, Group>();

      for (const { db, metrics } of metricsPerDb) {
        const dbType = db.type;
        const typeName = db.databaseType?.displayName || db.type;

        if (!typeGroups.has(dbType)) {
          const queryMeta: QueryMeta[] = [];
          if (db.databaseType?.monitoringConfig) {
            const config = safeJsonParse(db.databaseType.monitoringConfig, null) as {
              queries: QueryMeta[];
            } | null;
            for (const q of config?.queries ?? []) {
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

        const points = metrics.map((m) => ({
          time: m.collectedAt.toISOString(),
          parsed: safeJsonParse(m.metricsJson, {} as Record<string, unknown>),
        }));

        typeGroups.get(dbType)!.databases.push({
          id: db.id,
          name: db.name,
          serverId: db.server?.id || null,
          serverName: db.server?.name || null,
          points,
        });
      }

      // Project each group into the columnar shape.
      const types = Array.from(typeGroups.values()).map((group) => {
        // Union of timestamps across all dbs in this group.
        const tsSet = new Set<string>();
        for (const db of group.databases) for (const p of db.points) tsSet.add(p.time);
        const timestamps = Array.from(tsSet).sort();
        const tsIndex = new Map<string, number>();
        timestamps.forEach((t, i) => tsIndex.set(t, i));
        const T = timestamps.length;

        // series[queryName] = either number[][] (scalar/row.fields flattened)
        // or { rows: unknown[][] } (row/rows result kept structurally intact).
        const series: Record<string, unknown> = {};

        // Build a quick lookup for query resultType so we know how to bucket.
        const metaByName = new Map<string, QueryMeta>();
        for (const q of group.queryMeta) metaByName.set(q.name, q);

        // Discover keys used in the data — scalar queries flatten `row` results
        // as `${name}.${field}` (matching old behaviour). We compute this on a
        // first pass so the per-db row arrays all have consistent column sets.
        const scalarKeys = new Set<string>();
        const rowsKeys = new Set<string>(); // queries with resultType === 'rows' (array)

        for (const db of group.databases) {
          for (const p of db.points) {
            for (const [key, value] of Object.entries(p.parsed)) {
              const meta = metaByName.get(key);
              const resultType = meta?.resultType;

              if (resultType === 'rows' || Array.isArray(value)) {
                rowsKeys.add(key);
              } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                // row result — flatten fields into separate scalar keys
                for (const field of Object.keys(value as Record<string, unknown>)) {
                  scalarKeys.add(`${key}.${field}`);
                }
              } else {
                // scalar
                scalarKeys.add(key);
              }
            }
          }
        }

        // Allocate empty number[][] for scalar keys, { rows: ... } for rows.
        for (const key of scalarKeys) {
          series[key] = group.databases.map(() => new Array<number | null>(T).fill(null));
        }
        for (const key of rowsKeys) {
          series[key] = {
            rows: group.databases.map(() => new Array<unknown>(T).fill(null)),
          };
        }

        // Fill values.
        group.databases.forEach((db, dbIdx) => {
          for (const p of db.points) {
            const ti = tsIndex.get(p.time);
            if (ti === undefined) continue;
            for (const [key, value] of Object.entries(p.parsed)) {
              const meta = metaByName.get(key);
              const resultType = meta?.resultType;

              if (resultType === 'rows' || Array.isArray(value)) {
                const slot = series[key] as { rows: unknown[][] };
                slot.rows[dbIdx]![ti] = value;
              } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
                  const compound = `${key}.${field}`;
                  const arr = series[compound] as Array<Array<number | null>> | undefined;
                  if (arr) {
                    arr[dbIdx]![ti] = typeof fieldValue === 'number' ? fieldValue : (fieldValue as number | null);
                  }
                }
              } else {
                const arr = series[key] as Array<Array<number | null>> | undefined;
                if (arr) {
                  arr[dbIdx]![ti] = typeof value === 'number' ? value : (value as number | null);
                }
              }
            }
          }
        });

        return {
          type: group.type,
          typeName: group.typeName,
          queryMeta: group.queryMeta,
          databases: group.databases.map((db) => ({
            id: db.id,
            name: db.name,
            serverId: db.serverId,
            serverName: db.serverName,
          })),
          timestamps,
          series,
        };
      });

      return { types };
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
        latestMetrics: db.metrics[0] ? safeJsonParse(db.metrics[0].metricsJson, {} as Record<string, unknown>) : null,
        monitoringConfig: db.databaseType?.monitoringConfig
          ? safeJsonParse(db.databaseType.monitoringConfig, null)
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

      const database = await findOrNotFound(
        prisma.database.findUnique({
          where: { id },
          include: {
            databaseType: { select: { monitoringConfig: true } },
          },
        }),
        'Database',
        reply
      );
      if (!database) return;

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
          data: safeJsonParse(m.metricsJson, {} as Record<string, unknown>),
        })),
        monitoringConfig: database.databaseType?.monitoringConfig
          ? safeJsonParse(database.databaseType.monitoringConfig, null)
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

      const database = await findOrNotFound(
        prisma.database.findUnique({
          where: { id },
          include: { databaseType: true, server: true },
        }),
        'Database',
        reply
      );
      if (!database) return;

      try {
        const result = await pingDatabase(database, envId);
        return result;
      } catch (error) {
        const message = getErrorMessage(error, 'Connection failed');
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

      const database = await findOrNotFound(
        prisma.database.findUnique({ where: { id } }),
        'Database',
        reply
      );
      if (!database) return;

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
        ...actorFrom(request),
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
