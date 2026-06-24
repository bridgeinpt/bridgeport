import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { createTestDatabase } from '../../tests/factories/database.js';
import { createTestServer } from '../../tests/factories/server.js';
import { generateTestToken } from '../../tests/helpers/auth.js';
import {
  rotateDatabase,
  pruneBackup,
  markStuckBackupsFailed,
  cleanupFailedBackups,
} from '../services/database-backup.js';
import * as environmentsModule from './environments.js';
import { S3Client } from '@aws-sdk/client-s3';
import { updateSystemSettings } from '../services/system-settings.js';

/**
 * Integration tests for GFS backup rotation (issue #291 §14).
 *
 * Real SQLite + real Fastify (config/vitest.config.ts). Storage clients are
 * NOT hit for real:
 *  - Local-storage success path uses a real `LocalClient` against a localhost
 *    server, so `rm -f -- <tmpfile>` actually runs (and idempotently succeeds
 *    even when the file is gone) — no mocking needed.
 *  - The Spaces failure / idempotent-retry path is exercised by spying on the
 *    `getEnvironmentSpacesConfig` seam and `S3Client.prototype.send`; both spies
 *    are restored in afterEach so nothing leaks to other integration files
 *    (this suite runs in the shared isolate:false process).
 */
describe('backup rotation (issue #291)', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let operatorToken: string;
  let tmpBackupDir: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const admin = await createTestUser(app.prisma, { email: 'admin@rotation.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@rotation.test', role: 'viewer' });
    const operator = await createTestUser(app.prisma, { email: 'op@rotation.test', role: 'operator' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });
    operatorToken = await generateTestToken({ id: operator.id, email: operator.email });

    tmpBackupDir = mkdtempSync(join(tmpdir(), 'bridgeport-rotation-'));
  });

  afterAll(async () => {
    await app.close();
    if (tmpBackupDir && existsSync(tmpBackupDir)) {
      rmSync(tmpBackupDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- helpers ---------------------------------------------------------------

  /** A localhost server so deleteBackupArtifact uses a real LocalClient (rm -f). */
  async function localhostServer(envId: string, name: string) {
    return createTestServer(app.prisma, { environmentId: envId, name, hostname: 'localhost' });
  }

  interface SeedBackupOpts {
    databaseId: string;
    createdAt: Date;
    type?: 'manual' | 'scheduled';
    status?: string;
    isPinned?: boolean;
    size?: bigint;
    storageType?: 'local' | 'spaces';
    storagePath?: string;
    makeFile?: boolean; // create a real file at storagePath (local only)
  }

  /** Seed a DatabaseBackup row, optionally writing a real local artifact. */
  async function seedBackup(opts: SeedBackupOpts) {
    const filename = `bk-${opts.createdAt.toISOString().replace(/[:.]/g, '-')}.sql`;
    const storagePath = opts.storagePath ?? join(tmpBackupDir, filename);
    if (opts.makeFile && (opts.storageType ?? 'local') === 'local') {
      writeFileSync(storagePath, 'dummy backup contents');
    }
    return app.prisma.databaseBackup.create({
      data: {
        databaseId: opts.databaseId,
        filename,
        size: opts.size ?? BigInt(10),
        type: opts.type ?? 'scheduled',
        status: opts.status ?? 'completed',
        isPinned: opts.isPinned ?? false,
        storageType: opts.storageType ?? 'local',
        storagePath,
        createdAt: opts.createdAt,
        completedAt: opts.createdAt,
      },
    });
  }

  async function remainingIds(databaseId: string): Promise<string[]> {
    const rows = await app.prisma.databaseBackup.findMany({
      where: { databaseId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  // ==========================================================================
  // §14 — Migration / backfill (run the actual migration backfill SQL).
  // ==========================================================================
  //
  // The integration DB is created with `prisma db push` (schema only), so the
  // committed migration's data-backfill statement is NOT auto-run here. We run
  // the EXACT backfill SQL from
  // prisma/migrations/20260624145904_add_backup_rotation_policy/migration.sql
  // against the real SQLite DB to prove its behaviour.
  describe('migration backfill of legacy retentionDays', () => {
    // Kept byte-for-byte in sync with the migration's final INSERT…SELECT.
    const BACKFILL_SQL = `
INSERT INTO "BackupRetentionPolicy" ("id","databaseId","inheritGlobal","preset","keepLast","daily","weekly","monthly","yearly","minFloor","createdAt","updatedAt")
SELECT lower(hex(randomblob(16))), "databaseId", 0, 'custom', 12, MIN("retentionDays",366), 0, 0, 0, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "BackupSchedule"
GROUP BY "databaseId"`;

    // The backfill is a one-shot migration step (INSERT…SELECT…GROUP BY over
    // ALL schedules). In the shared test DB, start each case from a clean slate
    // for these two tables so the GROUP BY only sees this test's schedule and
    // the INSERT can't collide with a policy a prior case already created.
    beforeEach(async () => {
      await app.prisma.backupRetentionPolicy.deleteMany({});
      await app.prisma.backupSchedule.deleteMany({});
    });

    it('maps retentionDays=30 → daily=30, weekly/monthly/yearly=0, keepLast=12, minFloor=2, preset=custom', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'mig-30' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'mig-db-30' });
      await app.prisma.backupSchedule.create({
        data: { databaseId: db.id, cronExpression: '0 2 * * *', enabled: true, retentionDays: 30 },
      });

      await app.prisma.$executeRawUnsafe(BACKFILL_SQL);

      const policy = await app.prisma.backupRetentionPolicy.findUnique({ where: { databaseId: db.id } });
      expect(policy).not.toBeNull();
      expect(policy).toMatchObject({
        daily: 30,
        weekly: 0,
        monthly: 0,
        yearly: 0,
        keepLast: 12,
        minFloor: 2,
        preset: 'custom',
        inheritGlobal: false,
      });
    });

    it('caps daily at 366 for very large retentionDays', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'mig-cap' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'mig-db-cap' });
      await app.prisma.backupSchedule.create({
        data: { databaseId: db.id, cronExpression: '0 2 * * *', enabled: true, retentionDays: 9000 },
      });

      await app.prisma.$executeRawUnsafe(BACKFILL_SQL);

      const policy = await app.prisma.backupRetentionPolicy.findUnique({ where: { databaseId: db.id } });
      expect(policy?.daily).toBe(366);
    });

    it('first rotateDatabase after backfill deletes nothing the old flat policy would have kept', async () => {
      // Old behaviour: keep scheduled backups within `retentionDays` days.
      // With daily=N (and other tiers 0), the GFS pass keeps the newest backup
      // in each of the last N day-buckets — for one-per-day backups inside the
      // window that's every one of them, so nothing is pruned.
      const env = await createTestEnvironment(app.prisma, { name: 'mig-rotate' });
      const server = await localhostServer(env.id, 'mig-rotate-host');
      const db = await createTestDatabase(app.prisma, {
        environmentId: env.id,
        name: 'mig-db-rotate',
        serverId: server.id,
      });
      await app.prisma.backupSchedule.create({
        data: { databaseId: db.id, cronExpression: '0 2 * * *', enabled: true, retentionDays: 7 },
      });
      await app.prisma.$executeRawUnsafe(BACKFILL_SQL);

      // One scheduled backup per day for the last 5 days — all within the 7-day window.
      const now = Date.now();
      const DAY = 24 * 60 * 60 * 1000;
      const seeded: string[] = [];
      for (let d = 0; d < 5; d++) {
        const b = await seedBackup({
          databaseId: db.id,
          createdAt: new Date(now - d * DAY - 12 * 60 * 60 * 1000),
          makeFile: true,
        });
        seeded.push(b.id);
      }

      const result = await rotateDatabase(db.id, { trigger: 'sweep' });
      expect(result.prune).toEqual([]);
      expect((await remainingIds(db.id)).sort()).toEqual(seeded.sort());
    });
  });

  // ==========================================================================
  // §14 — rotateDatabase end-to-end (real prune via local rm -f).
  // ==========================================================================
  describe('rotateDatabase end-to-end', () => {
    it('keeps the GFS-selected rows and deletes the rest, freeing their bytes', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'rotate-e2e' });
      const server = await localhostServer(env.id, 'rotate-e2e-host');
      const db = await createTestDatabase(app.prisma, {
        environmentId: env.id,
        name: 'rotate-e2e-db',
        serverId: server.id,
      });

      // Override policy: keepLast=1, daily=2, others 0, minFloor=1. So we keep
      // the newest backup overall + the newest in each of the last 2 day-buckets.
      await app.prisma.backupRetentionPolicy.create({
        data: {
          databaseId: db.id,
          inheritGlobal: false,
          preset: 'custom',
          keepLast: 1,
          daily: 2,
          weekly: 0,
          monthly: 0,
          yearly: 0,
          minFloor: 1,
        },
      });

      const DAY = 24 * 60 * 60 * 1000;
      const base = Date.parse('2026-03-10T12:00:00Z');
      // day 0 (Mar 10): two backups — newest is the day-bucket winner.
      const d0early = await seedBackup({ databaseId: db.id, createdAt: new Date(base - 6 * 60 * 60 * 1000), size: 100n, makeFile: true });
      const d0late = await seedBackup({ databaseId: db.id, createdAt: new Date(base), size: 100n, makeFile: true });
      // day 1 (Mar 9)
      const d1 = await seedBackup({ databaseId: db.id, createdAt: new Date(base - 1 * DAY), size: 100n, makeFile: true });
      // day 2 (Mar 8) — outside the 2 most-recent day buckets and keepLast=1 → pruned.
      const d2 = await seedBackup({ databaseId: db.id, createdAt: new Date(base - 2 * DAY), size: 100n, makeFile: true });
      // day 3 (Mar 7) — pruned.
      const d3 = await seedBackup({ databaseId: db.id, createdAt: new Date(base - 3 * DAY), size: 100n, makeFile: true });

      const result = await rotateDatabase(db.id, { trigger: 'manual' });

      // Keep: d0late (keepLast + day-bucket Mar10), d1 (day-bucket Mar9). Prune: d0early, d2, d3.
      expect(new Set(result.keep)).toEqual(new Set([d0late.id, d1.id]));
      expect(new Set(result.prune)).toEqual(new Set([d0early.id, d2.id, d3.id]));
      expect(result.bytesFreed).toBe(300n);

      expect((await remainingIds(db.id)).sort()).toEqual([d0late.id, d1.id].sort());
      // Files of pruned backups are gone; kept files remain.
      expect(existsSync(d0early.storagePath)).toBe(false);
      expect(existsSync(d2.storagePath)).toBe(false);
      expect(existsSync(d0late.storagePath)).toBe(true);

      // Audit log written for the pass.
      const audit = await app.prisma.auditLog.findFirst({
        where: { action: 'backup.rotate', resourceId: db.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).not.toBeNull();
    });

    it('never prunes manual or pinned backups, and excludes failed/in_progress from tiers', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'rotate-exempt' });
      const server = await localhostServer(env.id, 'rotate-exempt-host');
      const db = await createTestDatabase(app.prisma, {
        environmentId: env.id,
        name: 'rotate-exempt-db',
        serverId: server.id,
      });
      // Aggressive policy that would prune everything prunable beyond the floor.
      await app.prisma.backupRetentionPolicy.create({
        data: { databaseId: db.id, inheritGlobal: false, preset: 'custom', keepLast: 0, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1 },
      });

      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const manual = await seedBackup({ databaseId: db.id, createdAt: new Date(now - 10 * DAY), type: 'manual', makeFile: true });
      const pinned = await seedBackup({ databaseId: db.id, createdAt: new Date(now - 9 * DAY), type: 'scheduled', isPinned: true, makeFile: true });
      const failed = await seedBackup({ databaseId: db.id, createdAt: new Date(now - 1 * DAY), status: 'failed', makeFile: true });
      const inProgress = await seedBackup({ databaseId: db.id, createdAt: new Date(now), status: 'in_progress', makeFile: true });
      const oldScheduled = await seedBackup({ databaseId: db.id, createdAt: new Date(now - 8 * DAY), type: 'scheduled', makeFile: true });
      const newScheduled = await seedBackup({ databaseId: db.id, createdAt: new Date(now - 7 * DAY), type: 'scheduled', makeFile: true });

      const result = await rotateDatabase(db.id, { trigger: 'manual' });

      // Prunable universe = {oldScheduled, newScheduled}. All tiers are 0, and
      // the floor (minFloor=1) is already satisfied by the exempt-successful
      // backups (the completed manual + the pinned scheduled), so the floor
      // pulls nothing back — BOTH scheduled backups are pruned.
      expect(new Set(result.prune)).toEqual(new Set([oldScheduled.id, newScheduled.id]));

      const remaining = new Set(await remainingIds(db.id));
      // Manual, pinned, failed, in_progress are all untouched by rotation.
      expect(remaining.has(manual.id)).toBe(true);
      expect(remaining.has(pinned.id)).toBe(true);
      expect(remaining.has(failed.id)).toBe(true);
      expect(remaining.has(inProgress.id)).toBe(true);
      // Only the prunable scheduled backups were removed.
      expect(remaining.has(newScheduled.id)).toBe(false);
      expect(remaining.has(oldScheduled.id)).toBe(false);
    });

    it('the safety floor pulls the newest scheduled backup back into keep when no exempt backups satisfy it', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'rotate-floor' });
      const server = await localhostServer(env.id, 'rotate-floor-host');
      const db = await createTestDatabase(app.prisma, {
        environmentId: env.id,
        name: 'rotate-floor-db',
        serverId: server.id,
      });
      // All tiers 0, minFloor=2, and NO exempt backups → floor must retain the
      // 2 most-recent scheduled backups.
      await app.prisma.backupRetentionPolicy.create({
        data: { databaseId: db.id, inheritGlobal: false, preset: 'custom', keepLast: 0, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 2 },
      });
      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const newest = await seedBackup({ databaseId: db.id, createdAt: new Date(now), makeFile: true });
      const second = await seedBackup({ databaseId: db.id, createdAt: new Date(now - DAY), makeFile: true });
      const oldest = await seedBackup({ databaseId: db.id, createdAt: new Date(now - 2 * DAY), makeFile: true });

      const result = await rotateDatabase(db.id, { trigger: 'manual' });
      expect(new Set(result.keep)).toEqual(new Set([newest.id, second.id]));
      expect(result.prune).toEqual([oldest.id]);
    });

    it('dryRun previews the prune set without deleting anything', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'rotate-dry' });
      const server = await localhostServer(env.id, 'rotate-dry-host');
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'rotate-dry-db', serverId: server.id });
      await app.prisma.backupRetentionPolicy.create({
        data: { databaseId: db.id, inheritGlobal: false, preset: 'custom', keepLast: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1 },
      });
      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const keep = await seedBackup({ databaseId: db.id, createdAt: new Date(now), size: 5n, makeFile: true });
      const prune = await seedBackup({ databaseId: db.id, createdAt: new Date(now - DAY), size: 7n, makeFile: true });

      const result = await rotateDatabase(db.id, { dryRun: true });
      expect(result.keep).toEqual([keep.id]);
      expect(result.prune).toEqual([prune.id]);
      expect(result.bytesFreed).toBe(7n);
      // Nothing deleted.
      expect((await remainingIds(db.id)).sort()).toEqual([keep.id, prune.id].sort());
      expect(existsSync(prune.storagePath)).toBe(true);
    });
  });

  // ==========================================================================
  // §14 — pruneBackup failure path + idempotent retry.
  // ==========================================================================
  describe('pruneBackup failure path', () => {
    it('keeps the row and records lastRotationError when artifact deletion fails', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'prune-fail' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'prune-fail-db' });
      // Spaces-backed so we can deterministically fail at the storage seam.
      const backup = await seedBackup({
        databaseId: db.id,
        createdAt: new Date(),
        storageType: 'spaces',
        storagePath: 'prefix/backup.sql',
      });
      // Make the DB look like a Spaces target.
      await app.prisma.database.update({ where: { id: db.id }, data: { backupSpacesBucket: 'my-bucket' } });

      // Spaces config resolves, but the S3 delete throws a NON-404 error → real failure.
      vi.spyOn(environmentsModule, 'getEnvironmentSpacesConfig').mockResolvedValue({
        endpoint: 'nyc3.example.com',
        region: 'nyc3',
        accessKey: 'ak',
        secretKey: 'sk',
      } as never);
      const sendSpy = vi
        .spyOn(S3Client.prototype, 'send')
        .mockRejectedValueOnce(Object.assign(new Error('connection reset'), { name: 'NetworkingError' }) as never);

      const res = await pruneBackup(backup.id);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain('connection reset');
      expect(sendSpy).toHaveBeenCalledTimes(1);

      // Row is KEPT and lastRotationError is set.
      const row = await app.prisma.databaseBackup.findUnique({ where: { id: backup.id } });
      expect(row).not.toBeNull();
      expect(row?.lastRotationError).toContain('connection reset');
    });

    it('retry succeeds idempotently when the object is already gone (NoSuchKey → success), removing the row', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'prune-retry' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'prune-retry-db' });
      const backup = await seedBackup({
        databaseId: db.id,
        createdAt: new Date(),
        storageType: 'spaces',
        storagePath: 'prefix/backup.sql',
      });
      await app.prisma.database.update({ where: { id: db.id }, data: { backupSpacesBucket: 'my-bucket' } });

      vi.spyOn(environmentsModule, 'getEnvironmentSpacesConfig').mockResolvedValue({
        endpoint: 'nyc3.example.com',
        region: 'nyc3',
        accessKey: 'ak',
        secretKey: 'sk',
      } as never);
      // A missing object (NoSuchKey) is treated as idempotent success.
      vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
        Object.assign(new Error('not found'), { name: 'NoSuchKey' }) as never
      );

      const res = await pruneBackup(backup.id);
      expect(res.ok).toBe(true);
      // Row removed.
      const row = await app.prisma.databaseBackup.findUnique({ where: { id: backup.id } });
      expect(row).toBeNull();
    });

    it('rotateDatabase keeps a row whose prune fails and surfaces it in errors', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'rotate-prune-fail' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'rotate-prune-fail-db' });
      await app.prisma.database.update({ where: { id: db.id }, data: { backupSpacesBucket: 'my-bucket' } });
      await app.prisma.backupRetentionPolicy.create({
        data: { databaseId: db.id, inheritGlobal: false, preset: 'custom', keepLast: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1 },
      });
      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const keep = await seedBackup({ databaseId: db.id, createdAt: new Date(now), storageType: 'spaces', storagePath: 'prefix/keep.sql' });
      const prune = await seedBackup({ databaseId: db.id, createdAt: new Date(now - DAY), storageType: 'spaces', storagePath: 'prefix/prune.sql' });

      vi.spyOn(environmentsModule, 'getEnvironmentSpacesConfig').mockResolvedValue({
        endpoint: 'nyc3.example.com', region: 'nyc3', accessKey: 'ak', secretKey: 'sk',
      } as never);
      vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
        Object.assign(new Error('boom'), { name: 'NetworkingError' }) as never
      );

      const result = await rotateDatabase(db.id, { trigger: 'manual' });
      // The pruned candidate failed to delete → still present, reported in errors.
      expect(result.prune).toEqual([]); // nothing successfully pruned
      expect(result.errors?.map((e) => e.backupId)).toEqual([prune.id]);
      const remaining = new Set(await remainingIds(db.id));
      expect(remaining.has(keep.id)).toBe(true);
      expect(remaining.has(prune.id)).toBe(true);
    });
  });

  // ==========================================================================
  // §14 — Failed / stuck cleanup (§8).
  // ==========================================================================
  describe('markStuckBackupsFailed + cleanupFailedBackups', () => {
    it('marks an in_progress backup stuck past the pg_dump timeout + grace as failed', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'stuck' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'stuck-db' });
      // pgDumpTimeoutMs default 300000 (5m) + 5m grace = 10m. Older than that → stuck.
      const stuck = await seedBackup({ databaseId: db.id, createdAt: new Date(Date.now() - 20 * 60 * 1000), status: 'in_progress' });
      const fresh = await seedBackup({ databaseId: db.id, createdAt: new Date(Date.now() - 1 * 60 * 1000), status: 'in_progress' });

      const marked = await markStuckBackupsFailed();
      expect(marked).toBeGreaterThanOrEqual(1);

      const stuckRow = await app.prisma.databaseBackup.findUnique({ where: { id: stuck.id } });
      const freshRow = await app.prisma.databaseBackup.findUnique({ where: { id: fresh.id } });
      expect(stuckRow?.status).toBe('failed');
      expect(freshRow?.status).toBe('in_progress');
    });

    it('deletes failed backups older than failedBackupRetentionDays (file-first)', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'failed-cleanup' });
      const server = await localhostServer(env.id, 'failed-cleanup-host');
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'failed-cleanup-db', serverId: server.id });
      const DAY = 24 * 60 * 60 * 1000;
      // Default failedBackupRetentionDays = 3.
      const oldFailed = await seedBackup({ databaseId: db.id, createdAt: new Date(Date.now() - 10 * DAY), status: 'failed', makeFile: true });
      const recentFailed = await seedBackup({ databaseId: db.id, createdAt: new Date(Date.now() - 1 * DAY), status: 'failed', makeFile: true });

      const deleted = await cleanupFailedBackups();
      expect(deleted).toBeGreaterThanOrEqual(1);

      const remaining = new Set(await remainingIds(db.id));
      expect(remaining.has(oldFailed.id)).toBe(false);
      expect(remaining.has(recentFailed.id)).toBe(true);
      expect(existsSync(oldFailed.storagePath)).toBe(false);
    });
  });

  // ==========================================================================
  // §14 — Confirmation gate (route).
  // ==========================================================================
  describe('PUT /api/databases/:id/backup-policy confirmation gate', () => {
    async function seedManyPrunable(databaseId: string, n: number) {
      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      for (let i = 0; i < n; i++) {
        await seedBackup({ databaseId, createdAt: new Date(now - i * DAY), makeFile: true });
      }
    }

    it('returns 409 confirmationRequired with a preview and saves NOTHING when the prune count exceeds the threshold', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'confirm-gate' });
      const server = await localhostServer(env.id, 'confirm-gate-host');
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'confirm-gate-db', serverId: server.id });
      // 10 daily scheduled backups. Threshold default = 5.
      await seedManyPrunable(db.id, 10);

      // Aggressive policy: keepLast=1, everything else 0, minFloor=1 → prunes 9 (> 5).
      const res = await app.inject({
        method: 'PUT',
        url: `/api/databases/${db.id}/backup-policy`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { preset: 'custom', keepLast: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1 },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json() as { confirmationRequired: boolean; preview: { keep: unknown[]; prune: unknown[]; bytesFreed: number } };
      expect(body.confirmationRequired).toBe(true);
      expect(body.preview.prune.length).toBe(9);
      expect(body.preview.keep.length).toBe(1);

      // Nothing persisted, nothing deleted.
      expect(await app.prisma.backupRetentionPolicy.findUnique({ where: { databaseId: db.id } })).toBeNull();
      expect(await app.prisma.databaseBackup.count({ where: { databaseId: db.id } })).toBe(10);
    });

    it('saves the override and runs rotation when confirm:true is supplied', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'confirm-yes' });
      const server = await localhostServer(env.id, 'confirm-yes-host');
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'confirm-yes-db', serverId: server.id });
      await seedManyPrunable(db.id, 10);

      const res = await app.inject({
        method: 'PUT',
        url: `/api/databases/${db.id}/backup-policy`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { preset: 'custom', keepLast: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1, confirm: true },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { override: { keepLast: number }; rotation: { prune: string[] } };
      expect(body.override.keepLast).toBe(1);
      expect(body.rotation.prune.length).toBe(9);

      // Override persisted; only 1 backup remains.
      expect(await app.prisma.backupRetentionPolicy.findUnique({ where: { databaseId: db.id } })).not.toBeNull();
      expect(await app.prisma.databaseBackup.count({ where: { databaseId: db.id } })).toBe(1);
    });

    it('saves without confirmation when the prune count is within the threshold', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'confirm-under' });
      const server = await localhostServer(env.id, 'confirm-under-host');
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'confirm-under-db', serverId: server.id });
      // 3 backups, keepLast=1 → prune 2 (<= 5), no confirm needed.
      await seedManyPrunable(db.id, 3);

      const res = await app.inject({
        method: 'PUT',
        url: `/api/databases/${db.id}/backup-policy`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { preset: 'custom', keepLast: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1 },
      });

      expect(res.statusCode).toBe(200);
      expect(await app.prisma.databaseBackup.count({ where: { databaseId: db.id } })).toBe(1);
    });
  });

  // ==========================================================================
  // §14 — RBAC.
  // ==========================================================================
  describe('RBAC', () => {
    let envId: string;
    let dbId: string;
    let backupId: string;

    beforeAll(async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'rbac-env' });
      envId = env.id;
      const server = await localhostServer(envId, 'rbac-host');
      const db = await createTestDatabase(app.prisma, { environmentId: envId, name: 'rbac-db', serverId: server.id });
      dbId = db.id;
      const b = await seedBackup({ databaseId: dbId, createdAt: new Date(), makeFile: true });
      backupId = b.id;
    });

    it('viewer can GET the effective policy', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/databases/${dbId}/backup-policy`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('effective');
      expect(res.json()).toHaveProperty('source');
    });

    it('unauthenticated GET is rejected (401)', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/databases/${dbId}/backup-policy` });
      expect(res.statusCode).toBe(401);
    });

    // Preview is a read-only dry-run, so per the §10 / §11.1 / §14 spec a viewer
    // CAN call it. Even though it's a POST (which the global enforceRoleForMethod
    // hook normally rejects for viewers), `POST /api/databases/:id/backup-policy/preview`
    // is allowlisted in VIEWER_ALLOWED_MUTATIONS precisely because it mutates
    // nothing. So a viewer gets 200 with a valid preview body.
    it('viewer can preview (read-only dry-run, §14)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/databases/${dbId}/backup-policy/preview`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { keep: unknown[]; prune: unknown[]; bytesFreed: number };
      expect(body).toHaveProperty('keep');
      expect(body).toHaveProperty('prune');
      expect(typeof body.bytesFreed).toBe('number');
    });

    it('operator can preview', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/databases/${dbId}/backup-policy/preview`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('keep');
      expect(res.json()).toHaveProperty('prune');
    });

    it('viewer is rejected on PUT policy (403)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/databases/${dbId}/backup-policy`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { preset: 'balanced', keepLast: 24, daily: 7, weekly: 4, monthly: 6, yearly: 0, minFloor: 2 },
      });
      expect(res.statusCode).toBe(403);
    });

    it('viewer is rejected on DELETE policy, rotate and pin (403)', async () => {
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/databases/${dbId}/backup-policy`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(del.statusCode).toBe(403);

      const rotate = await app.inject({
        method: 'POST',
        url: `/api/databases/${dbId}/rotate`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(rotate.statusCode).toBe(403);

      const pin = await app.inject({
        method: 'PUT',
        url: `/api/databases/${dbId}/backups/${backupId}/pin`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { pinned: true },
      });
      expect(pin.statusCode).toBe(403);
    });

    it('unauthenticated pin is rejected (401)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/databases/${dbId}/backups/${backupId}/pin`,
        payload: { pinned: true },
      });
      expect(res.statusCode).toBe(401);
    });

    it('pin returns 404 when the backup does not belong to the database', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/databases/${dbId}/backups/does-not-exist/pin`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { pinned: true },
      });
      expect(res.statusCode).toBe(404);
    });

    it('operator can set the per-DB policy and pin/unpin a backup via PUT', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/databases/${dbId}/backup-policy`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { preset: 'balanced', keepLast: 24, daily: 7, weekly: 4, monthly: 6, yearly: 0, minFloor: 2 },
      });
      expect(put.statusCode).toBe(200);

      // Pin (pinned: true).
      const pin = await app.inject({
        method: 'PUT',
        url: `/api/databases/${dbId}/backups/${backupId}/pin`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { pinned: true },
      });
      expect(pin.statusCode).toBe(200);
      expect(pin.json().backup.isPinned).toBe(true);

      // Unpin (pinned: false) — same endpoint, idempotent.
      const unpin = await app.inject({
        method: 'PUT',
        url: `/api/databases/${dbId}/backups/${backupId}/pin`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { pinned: false },
      });
      expect(unpin.statusCode).toBe(200);
      expect(unpin.json().backup.isPinned).toBe(false);
    });

    it('only admin can change the global default via PUT /api/settings/system', async () => {
      const asOperator = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { backupRetentionDaily: 10 },
      });
      expect(asOperator.statusCode).toBe(403);

      const asViewer = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { backupRetentionDaily: 10 },
      });
      expect(asViewer.statusCode).toBe(403);

      const asAdmin = await app.inject({
        method: 'PUT',
        url: '/api/settings/system',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { backupRetentionDaily: 9 },
      });
      expect(asAdmin.statusCode).toBe(200);
      expect(asAdmin.json().settings.backupRetentionDaily).toBe(9);

      // Reset to default so we don't perturb other suites sharing the singleton.
      await updateSystemSettings({ backupRetentionDaily: 7 });
    });
  });
});
