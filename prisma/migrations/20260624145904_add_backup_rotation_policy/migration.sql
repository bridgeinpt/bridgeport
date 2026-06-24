-- CreateTable
CREATE TABLE "BackupRetentionPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "databaseId" TEXT NOT NULL,
    "autoApplied" BOOLEAN NOT NULL DEFAULT false,
    "inheritGlobal" BOOLEAN NOT NULL DEFAULT false,
    "preset" TEXT NOT NULL DEFAULT 'balanced',
    "keepLast" INTEGER NOT NULL DEFAULT 24,
    "daily" INTEGER NOT NULL DEFAULT 7,
    "weekly" INTEGER NOT NULL DEFAULT 4,
    "monthly" INTEGER NOT NULL DEFAULT 6,
    "yearly" INTEGER NOT NULL DEFAULT 0,
    "minFloor" INTEGER NOT NULL DEFAULT 2,
    "maxTotalBytes" BIGINT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BackupRetentionPolicy_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DatabaseBackup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "storageType" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "duration" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "pinnedById" TEXT,
    "pinnedAt" DATETIME,
    "lastRotationError" TEXT,
    "databaseId" TEXT NOT NULL,
    "triggeredById" TEXT,
    CONSTRAINT "DatabaseBackup_pinnedById_fkey" FOREIGN KEY ("pinnedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DatabaseBackup_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DatabaseBackup_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DatabaseBackup" ("completedAt", "createdAt", "databaseId", "duration", "error", "filename", "id", "progress", "size", "status", "storagePath", "storageType", "triggeredById", "type") SELECT "completedAt", "createdAt", "databaseId", "duration", "error", "filename", "id", "progress", "size", "status", "storagePath", "storageType", "triggeredById", "type" FROM "DatabaseBackup";
DROP TABLE "DatabaseBackup";
ALTER TABLE "new_DatabaseBackup" RENAME TO "DatabaseBackup";
CREATE INDEX "DatabaseBackup_databaseId_createdAt_idx" ON "DatabaseBackup"("databaseId", "createdAt" DESC);
CREATE INDEX "DatabaseBackup_databaseId_status_idx" ON "DatabaseBackup"("databaseId", "status");
CREATE INDEX "DatabaseBackup_databaseId_isPinned_idx" ON "DatabaseBackup"("databaseId", "isPinned");
CREATE TABLE "new_SystemSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "sshCommandTimeoutMs" INTEGER NOT NULL DEFAULT 60000,
    "sshReadyTimeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "webhookMaxRetries" INTEGER NOT NULL DEFAULT 3,
    "webhookTimeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "webhookRetryDelaysMs" TEXT NOT NULL DEFAULT '[1000,5000,15000]',
    "pgDumpTimeoutMs" INTEGER NOT NULL DEFAULT 300000,
    "maxUploadSizeMb" INTEGER NOT NULL DEFAULT 50,
    "activeUserWindowMin" INTEGER NOT NULL DEFAULT 15,
    "registryMaxTags" INTEGER NOT NULL DEFAULT 50,
    "defaultLogLines" INTEGER NOT NULL DEFAULT 50,
    "publicUrl" TEXT,
    "agentCallbackUrl" TEXT,
    "agentStaleThresholdMs" INTEGER NOT NULL DEFAULT 180000,
    "agentOfflineThresholdMs" INTEGER NOT NULL DEFAULT 300000,
    "auditLogRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "databaseMetricsRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "notificationRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "healthLogRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "webhookDeliveryRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "imageDigestRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "backupRetentionPreset" TEXT NOT NULL DEFAULT 'balanced',
    "backupRetentionKeepLast" INTEGER NOT NULL DEFAULT 24,
    "backupRetentionDaily" INTEGER NOT NULL DEFAULT 7,
    "backupRetentionWeekly" INTEGER NOT NULL DEFAULT 4,
    "backupRetentionMonthly" INTEGER NOT NULL DEFAULT 6,
    "backupRetentionYearly" INTEGER NOT NULL DEFAULT 0,
    "backupRetentionMinFloor" INTEGER NOT NULL DEFAULT 2,
    "backupRetentionMaxTotalBytes" BIGINT,
    "failedBackupRetentionDays" INTEGER NOT NULL DEFAULT 3,
    "backupRotationConfirmThreshold" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SystemSettings" ("activeUserWindowMin", "agentCallbackUrl", "agentOfflineThresholdMs", "agentStaleThresholdMs", "auditLogRetentionDays", "databaseMetricsRetentionDays", "defaultLogLines", "healthLogRetentionDays", "id", "imageDigestRetentionDays", "maxUploadSizeMb", "notificationRetentionDays", "pgDumpTimeoutMs", "publicUrl", "registryMaxTags", "sshCommandTimeoutMs", "sshReadyTimeoutMs", "updatedAt", "webhookDeliveryRetentionDays", "webhookMaxRetries", "webhookRetryDelaysMs", "webhookTimeoutMs") SELECT "activeUserWindowMin", "agentCallbackUrl", "agentOfflineThresholdMs", "agentStaleThresholdMs", "auditLogRetentionDays", "databaseMetricsRetentionDays", "defaultLogLines", "healthLogRetentionDays", "id", "imageDigestRetentionDays", "maxUploadSizeMb", "notificationRetentionDays", "pgDumpTimeoutMs", "publicUrl", "registryMaxTags", "sshCommandTimeoutMs", "sshReadyTimeoutMs", "updatedAt", "webhookDeliveryRetentionDays", "webhookMaxRetries", "webhookRetryDelaysMs", "webhookTimeoutMs" FROM "SystemSettings";
DROP TABLE "SystemSettings";
ALTER TABLE "new_SystemSettings" RENAME TO "SystemSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "BackupRetentionPolicy_databaseId_key" ON "BackupRetentionPolicy"("databaseId");

-- DataBackfill: snapshot legacy flat retention into a per-DB GFS override that is
-- INERT until an operator opts in. autoApplied=1 marks the row as auto-created by
-- this upgrade; automatic rotation (sweep / post-backup) SKIPS such rows, so the
-- first post-upgrade sweep deletes NOTHING. GFS only starts thinning once an
-- operator reviews & saves the policy (the PUT route sets autoApplied=0). This
-- honors spec decision #12 (new tiers take effect only on an explicit save) and
-- the GOLDEN RULE (container upgrades must be automatic AND safe — no surprise
-- deletes). A flat "keep last N days" policy and GFS daily=N diverge for sub-daily
-- schedules (GFS keeps only newest-per-day), which is exactly why these rows must
-- not auto-apply. See rotateDatabase.
-- BackupSchedule.databaseId is UNIQUE (1:1 with Database), so GROUP BY yields one row per database.
-- "keep last N days" => N daily slots (capped at 366); weekly/monthly/yearly start at 0.
-- inheritGlobal is the boolean false, stored as 0 in SQLite.
INSERT INTO "BackupRetentionPolicy" ("id","databaseId","autoApplied","inheritGlobal","preset","keepLast","daily","weekly","monthly","yearly","minFloor","createdAt","updatedAt")
SELECT lower(hex(randomblob(16))), "databaseId", 1, 0, 'custom', 12, MIN("retentionDays",366), 0, 0, 0, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "BackupSchedule"
GROUP BY "databaseId";

-- Every existing DB with backups but no schedule-derived policy: inert balanced snapshot
-- so the first automatic sweep prunes nothing (covers disabled/deleted-schedule & manual-only DBs).
INSERT INTO "BackupRetentionPolicy" ("id","databaseId","autoApplied","inheritGlobal","preset","keepLast","daily","weekly","monthly","yearly","minFloor","createdAt","updatedAt")
SELECT lower(hex(randomblob(16))), d."id", 1, 0, 'custom', 24, 7, 4, 6, 0, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Database" d
WHERE EXISTS (SELECT 1 FROM "DatabaseBackup" b WHERE b."databaseId" = d."id")
  AND NOT EXISTS (SELECT 1 FROM "BackupRetentionPolicy" p WHERE p."databaseId" = d."id");
