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
  deleteBackup,
  markStuckBackupsFailed,
  cleanupFailedBackups,
} from '../services/database-backup.js';
import * as environmentsModule from './environments.js';
import { S3Client } from '@aws-sdk/client-s3';
import { updateSystemSettings } from '../services/system-settings.js';
// The SAME PrismaClient instance the services use (src/lib/db.ts). app.prisma
// is a *separate* client pointed at the same file, so to intercept a service's
// own Prisma call we must spy on this singleton, not app.prisma.
import { prisma as dbPrisma } from '../lib/db.js';

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
    // Kept byte-for-byte in sync with the migration's first INSERT…SELECT.
    // autoApplied=1 (inert): the first post-upgrade sweep must prune nothing
    // until an operator saves the policy.
    const BACKFILL_SQL = `
INSERT INTO "BackupRetentionPolicy" ("id","databaseId","autoApplied","inheritGlobal","preset","keepLast","daily","weekly","monthly","yearly","minFloor","createdAt","updatedAt")
SELECT lower(hex(randomblob(16))), "databaseId", 1, 0, 'custom', 12, MIN("retentionDays",366), 0, 0, 0, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "BackupSchedule"
GROUP BY "databaseId"`;

    // The migration's SECOND INSERT — kept byte-for-byte in sync. Gives every
    // existing DB that has ≥1 backup but no schedule-derived policy an inert
    // balanced snapshot (covers disabled/deleted-schedule & manual-only DBs).
    const BACKFILL_SQL_SCHEDULELESS = `
INSERT INTO "BackupRetentionPolicy" ("id","databaseId","autoApplied","inheritGlobal","preset","keepLast","daily","weekly","monthly","yearly","minFloor","createdAt","updatedAt")
SELECT lower(hex(randomblob(16))), d."id", 1, 0, 'custom', 24, 7, 4, 6, 0, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Database" d
WHERE EXISTS (SELECT 1 FROM "DatabaseBackup" b WHERE b."databaseId" = d."id")
  AND NOT EXISTS (SELECT 1 FROM "BackupRetentionPolicy" p WHERE p."databaseId" = d."id")`;

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
        // Inert: the migration must NOT auto-apply GFS on upgrade.
        autoApplied: true,
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
      expect(policy?.autoApplied).toBe(true);
    });

    it('a schedule-less DB that has backups gets an inert balanced snapshot too', async () => {
      // Covers disabled/deleted-schedule & manual-only DBs: no BackupSchedule
      // row, but the DB has ≥1 backup, so the SECOND backfill INSERT must give
      // it an inert balanced policy so the first sweep prunes nothing here either.
      const env = await createTestEnvironment(app.prisma, { name: 'mig-noched' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'mig-db-noched' });
      // A DB with NO backups must NOT get a policy (nothing at risk).
      const emptyDb = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'mig-db-empty' });
      await seedBackup({ databaseId: db.id, createdAt: new Date() });

      // Run BOTH backfill INSERTs, in migration order.
      await app.prisma.$executeRawUnsafe(BACKFILL_SQL);
      await app.prisma.$executeRawUnsafe(BACKFILL_SQL_SCHEDULELESS);

      const policy = await app.prisma.backupRetentionPolicy.findUnique({ where: { databaseId: db.id } });
      expect(policy).not.toBeNull();
      expect(policy).toMatchObject({
        keepLast: 24,
        daily: 7,
        weekly: 4,
        monthly: 6,
        yearly: 0,
        minFloor: 2,
        preset: 'custom',
        inheritGlobal: false,
        autoApplied: true,
      });

      // The backup-less DB gets no policy row.
      const none = await app.prisma.backupRetentionPolicy.findUnique({ where: { databaseId: emptyDb.id } });
      expect(none).toBeNull();
    });

    it('first sweep after backfill prunes NOTHING even when GFS would thin (inert policy)', async () => {
      // Sub-daily (hourly) schedule: the old flat "keep N days" kept ALL backups
      // younger than N days, but GFS daily=N keeps only the newest-per-day. The
      // migrated policy is autoApplied (inert), so the first automatic sweep must
      // leave the whole set untouched — proving we don't silently thin on upgrade.
      const env = await createTestEnvironment(app.prisma, { name: 'mig-rotate' });
      const server = await localhostServer(env.id, 'mig-rotate-host');
      const db = await createTestDatabase(app.prisma, {
        environmentId: env.id,
        name: 'mig-db-rotate',
        serverId: server.id,
      });
      await app.prisma.backupSchedule.create({
        data: { databaseId: db.id, cronExpression: '0 * * * *', enabled: true, retentionDays: 7 },
      });
      await app.prisma.$executeRawUnsafe(BACKFILL_SQL);

      // 6 scheduled backups within the SAME day (hourly). GFS daily=7 would keep
      // only the newest-per-day = 1, pruning the other 5. Inert must keep all 6.
      const base = Date.parse('2026-03-10T18:00:00Z');
      const HOUR = 60 * 60 * 1000;
      const seeded: string[] = [];
      for (let h = 0; h < 6; h++) {
        const b = await seedBackup({
          databaseId: db.id,
          createdAt: new Date(base - h * HOUR),
          makeFile: true,
        });
        seeded.push(b.id);
      }

      const result = await rotateDatabase(db.id, { trigger: 'sweep' });
      expect(result.prune).toEqual([]);
      expect(result.bytesFreed).toBe(0n);
      // keep returns all candidate ids; nothing deleted on disk or in the DB.
      expect(new Set(result.keep)).toEqual(new Set(seeded));
      expect((await remainingIds(db.id)).sort()).toEqual(seeded.sort());

      // Sanity: post-backup (the other automatic trigger) is also inert.
      const result2 = await rotateDatabase(db.id, { trigger: 'post-backup' });
      expect(result2.prune).toEqual([]);
      expect((await remainingIds(db.id)).length).toBe(6);
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

    it('an autoApplied override is INERT for an automatic sweep, then prunes once cleared', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'rotate-inert' });
      const server = await localhostServer(env.id, 'rotate-inert-host');
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'rotate-inert-db', serverId: server.id });

      // An aggressive policy GFS WOULD thin to 1 (keepLast=1, all tiers 0), but
      // flagged autoApplied → an automatic sweep must touch nothing.
      await app.prisma.backupRetentionPolicy.create({
        data: { databaseId: db.id, autoApplied: true, inheritGlobal: false, preset: 'custom', keepLast: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1 },
      });

      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const b0 = await seedBackup({ databaseId: db.id, createdAt: new Date(now), size: 5n, makeFile: true });
      const b1 = await seedBackup({ databaseId: db.id, createdAt: new Date(now - 1 * DAY), size: 5n, makeFile: true });
      const b2 = await seedBackup({ databaseId: db.id, createdAt: new Date(now - 2 * DAY), size: 5n, makeFile: true });
      const all = [b0.id, b1.id, b2.id];

      // Automatic sweep: completely untouched.
      const sweep = await rotateDatabase(db.id, { trigger: 'sweep' });
      expect(sweep.prune).toEqual([]);
      expect(sweep.bytesFreed).toBe(0n);
      expect(new Set(sweep.keep)).toEqual(new Set(all));
      expect((await remainingIds(db.id)).sort()).toEqual([...all].sort());
      expect(existsSync(b2.storagePath)).toBe(true);

      // An explicit opts.policy (preview / confirm gate) IGNORES autoApplied even
      // while the stored policy is inert — the dry-run previews the real outcome.
      const preview = await rotateDatabase(db.id, {
        dryRun: true,
        policy: { keepLast: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1, maxTotalBytes: null, preset: 'custom', source: 'override', autoApplied: false },
      });
      expect(new Set(preview.prune)).toEqual(new Set([b1.id, b2.id]));
      // Still nothing actually deleted by a dry-run.
      expect((await remainingIds(db.id)).length).toBe(3);

      // Operator clears the flag (mirrors what the PUT route does) → GFS activates.
      await app.prisma.backupRetentionPolicy.update({ where: { databaseId: db.id }, data: { autoApplied: false } });
      const after = await rotateDatabase(db.id, { trigger: 'sweep' });
      expect(new Set(after.prune)).toEqual(new Set([b1.id, b2.id]));
      expect(after.keep).toEqual([b0.id]);
      expect((await remainingIds(db.id))).toEqual([b0.id]);
      expect(existsSync(b1.storagePath)).toBe(false);
      expect(existsSync(b2.storagePath)).toBe(false);
    });

    it('explicit (non-automatic) triggers ignore autoApplied and rotate normally', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'rotate-inert-manual' });
      const server = await localhostServer(env.id, 'rotate-inert-manual-host');
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'rotate-inert-manual-db', serverId: server.id });
      await app.prisma.backupRetentionPolicy.create({
        data: { databaseId: db.id, autoApplied: true, inheritGlobal: false, preset: 'custom', keepLast: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1 },
      });
      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const keep = await seedBackup({ databaseId: db.id, createdAt: new Date(now), size: 5n, makeFile: true });
      const prune = await seedBackup({ databaseId: db.id, createdAt: new Date(now - DAY), size: 5n, makeFile: true });

      // trigger: 'manual' is explicit — autoApplied must NOT pause it.
      const result = await rotateDatabase(db.id, { trigger: 'manual' });
      expect(result.prune).toEqual([prune.id]);
      expect(result.keep).toEqual([keep.id]);
      expect((await remainingIds(db.id))).toEqual([keep.id]);
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
  // lastRotationError is cleared on a KEEP pass and on pin (Fix E). The schema
  // documents it as "cleared on success", but nothing cleared it before, so a
  // recovered-but-kept backup showed a stale error forever.
  // ==========================================================================
  describe('lastRotationError clearing', () => {
    it('clears lastRotationError on backups a real rotation KEEPS', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'clear-keep' });
      const server = await localhostServer(env.id, 'clear-keep-host');
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'clear-keep-db', serverId: server.id });
      // keepLast=2, all tiers 0 → newest 2 kept, oldest pruned.
      await app.prisma.backupRetentionPolicy.create({
        data: { databaseId: db.id, inheritGlobal: false, preset: 'custom', keepLast: 2, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1 },
      });
      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const newest = await seedBackup({ databaseId: db.id, createdAt: new Date(now), makeFile: true });
      const second = await seedBackup({ databaseId: db.id, createdAt: new Date(now - DAY), makeFile: true });
      const oldest = await seedBackup({ databaseId: db.id, createdAt: new Date(now - 2 * DAY), makeFile: true });
      // Both kept rows carry a stale error from a prior failed prune attempt.
      await app.prisma.databaseBackup.updateMany({
        where: { id: { in: [newest.id, second.id] } },
        data: { lastRotationError: 'previous orphan: connection reset' },
      });

      const result = await rotateDatabase(db.id, { trigger: 'manual' });
      expect(new Set(result.keep)).toEqual(new Set([newest.id, second.id]));
      expect(result.prune).toEqual([oldest.id]);

      // The kept rows had their stale error cleared.
      const newestRow = await app.prisma.databaseBackup.findUnique({ where: { id: newest.id } });
      const secondRow = await app.prisma.databaseBackup.findUnique({ where: { id: second.id } });
      expect(newestRow?.lastRotationError).toBeNull();
      expect(secondRow?.lastRotationError).toBeNull();
    });

    it('does NOT clear lastRotationError on a dry-run keep (no write)', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'clear-dry' });
      const server = await localhostServer(env.id, 'clear-dry-host');
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'clear-dry-db', serverId: server.id });
      await app.prisma.backupRetentionPolicy.create({
        data: { databaseId: db.id, inheritGlobal: false, preset: 'custom', keepLast: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1 },
      });
      const kept = await seedBackup({ databaseId: db.id, createdAt: new Date(), makeFile: true });
      await app.prisma.databaseBackup.update({ where: { id: kept.id }, data: { lastRotationError: 'stale' } });

      await rotateDatabase(db.id, { dryRun: true });

      const row = await app.prisma.databaseBackup.findUnique({ where: { id: kept.id } });
      expect(row?.lastRotationError).toBe('stale'); // unchanged by a preview
    });

    it('clears lastRotationError when a backup is pinned via PUT .../pin', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'clear-pin' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'clear-pin-db' });
      const backup = await seedBackup({ databaseId: db.id, createdAt: new Date() });
      await app.prisma.databaseBackup.update({ where: { id: backup.id }, data: { lastRotationError: 'orphan: boom' } });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/databases/${db.id}/backups/${backup.id}/pin`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { pinned: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().backup.isPinned).toBe(true);

      const row = await app.prisma.databaseBackup.findUnique({ where: { id: backup.id } });
      expect(row?.lastRotationError).toBeNull();
    });
  });

  // ==========================================================================
  // deleteBackup (user-initiated) — must ALWAYS remove the row, even when the
  // artifact delete fails (host down / missing key / Spaces removed), so an
  // explicit delete is never stranded. Contrast with pruneBackup (above), which
  // keeps the row and retries. (Code-review Fix A.)
  // ==========================================================================
  describe('deleteBackup (user-initiated) row always removed', () => {
    it('deletes the DB row even when the artifact delete fails, and logs a warning', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'delete-orphan' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'delete-orphan-db' });
      const backup = await seedBackup({
        databaseId: db.id,
        createdAt: new Date(),
        storageType: 'spaces',
        storagePath: 'prefix/backup.sql',
      });
      await app.prisma.database.update({ where: { id: db.id }, data: { backupSpacesBucket: 'my-bucket' } });

      // Spaces config resolves, but the S3 delete throws a NON-404 error → the
      // artifact delete genuinely fails (the case that used to throw/500).
      vi.spyOn(environmentsModule, 'getEnvironmentSpacesConfig').mockResolvedValue({
        endpoint: 'nyc3.example.com', region: 'nyc3', accessKey: 'ak', secretKey: 'sk',
      } as never);
      vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
        Object.assign(new Error('connection reset'), { name: 'NetworkingError' }) as never
      );
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Must NOT throw — and the row must be gone afterwards.
      await expect(deleteBackup(backup.id)).resolves.toBeUndefined();
      expect(await app.prisma.databaseBackup.findUnique({ where: { id: backup.id } })).toBeNull();
      // Orphan surfaced (non-silent).
      expect(warnSpy).toHaveBeenCalled();
    });

    it('DELETE /api/backups/:id returns 200 (not 500) when the artifact delete fails', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'delete-route-orphan' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'delete-route-orphan-db' });
      const backup = await seedBackup({
        databaseId: db.id,
        createdAt: new Date(),
        storageType: 'spaces',
        storagePath: 'prefix/route.sql',
      });
      await app.prisma.database.update({ where: { id: db.id }, data: { backupSpacesBucket: 'my-bucket' } });

      vi.spyOn(environmentsModule, 'getEnvironmentSpacesConfig').mockResolvedValue({
        endpoint: 'nyc3.example.com', region: 'nyc3', accessKey: 'ak', secretKey: 'sk',
      } as never);
      vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
        Object.assign(new Error('boom'), { name: 'NetworkingError' }) as never
      );
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/backups/${backup.id}`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      expect(await app.prisma.databaseBackup.findUnique({ where: { id: backup.id } })).toBeNull();
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

    it('never flips a stuck-old backup that already completed (status guard, Fix D)', async () => {
      // A stuck-OLD createdAt but status=completed must be left untouched — the
      // updateMany is guarded on status='in_progress', so a backup that finished
      // is never flapped back to failed.
      const env = await createTestEnvironment(app.prisma, { name: 'stuck-completed' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'stuck-completed-db' });
      const done = await seedBackup({
        databaseId: db.id,
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
        status: 'completed',
      });

      await markStuckBackupsFailed();

      const row = await app.prisma.databaseBackup.findUnique({ where: { id: done.id } });
      expect(row?.status).toBe('completed');
    });

    it('does NOT count a row that completed concurrently (updateMany count=0, Fix D)', async () => {
      // Models the race: the row is in_progress when read, but executeBackup
      // completes it before the conditional updateMany lands. updateMany then
      // matches nothing (count=0), so it must NOT be counted as marked.
      const env = await createTestEnvironment(app.prisma, { name: 'stuck-race' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'stuck-race-db' });
      const stuck = await seedBackup({
        databaseId: db.id,
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
        status: 'in_progress',
      });

      // Force the guarded updateMany to report 0 rows affected (the concurrent
      // completion won the race), without actually changing the row. Spy on the
      // singleton the service uses (dbPrisma), not app.prisma.
      const updateManySpy = vi
        .spyOn(dbPrisma.databaseBackup, 'updateMany')
        .mockResolvedValue({ count: 0 } as never);

      const marked = await markStuckBackupsFailed();
      // The guarded WHERE was issued for our stuck row…
      expect(
        updateManySpy.mock.calls.some(
          ([arg]) =>
            (arg as { where?: { id?: string; status?: string } })?.where?.id === stuck.id &&
            (arg as { where?: { id?: string; status?: string } })?.where?.status === 'in_progress'
        )
      ).toBe(true);
      // …but count=0 means it is NOT counted as marked. (Other stuck rows left
      // by earlier tests also report count=0 under this mock, so assert 0.)
      expect(marked).toBe(0);
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
  // §14 — Inert migrated policy (autoApplied) via the routes.
  // ==========================================================================
  describe('autoApplied (inert migrated policy) over the API', () => {
    it('GET backup-policy exposes autoApplied on the override so the UI can show pruning is paused', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'auto-get' });
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'auto-get-db' });
      await app.prisma.backupRetentionPolicy.create({
        data: { databaseId: db.id, autoApplied: true, inheritGlobal: false, preset: 'custom', keepLast: 12, daily: 7, weekly: 0, monthly: 0, yearly: 0, minFloor: 2 },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/databases/${db.id}/backup-policy`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { override: { autoApplied: boolean } | null; effective: { autoApplied: boolean } };
      expect(body.override?.autoApplied).toBe(true);
      // effective mirrors the override here (not inheriting), so it's inert too.
      expect(body.effective.autoApplied).toBe(true);
    });

    it('an operator PUT clears autoApplied (activates GFS) and prunes from then on', async () => {
      const env = await createTestEnvironment(app.prisma, { name: 'auto-put' });
      const server = await localhostServer(env.id, 'auto-put-host');
      const db = await createTestDatabase(app.prisma, { environmentId: env.id, name: 'auto-put-db', serverId: server.id });
      // Inert migrated policy in place.
      await app.prisma.backupRetentionPolicy.create({
        data: { databaseId: db.id, autoApplied: true, inheritGlobal: false, preset: 'custom', keepLast: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1 },
      });
      // 3 prunable scheduled backups (under the confirm threshold of 5 once keepLast=1 → prune 2).
      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const b0 = await seedBackup({ databaseId: db.id, createdAt: new Date(now), makeFile: true });
      await seedBackup({ databaseId: db.id, createdAt: new Date(now - DAY), makeFile: true });
      await seedBackup({ databaseId: db.id, createdAt: new Date(now - 2 * DAY), makeFile: true });

      // Operator saves the same tiers → autoApplied must flip to false and rotation runs.
      const res = await app.inject({
        method: 'PUT',
        url: `/api/databases/${db.id}/backup-policy`,
        headers: { authorization: `Bearer ${operatorToken}` },
        payload: { preset: 'custom', keepLast: 1, daily: 0, weekly: 0, monthly: 0, yearly: 0, minFloor: 1 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { override: { autoApplied: boolean }; rotation: { prune: string[] } };
      expect(body.override.autoApplied).toBe(false);
      expect(body.rotation.prune.length).toBe(2);

      const row = await app.prisma.backupRetentionPolicy.findUnique({ where: { databaseId: db.id } });
      expect(row?.autoApplied).toBe(false);
      expect((await remainingIds(db.id))).toEqual([b0.id]);
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
