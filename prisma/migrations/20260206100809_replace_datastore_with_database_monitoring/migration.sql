/*
  Warnings:

  - You are about to drop the `DataStore` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DataStoreMetrics` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropIndex
DROP INDEX "DataStore_environmentId_name_key";

-- DropIndex
DROP INDEX "DataStore_environmentId_idx";

-- DropIndex
DROP INDEX "DataStore_databaseId_key";

-- DropIndex
DROP INDEX "DataStoreMetrics_dataStoreId_collectedAt_idx";

-- AlterTable
ALTER TABLE "DatabaseType" ADD COLUMN "monitoringConfig" TEXT;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "DataStore";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "DataStoreMetrics";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "DatabaseMetrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "databaseId" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DatabaseMetrics_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Database" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "databaseName" TEXT,
    "encryptedCredentials" TEXT,
    "credentialsNonce" TEXT,
    "filePath" TEXT,
    "backupStorageType" TEXT NOT NULL DEFAULT 'local',
    "backupLocalPath" TEXT,
    "backupSpacesBucket" TEXT,
    "backupSpacesPrefix" TEXT,
    "backupFormat" TEXT NOT NULL DEFAULT 'plain',
    "backupCompression" TEXT NOT NULL DEFAULT 'none',
    "backupCompressionLevel" INTEGER NOT NULL DEFAULT 6,
    "pgDumpOptions" TEXT,
    "pgDumpTimeoutMs" INTEGER NOT NULL DEFAULT 300000,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    "serverId" TEXT,
    "databaseTypeId" TEXT,
    "monitoringEnabled" BOOLEAN NOT NULL DEFAULT true,
    "collectionIntervalSec" INTEGER NOT NULL DEFAULT 300,
    "monitoringStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastCollectedAt" DATETIME,
    "lastMonitoringError" TEXT,
    CONSTRAINT "Database_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Database_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Database_databaseTypeId_fkey" FOREIGN KEY ("databaseTypeId") REFERENCES "DatabaseType" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Database" ("backupCompression", "backupCompressionLevel", "backupFormat", "backupLocalPath", "backupSpacesBucket", "backupSpacesPrefix", "backupStorageType", "createdAt", "credentialsNonce", "databaseName", "databaseTypeId", "encryptedCredentials", "environmentId", "filePath", "host", "id", "name", "pgDumpOptions", "pgDumpTimeoutMs", "port", "serverId", "type", "updatedAt") SELECT "backupCompression", "backupCompressionLevel", "backupFormat", "backupLocalPath", "backupSpacesBucket", "backupSpacesPrefix", "backupStorageType", "createdAt", "credentialsNonce", "databaseName", "databaseTypeId", "encryptedCredentials", "environmentId", "filePath", "host", "id", "name", "pgDumpOptions", "pgDumpTimeoutMs", "port", "serverId", "type", "updatedAt" FROM "Database";
DROP TABLE "Database";
ALTER TABLE "new_Database" RENAME TO "Database";
CREATE UNIQUE INDEX "Database_environmentId_name_key" ON "Database"("environmentId", "name");
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
    "doRegistryToken" TEXT,
    "auditLogRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "databaseMetricsRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SystemSettings" ("activeUserWindowMin", "agentCallbackUrl", "agentOfflineThresholdMs", "agentStaleThresholdMs", "auditLogRetentionDays", "defaultLogLines", "doRegistryToken", "id", "maxUploadSizeMb", "pgDumpTimeoutMs", "publicUrl", "registryMaxTags", "sshCommandTimeoutMs", "sshReadyTimeoutMs", "updatedAt", "webhookMaxRetries", "webhookRetryDelaysMs", "webhookTimeoutMs") SELECT "activeUserWindowMin", "agentCallbackUrl", "agentOfflineThresholdMs", "agentStaleThresholdMs", "auditLogRetentionDays", "defaultLogLines", "doRegistryToken", "id", "maxUploadSizeMb", "pgDumpTimeoutMs", "publicUrl", "registryMaxTags", "sshCommandTimeoutMs", "sshReadyTimeoutMs", "updatedAt", "webhookMaxRetries", "webhookRetryDelaysMs", "webhookTimeoutMs" FROM "SystemSettings";
DROP TABLE "SystemSettings";
ALTER TABLE "new_SystemSettings" RENAME TO "SystemSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DatabaseMetrics_databaseId_collectedAt_idx" ON "DatabaseMetrics"("databaseId", "collectedAt" DESC);
