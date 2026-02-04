-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "agentCallbackUrl" TEXT,
    "agentStaleThresholdMs" INTEGER NOT NULL DEFAULT 180000,
    "agentOfflineThresholdMs" INTEGER NOT NULL DEFAULT 300000,
    "doRegistryToken" TEXT,
    "auditLogRetentionDays" INTEGER NOT NULL DEFAULT 90,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SystemSettings" ("activeUserWindowMin", "agentCallbackUrl", "agentOfflineThresholdMs", "agentStaleThresholdMs", "defaultLogLines", "doRegistryToken", "id", "maxUploadSizeMb", "pgDumpTimeoutMs", "registryMaxTags", "sshCommandTimeoutMs", "sshReadyTimeoutMs", "updatedAt", "webhookMaxRetries", "webhookRetryDelaysMs", "webhookTimeoutMs") SELECT "activeUserWindowMin", "agentCallbackUrl", "agentOfflineThresholdMs", "agentStaleThresholdMs", "defaultLogLines", "doRegistryToken", "id", "maxUploadSizeMb", "pgDumpTimeoutMs", "registryMaxTags", "sshCommandTimeoutMs", "sshReadyTimeoutMs", "updatedAt", "webhookMaxRetries", "webhookRetryDelaysMs", "webhookTimeoutMs" FROM "SystemSettings";
DROP TABLE "SystemSettings";
ALTER TABLE "new_SystemSettings" RENAME TO "SystemSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
