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
  listEnvironmentBackupSummary,
  rotateDatabase,
  resolveRetentionPolicy,
  globalDefaultPolicyFromSettings,
  PRESETS,
  RETENTION_BOUNDS,
  type EffectivePolicy,
} from '../services/database-backup.js';
import { getSystemSettings } from '../services/system-settings.js';
import { sendSystemNotification, NOTIFICATION_TYPES } from '../services/notifications.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { userIdForFk } from '../services/auth.js';
import { prisma } from '../lib/db.js';
import { requireOperator } from '../plugins/authorize.js';
import { collectDatabaseMetrics } from '../services/database-monitoring-collector.js';
import { pingDatabase } from '../services/database-query-executor.js';
import {
  safeJsonParse,
  validateBody,
  validateUpdateBody,
  findOrNotFound,
  getErrorMessage,
  handleUniqueConstraint,
  parsePaginationQuery,
  coerceNumeric,
  formatBytes,
} from '../lib/helpers.js';
import { downsampleColumnar } from '../lib/metrics-downsample.js';
import { routeSchema, paginationQuerySchema } from '../lib/openapi-schema.js';

const idParamSchema = z.object({ id: z.string() });
const envIdParamSchema = z.object({ envId: z.string() });
const envIdIdParamSchema = z.object({ envId: z.string(), id: z.string() });

// Query schema (documentation only). Runtime read stays unchanged
// (parseInt with fallbacks), so this never rejects.
const databaseMetricsQuerySchema = z.object({
  hours: z.coerce.number().min(1).optional(),
});

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

// ── Backup retention policy (issue #291) ──────────────────────────────────
// Tier bounds reuse RETENTION_BOUNDS (single source of truth from the service).
const presetSchema = z.enum(['lean', 'balanced', 'long_term', 'custom']);

const retentionTierFields = {
  keepLast: z.number().int().min(RETENTION_BOUNDS.keepLast.min).max(RETENTION_BOUNDS.keepLast.max),
  daily: z.number().int().min(RETENTION_BOUNDS.daily.min).max(RETENTION_BOUNDS.daily.max),
  weekly: z.number().int().min(RETENTION_BOUNDS.weekly.min).max(RETENTION_BOUNDS.weekly.max),
  monthly: z.number().int().min(RETENTION_BOUNDS.monthly.min).max(RETENTION_BOUNDS.monthly.max),
  yearly: z.number().int().min(RETENTION_BOUNDS.yearly.min).max(RETENTION_BOUNDS.yearly.max),
  minFloor: z.number().int().min(RETENTION_BOUNDS.minFloor.min).max(RETENTION_BOUNDS.minFloor.max),
} as const;

// PUT body: full policy (tier fields required) + optional inheritGlobal/cap/confirm.
const backupPolicySchema = z.object({
  inheritGlobal: z.boolean().optional(),
  preset: presetSchema,
  ...retentionTierFields,
  maxTotalBytes: z.number().int().min(0).nullable().optional(),
  confirm: z.boolean().optional(),
});

// Preview body: an OPTIONAL proposed policy (same tier fields, all optional;
// absent = preview the current effective policy). No `confirm`.
const backupPolicyPreviewSchema = z.object({
  inheritGlobal: z.boolean().optional(),
  preset: presetSchema.optional(),
  keepLast: retentionTierFields.keepLast.optional(),
  daily: retentionTierFields.daily.optional(),
  weekly: retentionTierFields.weekly.optional(),
  monthly: retentionTierFields.monthly.optional(),
  yearly: retentionTierFields.yearly.optional(),
  minFloor: retentionTierFields.minFloor.optional(),
  maxTotalBytes: z.number().int().min(0).nullable().optional(),
}).optional();

// Pin body: the desired pinned state. PUT .../pin is idempotent — `true` pins,
// `false` unpins (replaces the former POST .../pin + POST .../unpin pair).
const backupPinSchema = z.object({ pinned: z.boolean() });

// Query schema for the database /metrics/history endpoint. Mirrors the shape
// used by /api/environments/:envId/metrics/history in routes/monitoring.ts so
// `since` gets the same strict ISO-datetime check (rejecting malformed input
// at the API edge instead of letting `new Date('garbage')` silently widen the
// query window to "Invalid Date").
const databaseMetricsHistoryQuerySchema = z.object({
  hours: z.coerce.number().min(1).max(168).default(24),
  since: z.string().datetime().optional(),
  maxPoints: z.coerce.number().min(10).max(2000).default(120),
});

type BackupPolicyBody = z.infer<typeof backupPolicySchema>;
type BackupPolicyPreviewBody = NonNullable<z.infer<typeof backupPolicyPreviewSchema>>;

/**
 * Build the proposed EffectivePolicy a PUT would apply (issue #291 §6.5 step 1):
 *   - inheritGlobal=true  → the global default (source 'inherited').
 *   - non-custom preset   → tier fields from PRESETS[preset] (source 'override').
 *   - custom              → tier fields straight from the body (source 'override').
 * maxTotalBytes comes from the body (null = off) except when inheriting.
 */
function buildProposedPolicy(body: BackupPolicyBody, globalDefault: EffectivePolicy): EffectivePolicy {
  if (body.inheritGlobal) {
    return globalDefault;
  }
  const cap = body.maxTotalBytes == null ? null : BigInt(body.maxTotalBytes);
  // An operator-configured override always activates GFS, so autoApplied=false.
  if (body.preset !== 'custom') {
    const tiers = PRESETS[body.preset];
    return { ...tiers, maxTotalBytes: cap, preset: body.preset, source: 'override', autoApplied: false };
  }
  return {
    keepLast: body.keepLast,
    daily: body.daily,
    weekly: body.weekly,
    monthly: body.monthly,
    yearly: body.yearly,
    minFloor: body.minFloor,
    maxTotalBytes: cap,
    preset: 'custom',
    source: 'override',
    autoApplied: false,
  };
}

/**
 * Resolve the EffectivePolicy to preview (issue #291 §6.5 / §10 preview):
 * starts from the current effective policy, then overlays whatever the
 * (optional, partial) preview body specifies. inheritGlobal / a non-custom
 * preset take precedence the same way buildProposedPolicy handles them.
 */
function resolvePreviewPolicy(
  body: BackupPolicyPreviewBody | undefined,
  current: EffectivePolicy,
  globalDefault: EffectivePolicy
): EffectivePolicy {
  if (!body) return current;
  if (body.inheritGlobal) return globalDefault;

  // A preview always evaluates the policy as if it were active (the dry-run/
  // confirm gate must show real GFS outcomes), so autoApplied=false here.
  if (body.preset && body.preset !== 'custom') {
    const tiers = PRESETS[body.preset];
    const cap = body.maxTotalBytes === undefined ? current.maxTotalBytes : (body.maxTotalBytes == null ? null : BigInt(body.maxTotalBytes));
    return { ...tiers, maxTotalBytes: cap, preset: body.preset, source: 'override', autoApplied: false };
  }

  // Custom (or unspecified preset): overlay provided tier fields onto current.
  const cap = body.maxTotalBytes === undefined ? current.maxTotalBytes : (body.maxTotalBytes == null ? null : BigInt(body.maxTotalBytes));
  return {
    keepLast: body.keepLast ?? current.keepLast,
    daily: body.daily ?? current.daily,
    weekly: body.weekly ?? current.weekly,
    monthly: body.monthly ?? current.monthly,
    yearly: body.yearly ?? current.yearly,
    minFloor: body.minFloor ?? current.minFloor,
    maxTotalBytes: cap,
    preset: body.preset ?? current.preset,
    source: 'override',
    autoApplied: false,
  };
}

/** Serialize an EffectivePolicy for JSON (bigint maxTotalBytes → number|null). */
function serializePolicy(p: EffectivePolicy): Omit<EffectivePolicy, 'maxTotalBytes'> & { maxTotalBytes: number | null } {
  return { ...p, maxTotalBytes: p.maxTotalBytes == null ? null : Number(p.maxTotalBytes) };
}

/** Load per-backup detail for the preview keep/prune lists (size → number). */
async function backupPreviewDetails(ids: string[]): Promise<
  { id: string; filename: string; createdAt: Date; size: number }[]
> {
  if (ids.length === 0) return [];
  const rows = await prisma.databaseBackup.findMany({
    where: { id: { in: ids } },
    select: { id: true, filename: true, createdAt: true, size: true },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({ id: r.id, filename: r.filename, createdAt: r.createdAt, size: Number(r.size) }));
}

export async function databaseRoutes(fastify: FastifyInstance): Promise<void> {
  // List databases for environment
  fastify.get(
    '/api/environments/:envId/databases',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'List databases for an environment',
        params: envIdParamSchema,
        querystring: paginationQuerySchema,
        errors: [401],
      }),
    },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const { limit, offset } = parsePaginationQuery(request.query as Record<string, unknown>);
      return listDatabases(envId, { limit, offset });
    }
  );

  // Create database
  fastify.post(
    '/api/environments/:envId/databases',
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Create a database in an environment',
        params: envIdParamSchema,
        body: createDatabaseSchema,
        errors: [400, 401, 403, 409],
      }),
    },
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
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Get a database by id',
        params: idParamSchema,
        errors: [401, 404],
      }),
    },
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
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Update a database',
        params: idParamSchema,
        body: updateDatabaseSchema,
        errors: [400, 401, 403, 404, 422],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      // Rejects PATCH of derived/system fields (encryptedCredentials, monitoring
      // state, etc.) atomically — see src/lib/readonly-fields.ts.
      const body = validateUpdateBody(updateDatabaseSchema, 'database', request, reply);
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
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Delete a database (must have no backups)',
        params: idParamSchema,
        errors: [400, 401, 403, 404],
      }),
    },
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
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Trigger a backup for a database',
        params: idParamSchema,
        errors: [401, 403, 404, 500],
      }),
    },
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
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'List backups for a database',
        params: idParamSchema,
        querystring: paginationQuerySchema,
        errors: [401, 404],
      }),
    },
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
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Get backup details',
        params: idParamSchema,
        errors: [401, 404],
      }),
    },
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
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Download a backup (file stream or presigned URL)',
        params: idParamSchema,
        errors: [400, 401],
      }),
    },
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
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Delete a backup',
        params: idParamSchema,
        errors: [401, 403, 404],
      }),
    },
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
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Get the backup schedule for a database',
        params: idParamSchema,
        errors: [401, 404],
      }),
    },
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
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Set the backup schedule for a database',
        params: idParamSchema,
        body: scheduleSchema,
        errors: [400, 401, 403, 404],
      }),
    },
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
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Delete the backup schedule for a database',
        params: idParamSchema,
        errors: [401, 403, 404],
      }),
    },
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

  // ==================== Backup Retention Policy (issue #291) ====================

  // Get the effective backup retention policy for a database (viewer).
  fastify.get(
    '/api/databases/:id/backup-policy',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Get the effective backup retention policy for a database',
        params: idParamSchema,
        errors: [401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

      const [effective, override, settings] = await Promise.all([
        resolveRetentionPolicy(id),
        prisma.backupRetentionPolicy.findUnique({ where: { databaseId: id } }),
        getSystemSettings(),
      ]);

      return {
        // `effective.autoApplied` (via serializePolicy) and `override.autoApplied`
        // (spread from the row) tell the UI that automatic pruning is PAUSED until
        // the operator saves this policy. autoApplied is made explicit below so the
        // response contract is stable regardless of the Prisma row shape.
        effective: serializePolicy(effective),
        override: override
          ? {
              ...override,
              autoApplied: override.autoApplied,
              maxTotalBytes: override.maxTotalBytes == null ? null : Number(override.maxTotalBytes),
            }
          : null,
        globalDefault: serializePolicy(globalDefaultPolicyFromSettings(settings)),
        source: effective.source,
      };
    }
  );

  // Set / replace the per-database retention override (operator). May require a
  // confirmation pass (§6.5) when the change would prune more than the threshold.
  fastify.put(
    '/api/databases/:id/backup-policy',
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Set or replace the backup retention policy for a database',
        params: idParamSchema,
        body: backupPolicySchema,
        errors: [400, 401, 403, 404, 409],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(backupPolicySchema, request, reply);
      if (!body) return;

      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

      const settings = await getSystemSettings();
      const proposed = buildProposedPolicy(body, globalDefaultPolicyFromSettings(settings));

      // Confirmation gate: dry-run the proposed policy. If it would prune more
      // than the threshold and the client hasn't confirmed, return the preview
      // WITHOUT saving (§6.5).
      const dryRun = await rotateDatabase(id, { dryRun: true, policy: proposed });
      if (dryRun.prune.length > settings.backupRotationConfirmThreshold && body.confirm !== true) {
        const [keep, prune] = await Promise.all([
          backupPreviewDetails(dryRun.keep),
          backupPreviewDetails(dryRun.prune),
        ]);
        return reply.code(409).send({
          confirmationRequired: true,
          preview: { keep, prune, bytesFreed: Number(dryRun.bytesFreed) },
        });
      }

      // Persist the override. inheritGlobal=true stores a row that the resolver
      // treats as "use the global default"; otherwise store the resolved tiers.
      // autoApplied=false on both branches: an operator deliberately configuring
      // (or saving) a policy activates GFS, clearing any inert migrated snapshot.
      const data = body.inheritGlobal
        ? {
            autoApplied: false,
            inheritGlobal: true,
            preset: body.preset,
            keepLast: proposed.keepLast,
            daily: proposed.daily,
            weekly: proposed.weekly,
            monthly: proposed.monthly,
            yearly: proposed.yearly,
            minFloor: proposed.minFloor,
            maxTotalBytes: proposed.maxTotalBytes,
          }
        : {
            autoApplied: false,
            inheritGlobal: false,
            preset: proposed.preset,
            keepLast: proposed.keepLast,
            daily: proposed.daily,
            weekly: proposed.weekly,
            monthly: proposed.monthly,
            yearly: proposed.yearly,
            minFloor: proposed.minFloor,
            maxTotalBytes: proposed.maxTotalBytes,
          };

      const override = await prisma.backupRetentionPolicy.upsert({
        where: { databaseId: id },
        create: { databaseId: id, ...data },
        update: data,
      });

      // Apply the new policy immediately (real rotation).
      const result = await rotateDatabase(id, { trigger: 'policy-change' });

      // First-prune-after-change notification (§12): only when this rotation
      // actually deleted at least one backup.
      if (result.prune.length > 0) {
        await sendSystemNotification(
          NOTIFICATION_TYPES.BACKUP_POLICY_FIRST_PRUNE,
          database.environmentId,
          {
            preset: proposed.preset,
            prunedCount: result.prune.length,
            // Human-readable (e.g. "1.5 GB") — the template interpolates this
            // string directly, so a raw byte integer would read poorly.
            bytesFreed: formatBytes(result.bytesFreed),
            databaseName: database.name,
          }
        );
      }

      await logAudit({
        action: 'update',
        resourceType: 'backup_retention_policy',
        resourceId: override.id,
        resourceName: database.name,
        details: {
          databaseId: id,
          inheritGlobal: override.inheritGlobal,
          preset: override.preset,
          keepLast: override.keepLast,
          daily: override.daily,
          weekly: override.weekly,
          monthly: override.monthly,
          yearly: override.yearly,
          minFloor: override.minFloor,
          maxTotalBytes: override.maxTotalBytes == null ? null : Number(override.maxTotalBytes),
          prunedCount: result.prune.length,
        },
        ...actorFrom(request),
        environmentId: database.environmentId,
      });

      return {
        override: { ...override, maxTotalBytes: override.maxTotalBytes == null ? null : Number(override.maxTotalBytes) },
        rotation: {
          keep: result.keep,
          prune: result.prune,
          bytesFreed: Number(result.bytesFreed),
          cappedButUnreachable: result.cappedButUnreachable,
        },
      };
    }
  );

  // Revert a database to inheriting the global default (operator).
  fastify.delete(
    '/api/databases/:id/backup-policy',
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Revert a database to the global default retention policy',
        params: idParamSchema,
        errors: [401, 403, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

      // Delete the override row so the resolver falls back to the global default.
      await prisma.backupRetentionPolicy.delete({ where: { databaseId: id } }).catch(() => {
        /* no override row → already inheriting; idempotent */
      });

      await logAudit({
        action: 'delete',
        resourceType: 'backup_retention_policy',
        resourceName: database.name,
        details: { databaseId: id },
        ...actorFrom(request),
        environmentId: database.environmentId,
      });

      const effective = await resolveRetentionPolicy(id);
      return { effective: serializePolicy(effective), source: effective.source };
    }
  );

  // Dry-run preview of a (proposed or current) policy (viewer).
  fastify.post(
    '/api/databases/:id/backup-policy/preview',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Preview the keep/prune outcome of a backup retention policy',
        params: idParamSchema,
        body: backupPolicyPreviewSchema,
        errors: [400, 401, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      // Body is optional; when omitted/empty we preview the current policy.
      // Validate inline (the schema is `.optional()`, so undefined parses fine).
      const parsed = backupPolicyPreviewSchema.safeParse(request.body ?? undefined);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Invalid input', details: parsed.error.issues });
      }
      const body = parsed.data as BackupPolicyPreviewBody | undefined;

      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

      const [current, settings] = await Promise.all([
        resolveRetentionPolicy(id),
        getSystemSettings(),
      ]);
      const policy = resolvePreviewPolicy(body, current, globalDefaultPolicyFromSettings(settings));

      const result = await rotateDatabase(id, { dryRun: true, policy });
      const [keep, prune] = await Promise.all([
        backupPreviewDetails(result.keep),
        backupPreviewDetails(result.prune),
      ]);

      return {
        policy: serializePolicy(policy),
        keep,
        prune,
        bytesFreed: Number(result.bytesFreed),
        cappedButUnreachable: result.cappedButUnreachable,
      };
    }
  );

  // Run rotation now using the stored policy (operator).
  fastify.post(
    '/api/databases/:id/rotate',
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Rotate a database\'s backups now using its current policy',
        params: idParamSchema,
        errors: [401, 403, 404],
      }),
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

      const result = await rotateDatabase(id, { trigger: 'manual' });

      await logAudit({
        action: 'backup.rotate',
        resourceType: 'database',
        resourceId: id,
        resourceName: database.name,
        details: {
          databaseId: id,
          prunedCount: result.prune.length,
          bytesFreed: Number(result.bytesFreed),
          trigger: 'manual',
        },
        ...actorFrom(request),
        environmentId: database.environmentId,
      });

      return {
        keep: result.keep,
        prune: result.prune,
        bytesFreed: Number(result.bytesFreed),
        cappedButUnreachable: result.cappedButUnreachable,
        errors: result.errors,
      };
    }
  );

  // Pin or unpin a backup (operator). Idempotent: PUT the desired pinned state.
  // `pinned: true` protects the backup from rotation forever; `pinned: false`
  // releases it back to normal rotation. Consolidates the former POST .../pin
  // and POST .../unpin into one documented, idempotent endpoint.
  fastify.put(
    '/api/databases/:id/backups/:backupId/pin',
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Pin or unpin a backup (pinned backups are never pruned by rotation)',
        params: z.object({ id: z.string(), backupId: z.string() }),
        body: backupPinSchema,
        errors: [400, 401, 403, 404],
      }),
    },
    async (request, reply) => {
      const { id, backupId } = request.params as { id: string; backupId: string };
      const body = validateBody(backupPinSchema, request, reply);
      if (!body) return;

      const database = await findOrNotFound(getDatabase(id), 'Database', reply);
      if (!database) return;

      // The backup must exist AND belong to this database.
      const existing = await prisma.databaseBackup.findFirst({
        where: { id: backupId, databaseId: id },
        select: { id: true },
      });
      if (!existing) {
        return reply.code(404).send({ error: 'Backup not found' });
      }

      const backup = await prisma.databaseBackup.update({
        where: { id: backupId },
        data: body.pinned
          // Pinning exempts the backup from pruning forever, so any stale
          // lastRotationError (an orphan we'll never retry) is cleared too.
          ? { isPinned: true, pinnedById: userIdForFk(request.authUser!), pinnedAt: new Date(), lastRotationError: null }
          : { isPinned: false, pinnedById: null, pinnedAt: null },
      });

      await logAudit({
        action: body.pinned ? 'backup.pin' : 'backup.unpin',
        resourceType: 'backup',
        resourceId: backupId,
        resourceName: backup.filename,
        details: { databaseId: id },
        ...actorFrom(request),
        environmentId: database.environmentId,
      });

      return { backup: { ...backup, size: Number(backup.size) } };
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
              // Issue #171 — delta-refresh additions, see /metrics/history.
              mode: { type: 'string', enum: ['full', 'delta'] },
              until: { type: 'string' },
            },
          },
          400: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              details: {},
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      // Reject malformed query params at the edge so callers see a 400 rather
      // than a silent fallback to an "Invalid Date" window. Mirrors the
      // monitoring.ts /metrics/history validation.
      const query = databaseMetricsHistoryQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: 'Invalid query', details: query.error.issues });
      }
      const { hours: hoursNum, since: sinceIso, maxPoints } = query.data;
      const isDelta = !!sinceIso;
      const since = sinceIso
        ? new Date(sinceIso)
        : (() => {
            const d = new Date();
            d.setHours(d.getHours() - hoursNum);
            return d;
          })();
      // Capture server-now before reading metrics so the next delta starts
      // exactly where this response left off.
      const until = new Date().toISOString();

      // Get all monitored databases with server and type info
      const databases = await prisma.database.findMany({
        where: { environmentId: envId, monitoringEnabled: true },
        include: {
          server: { select: { id: true, name: true, tags: true } },
          databaseType: { select: { id: true, name: true, displayName: true, monitoringConfig: true } },
        },
      });

      // Fetch all metrics for all databases in a single query, then bucket by
      // databaseId. This used to be N parallel findMany calls (one per db)
      // which blocked the ≥800 RPS / p99 ≤30 ms target. Matches the pattern
      // used by /metrics/history in routes/monitoring.ts.
      const databaseIds = databases.map((d) => d.id);
      // Delta requests use a strict `gt` so the boundary row isn't replayed
      // (the client already has it). Full-window requests use `gte`.
      const allMetrics =
        databaseIds.length === 0
          ? []
          : await prisma.databaseMetrics.findMany({
              where: {
                databaseId: { in: databaseIds },
                collectedAt: isDelta ? { gt: since } : { gte: since },
              },
              orderBy: { collectedAt: 'asc' },
            });

      // Group by databaseId in memory. `orderBy collectedAt asc` on the query
      // means each bucket preserves the ascending order without re-sorting.
      const metricsByDbId = new Map<string, typeof allMetrics>();
      for (const id of databaseIds) metricsByDbId.set(id, []);
      for (const m of allMetrics) metricsByDbId.get(m.databaseId)?.push(m);

      // Preserve the existing iteration order over `databases` (used to build
      // the `databases[]` metadata in the response).
      const metricsPerDb = databases.map((db) => ({
        db,
        metrics: metricsByDbId.get(db.id) ?? [],
      }));

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
        //
        // Bucketing rules (resolved before allocation so each key lives in
        // EXACTLY one of scalarKeys / rowsKeys):
        //   - If the query's declared `resultType` is 'rows' → rowsKeys.
        //   - If the query's declared `resultType` is 'scalar' → scalarKeys
        //     (even if a specific point's value happens to be an array — we
        //     respect the declared shape, otherwise UI's prepareScalarChartData
        //     silently renders empty because the slot is `{ rows }`).
        //   - If the query's declared `resultType` is 'row' → flatten into
        //     `${name}.${field}` scalar keys (matching old behaviour).
        //   - For keys WITHOUT meta, fall back to value-shape dispatch.
        // Finally: if a key ends up in BOTH buckets (mixed-shape values for a
        // meta-less key), `rowsKeys` wins — see the cleanup pass below.
        const scalarKeys = new Set<string>();
        const rowsKeys = new Set<string>(); // queries with resultType === 'rows' (array)

        for (const db of group.databases) {
          for (const p of db.points) {
            for (const [key, value] of Object.entries(p.parsed)) {
              const meta = metaByName.get(key);
              const resultType = meta?.resultType;

              if (resultType === 'rows') {
                rowsKeys.add(key);
              } else if (resultType === 'scalar') {
                // Declared scalar — keep as scalar even if value is array/null.
                scalarKeys.add(key);
              } else if (resultType === 'row') {
                // Declared row — flatten any record-shaped value's fields.
                if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                  for (const field of Object.keys(value as Record<string, unknown>)) {
                    scalarKeys.add(`${key}.${field}`);
                  }
                }
              } else if (Array.isArray(value)) {
                // No meta — infer from value shape.
                rowsKeys.add(key);
              } else if (value !== null && typeof value === 'object') {
                for (const field of Object.keys(value as Record<string, unknown>)) {
                  scalarKeys.add(`${key}.${field}`);
                }
              } else {
                scalarKeys.add(key);
              }
            }
          }
        }

        // If a meta-less key picked up both shapes across points, prefer rows
        // (safer: the UI can render a stale-shape table; an empty chart is
        // acceptable). Removing from scalarKeys also resolves the dispatch
        // ambiguity in the fill loop below.
        for (const key of rowsKeys) {
          if (scalarKeys.has(key)) scalarKeys.delete(key);
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

        // Fill values. Route by KEY membership (not per-point value shape) so
        // a meta-less key that was bucketed into rowsKeys at discovery time
        // doesn't crash when a specific point's value is scalar/null.
        group.databases.forEach((db, dbIdx) => {
          for (const p of db.points) {
            const ti = tsIndex.get(p.time);
            if (ti === undefined) continue;
            for (const [key, value] of Object.entries(p.parsed)) {
              if (rowsKeys.has(key)) {
                // Store the value as-is; the rows slot is unknown[][] so any
                // shape (array, scalar, null, object) is permitted. The UI
                // checks Array.isArray() before rendering.
                const slot = series[key] as { rows: unknown[][] };
                slot.rows[dbIdx]![ti] = value;
              } else if (scalarKeys.has(key)) {
                // Direct scalar fill. node-postgres returns int8/numeric columns
                // as strings, so coerce before the numeric check — otherwise
                // every Postgres scalar series is all-null and the chart is
                // empty. Non-numeric values (arrays, objects, text) → null.
                const arr = series[key] as Array<Array<number | null>>;
                const num = coerceNumeric(value);
                arr[dbIdx]![ti] = typeof num === 'number' ? num : null;
              } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                // Compound row-flatten case — fields end up in `${key}.${field}`
                // entries that were registered as scalarKeys during discovery.
                for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
                  const compound = `${key}.${field}`;
                  const arr = series[compound] as Array<Array<number | null>> | undefined;
                  if (arr) {
                    const num = coerceNumeric(fieldValue);
                    arr[dbIdx]![ti] = typeof num === 'number' ? num : null;
                  }
                }
              }
            }
          }
        });

        // Apply LTTB downsampling to scalar series in full-window responses.
        // `rows` queries hold structural snapshots (UI uses the latest point
        // only — see `getRowsPerDatabase` in MonitoringDatabases.tsx), so
        // downsampling them would lose history with no chart benefit.
        // Delta payloads return as-is so the merge step on the client stays
        // a simple append.
        let outTimestamps = timestamps;
        let outSeries: Record<string, unknown> = series;
        if (!isDelta && scalarKeys.size > 0 && timestamps.length > maxPoints) {
          const scalarKeyList = Array.from(scalarKeys);
          const flatRows: Array<Array<number | null>> = [];
          const counts: number[] = [];
          for (const key of scalarKeyList) {
            const arr = series[key] as Array<Array<number | null>>;
            counts.push(arr.length);
            for (const r of arr) flatRows.push(r);
          }
          const ds = downsampleColumnar(timestamps, flatRows, maxPoints);
          outTimestamps = ds.timestamps;

          // Build the projected series: downsampled scalars + project rows
          // onto the picked indices (latest-snapshot reads still work as
          // long as the final picked index carries the latest sample, which
          // LTTB preserves by always keeping index n-1).
          const projected: Record<string, unknown> = {};
          let cursor = 0;
          scalarKeyList.forEach((key, i) => {
            projected[key] = ds.rows.slice(cursor, cursor + counts[i]);
            cursor += counts[i];
          });

          // For rows-keys we don't have a numeric axis, so project onto the
          // picked indices by index lookup. Resolve picked indices by
          // searching the original `timestamps` for each new timestamp —
          // O(maxPoints) per row but maxPoints is small.
          if (rowsKeys.size > 0) {
            const tsToOldIdx = new Map<string, number>();
            timestamps.forEach((t, i) => tsToOldIdx.set(t, i));
            const pickedOldIdx = outTimestamps.map((t) => tsToOldIdx.get(t)!);
            for (const key of rowsKeys) {
              const slot = series[key] as { rows: unknown[][] };
              projected[key] = {
                rows: slot.rows.map((dbRow) => pickedOldIdx.map((oi) => dbRow[oi] ?? null)),
              };
            }
          }
          outSeries = projected;
        }

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
          timestamps: outTimestamps,
          series: outSeries,
        };
      });

      return { types, mode: isDelta ? 'delta' : 'full', until };
    }
  );

  // Get backup summary for all databases in an environment.
  // Single batched call backing the dashboard's "Database Backups" card —
  // replaces the per-database N+1 fan-out (listDatabaseBackups + getBackupSchedule).
  fastify.get(
    '/api/environments/:envId/databases/backup-summary',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Get the backup summary for all databases in an environment',
        params: envIdParamSchema,
        errors: [401],
      }),
    },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const databases = await listEnvironmentBackupSummary(envId);
      return { databases };
    }
  );

  // Get monitoring summary for all databases in an environment
  fastify.get(
    '/api/environments/:envId/databases/monitoring-summary',
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Get the monitoring summary for all databases in an environment',
        params: envIdParamSchema,
        errors: [401],
      }),
    },
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
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Get metrics history for a specific database',
        params: envIdIdParamSchema,
        querystring: databaseMetricsQuerySchema,
        errors: [401, 404],
      }),
    },
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
    {
      preHandler: [fastify.authenticate],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Test a database connection (lightweight ping)',
        params: envIdIdParamSchema,
        errors: [401, 404],
      }),
    },
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
    {
      preHandler: [fastify.authenticate, requireOperator],
      schema: routeSchema({
        tags: ['monitoring'],
        summary: 'Update monitoring configuration for a database',
        params: envIdIdParamSchema,
        errors: [401, 403, 404],
      }),
    },
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
