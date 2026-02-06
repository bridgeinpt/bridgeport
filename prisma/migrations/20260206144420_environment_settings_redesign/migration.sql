-- Environment Settings Redesign
-- Migrates sshUser, allowSecretReveal, allowBackupDownload, schedulerConfig
-- from Environment into dedicated per-module settings tables.

-- Step 1: Create new settings tables

-- CreateTable
CREATE TABLE "GeneralSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "sshUser" TEXT NOT NULL DEFAULT 'root',
    CONSTRAINT "GeneralSettings_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MonitoringSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "serverHealthIntervalMs" INTEGER NOT NULL DEFAULT 60000,
    "serviceHealthIntervalMs" INTEGER NOT NULL DEFAULT 60000,
    "discoveryIntervalMs" INTEGER NOT NULL DEFAULT 300000,
    "metricsIntervalMs" INTEGER NOT NULL DEFAULT 300000,
    "updateCheckIntervalMs" INTEGER NOT NULL DEFAULT 1800000,
    "backupCheckIntervalMs" INTEGER NOT NULL DEFAULT 60000,
    "metricsRetentionDays" INTEGER NOT NULL DEFAULT 7,
    "healthLogRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "bounceThreshold" INTEGER NOT NULL DEFAULT 3,
    "bounceCooldownMs" INTEGER NOT NULL DEFAULT 900000,
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

-- CreateTable
CREATE TABLE "OperationsSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "defaultDockerMode" TEXT NOT NULL DEFAULT 'ssh',
    "defaultMetricsMode" TEXT NOT NULL DEFAULT 'disabled',
    CONSTRAINT "OperationsSettings_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DataSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "allowBackupDownload" BOOLEAN NOT NULL DEFAULT false,
    "defaultMonitoringEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultCollectionIntervalSec" INTEGER NOT NULL DEFAULT 300,
    CONSTRAINT "DataSettings_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConfigurationSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "allowSecretReveal" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ConfigurationSettings_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Step 2: Migrate existing data from Environment to new tables
-- Must happen BEFORE we drop old columns from Environment

-- GeneralSettings: migrate sshUser
INSERT INTO "GeneralSettings" ("id", "environmentId", "sshUser")
SELECT lower(hex(randomblob(12))), "id", COALESCE("sshUser", 'root')
FROM "Environment";

-- MonitoringSettings: parse schedulerConfig JSON blob into typed columns
-- Set enabled=true for existing environments (monitoring was implicitly enabled)
INSERT INTO "MonitoringSettings" (
    "id", "environmentId", "enabled",
    "serverHealthIntervalMs", "serviceHealthIntervalMs", "discoveryIntervalMs",
    "metricsIntervalMs", "updateCheckIntervalMs", "backupCheckIntervalMs",
    "metricsRetentionDays", "healthLogRetentionDays",
    "bounceThreshold", "bounceCooldownMs",
    "collectCpu", "collectMemory", "collectSwap", "collectDisk",
    "collectLoad", "collectFds", "collectTcp", "collectProcesses",
    "collectTcpChecks", "collectCertChecks"
)
SELECT
    lower(hex(randomblob(12))),
    "id",
    1, -- enabled=true for existing environments
    COALESCE(json_extract("schedulerConfig", '$.serverHealthIntervalMs'), 60000),
    COALESCE(json_extract("schedulerConfig", '$.serviceHealthIntervalMs'), 60000),
    COALESCE(json_extract("schedulerConfig", '$.discoveryIntervalMs'), 300000),
    COALESCE(json_extract("schedulerConfig", '$.metricsIntervalMs'), 300000),
    COALESCE(json_extract("schedulerConfig", '$.updateCheckIntervalMs'), 1800000),
    COALESCE(json_extract("schedulerConfig", '$.backupCheckIntervalMs'), 60000),
    COALESCE(json_extract("schedulerConfig", '$.metricsRetentionDays'), 7),
    COALESCE(json_extract("schedulerConfig", '$.healthLogRetentionDays'), 30),
    COALESCE(json_extract("schedulerConfig", '$.bounceThreshold'), 3),
    COALESCE(json_extract("schedulerConfig", '$.bounceCooldownMs'), 900000),
    COALESCE(json_extract("schedulerConfig", '$.collectCpu'), 1),
    COALESCE(json_extract("schedulerConfig", '$.collectMemory'), 1),
    COALESCE(json_extract("schedulerConfig", '$.collectSwap'), 1),
    COALESCE(json_extract("schedulerConfig", '$.collectDisk'), 1),
    COALESCE(json_extract("schedulerConfig", '$.collectLoad'), 1),
    COALESCE(json_extract("schedulerConfig", '$.collectFds'), 1),
    COALESCE(json_extract("schedulerConfig", '$.collectTcp'), 1),
    COALESCE(json_extract("schedulerConfig", '$.collectProcesses'), 1),
    COALESCE(json_extract("schedulerConfig", '$.collectTcpChecks'), 1),
    COALESCE(json_extract("schedulerConfig", '$.collectCertChecks'), 1)
FROM "Environment";

-- OperationsSettings: new fields with defaults only
INSERT INTO "OperationsSettings" ("id", "environmentId", "defaultDockerMode", "defaultMetricsMode")
SELECT lower(hex(randomblob(12))), "id", 'ssh', 'disabled'
FROM "Environment";

-- DataSettings: migrate allowBackupDownload
INSERT INTO "DataSettings" ("id", "environmentId", "allowBackupDownload", "defaultMonitoringEnabled", "defaultCollectionIntervalSec")
SELECT lower(hex(randomblob(12))), "id", COALESCE("allowBackupDownload", 0), 0, 300
FROM "Environment";

-- ConfigurationSettings: migrate allowSecretReveal
INSERT INTO "ConfigurationSettings" ("id", "environmentId", "allowSecretReveal")
SELECT lower(hex(randomblob(12))), "id", COALESCE("allowSecretReveal", 1)
FROM "Environment";

-- Step 3: Recreate Environment table without old columns

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Environment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sshPrivateKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Environment" ("createdAt", "id", "name", "sshPrivateKey", "updatedAt") SELECT "createdAt", "id", "name", "sshPrivateKey", "updatedAt" FROM "Environment";
DROP TABLE "Environment";
ALTER TABLE "new_Environment" RENAME TO "Environment";
CREATE UNIQUE INDEX "Environment_name_key" ON "Environment"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Step 4: Create unique indexes on settings tables

CREATE UNIQUE INDEX "GeneralSettings_environmentId_key" ON "GeneralSettings"("environmentId");
CREATE UNIQUE INDEX "MonitoringSettings_environmentId_key" ON "MonitoringSettings"("environmentId");
CREATE UNIQUE INDEX "OperationsSettings_environmentId_key" ON "OperationsSettings"("environmentId");
CREATE UNIQUE INDEX "DataSettings_environmentId_key" ON "DataSettings"("environmentId");
CREATE UNIQUE INDEX "ConfigurationSettings_environmentId_key" ON "ConfigurationSettings"("environmentId");
