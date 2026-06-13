/*
  Warnings:

  - You are about to drop the column `backupCheckIntervalMs` on the `MonitoringSettings` table. All the data in the column will be lost.
  - You are about to drop the column `bounceCooldownMs` on the `MonitoringSettings` table. All the data in the column will be lost.
  - You are about to drop the column `bounceThreshold` on the `MonitoringSettings` table. All the data in the column will be lost.
  - You are about to drop the column `discoveryIntervalMs` on the `MonitoringSettings` table. All the data in the column will be lost.
  - You are about to drop the column `enabled` on the `MonitoringSettings` table. All the data in the column will be lost.
  - You are about to drop the column `healthLogRetentionDays` on the `MonitoringSettings` table. All the data in the column will be lost.
  - You are about to drop the column `metricsIntervalMs` on the `MonitoringSettings` table. All the data in the column will be lost.
  - You are about to drop the column `metricsRetentionDays` on the `MonitoringSettings` table. All the data in the column will be lost.
  - You are about to drop the column `serverHealthIntervalMs` on the `MonitoringSettings` table. All the data in the column will be lost.
  - You are about to drop the column `serviceHealthIntervalMs` on the `MonitoringSettings` table. All the data in the column will be lost.
  - You are about to drop the column `updateCheckIntervalMs` on the `MonitoringSettings` table. All the data in the column will be lost.
  - You are about to drop the column `doRegistryToken` on the `SystemSettings` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MonitoringSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "collectCpu" BOOLEAN NOT NULL DEFAULT true,
    "collectMemory" BOOLEAN NOT NULL DEFAULT true,
    "collectSwap" BOOLEAN NOT NULL DEFAULT true,
    "collectDisk" BOOLEAN NOT NULL DEFAULT true,
    "collectLoad" BOOLEAN NOT NULL DEFAULT true,
    "collectFds" BOOLEAN NOT NULL DEFAULT true,
    "collectTcp" BOOLEAN NOT NULL DEFAULT true,
    "collectProcesses" BOOLEAN NOT NULL DEFAULT true,
    "collectTcpChecks" BOOLEAN NOT NULL DEFAULT true,
    "collectCertChecks" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "MonitoringSettings_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_MonitoringSettings" ("collectCertChecks", "collectCpu", "collectDisk", "collectFds", "collectLoad", "collectMemory", "collectProcesses", "collectSwap", "collectTcp", "collectTcpChecks", "environmentId", "id") SELECT "collectCertChecks", "collectCpu", "collectDisk", "collectFds", "collectLoad", "collectMemory", "collectProcesses", "collectSwap", "collectTcp", "collectTcpChecks", "environmentId", "id" FROM "MonitoringSettings";
DROP TABLE "MonitoringSettings";
ALTER TABLE "new_MonitoringSettings" RENAME TO "MonitoringSettings";
CREATE UNIQUE INDEX "MonitoringSettings_environmentId_key" ON "MonitoringSettings"("environmentId");
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
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SystemSettings" ("activeUserWindowMin", "agentCallbackUrl", "agentOfflineThresholdMs", "agentStaleThresholdMs", "auditLogRetentionDays", "databaseMetricsRetentionDays", "defaultLogLines", "id", "maxUploadSizeMb", "pgDumpTimeoutMs", "publicUrl", "registryMaxTags", "sshCommandTimeoutMs", "sshReadyTimeoutMs", "updatedAt", "webhookMaxRetries", "webhookRetryDelaysMs", "webhookTimeoutMs") SELECT "activeUserWindowMin", "agentCallbackUrl", "agentOfflineThresholdMs", "agentStaleThresholdMs", "auditLogRetentionDays", "databaseMetricsRetentionDays", "defaultLogLines", "id", "maxUploadSizeMb", "pgDumpTimeoutMs", "publicUrl", "registryMaxTags", "sshCommandTimeoutMs", "sshReadyTimeoutMs", "updatedAt", "webhookMaxRetries", "webhookRetryDelaysMs", "webhookTimeoutMs" FROM "SystemSettings";
DROP TABLE "SystemSettings";
ALTER TABLE "new_SystemSettings" RENAME TO "SystemSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
