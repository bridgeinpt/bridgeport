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
} from '../services/database-backup.js';
import { logAudit } from '../services/audit.js';

const databaseTypeSchema = z.enum(['postgres', 'mysql', 'sqlite']);
const storageTypeSchema = z.enum(['local', 'spaces']);

const createDatabaseSchema = z.object({
  name: z.string().min(1),
  type: databaseTypeSchema,
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
});

const updateDatabaseSchema = createDatabaseSchema.partial();

const scheduleSchema = z.object({
  cronExpression: z.string().min(1),
  retentionDays: z.number().min(1).max(365).optional(),
  enabled: z.boolean().optional(),
});

export async function databaseRoutes(fastify: FastifyInstance) {
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
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = createDatabaseSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const database = await createDatabase(envId, body.data);

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
    { preHandler: [fastify.authenticate] },
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
    { preHandler: [fastify.authenticate] },
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
    { preHandler: [fastify.authenticate] },
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

      const database = await getDatabase(id);
      if (!database) {
        return reply.code(404).send({ error: 'Database not found' });
      }

      const backups = await listBackups(id);
      return {
        backups: backups.map((b) => ({
          ...b,
          size: Number(b.size), // Convert BigInt to number for JSON
        })),
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

      return {
        backup: {
          ...backup,
          size: Number(backup.size),
        },
      };
    }
  );

  // Delete backup
  fastify.delete(
    '/api/backups/:id',
    { preHandler: [fastify.authenticate] },
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
    { preHandler: [fastify.authenticate] },
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
    { preHandler: [fastify.authenticate] },
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
}
