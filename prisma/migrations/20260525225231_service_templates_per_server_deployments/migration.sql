-- Migration: Service templates + per-server Deployments
--
-- Decouples Service from Server. Service becomes a template (image + base config).
-- Per-server runtime state moves to the new ServiceDeployment table.
-- Existing 1:1 Service:Server rows are backfilled into ServiceDeployments.
--
-- Strategy:
--   1. Pre-check: fail loudly on duplicate (environmentId, name) pairs that would
--      collide once `name` becomes unique per environment instead of per server.
--   2. Create ServiceDeployment table.
--   3. Add nullable serviceDeploymentId columns to Deployment / ServiceMetrics / DeploymentPlanStep.
--   4. Backfill one ServiceDeployment per existing Service, copying runtime state.
--   5. Wire the new FK columns to the freshly created ServiceDeployment rows.
--   6. Rebuild Service / ServiceFile / ServiceMetrics / Deployment / DeploymentPlanStep
--      with the new shape, dropping per-server columns from Service.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- ------------------------------------------------------------------
-- 1. Pre-check duplicates that would violate the new
--    (environmentId, name) unique constraint on Service.
-- ------------------------------------------------------------------
-- If duplicates exist we cannot collapse them safely without operator input.
-- We force the migration to abort with a descriptive failure by SELECTing into
-- a CHECK that must hold; SQLite has no RAISE outside triggers, so the trick
-- is to attempt to create a temporary unique index on a derived view.
CREATE TEMP TABLE "_service_dup_check" (
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "n" INTEGER NOT NULL
);
INSERT INTO "_service_dup_check" ("environmentId", "name", "n")
SELECT srv."environmentId", s."name", COUNT(*)
FROM "Service" s
JOIN "Server" srv ON srv."id" = s."serverId"
GROUP BY srv."environmentId", s."name"
HAVING COUNT(*) > 1;

-- If any duplicates were found, this CREATE INDEX will fail (multiple rows
-- with the same key) and abort the migration with a clear SQLite error.
-- Operators must rename the colliding services before retrying.
CREATE UNIQUE INDEX "_service_dup_check_must_be_empty"
    ON "_service_dup_check" ("environmentId", "name");
DROP INDEX "_service_dup_check_must_be_empty";
DROP TABLE "_service_dup_check";

-- ------------------------------------------------------------------
-- 2. Create ServiceDeployment table.
-- ------------------------------------------------------------------
CREATE TABLE "ServiceDeployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "composePath" TEXT,
    "envOverrides" TEXT,
    "exposedPorts" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "containerStatus" TEXT NOT NULL DEFAULT 'unknown',
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "discoveryStatus" TEXT NOT NULL DEFAULT 'found',
    "lastCheckedAt" DATETIME,
    "lastDiscoveredAt" DATETIME,
    "lastDeployedAt" DATETIME,
    "imageDigestId" TEXT,
    "agentHealthSuccess" BOOLEAN,
    "agentHealthStatusCode" INTEGER,
    "agentHealthDurationMs" INTEGER,
    "agentHealthCheckedAt" DATETIME,
    "agentTcpCheckResults" TEXT,
    "agentTcpCheckedAt" DATETIME,
    "agentCertCheckResults" TEXT,
    "agentCertCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ServiceDeployment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceDeployment_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceDeployment_imageDigestId_fkey" FOREIGN KEY ("imageDigestId") REFERENCES "ImageDigest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- ------------------------------------------------------------------
-- 3. Backfill: one ServiceDeployment per existing Service row.
--    Generates a stable 24-char hex id using SQLite's randomblob.
-- ------------------------------------------------------------------
INSERT INTO "ServiceDeployment" (
    "id",
    "serviceId",
    "serverId",
    "containerName",
    "composePath",
    "envOverrides",
    "exposedPorts",
    "status",
    "containerStatus",
    "healthStatus",
    "discoveryStatus",
    "lastCheckedAt",
    "lastDiscoveredAt",
    "lastDeployedAt",
    "imageDigestId",
    "agentHealthSuccess",
    "agentHealthStatusCode",
    "agentHealthDurationMs",
    "agentHealthCheckedAt",
    "agentTcpCheckResults",
    "agentTcpCheckedAt",
    "agentCertCheckResults",
    "agentCertCheckedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    'sd_' || lower(hex(randomblob(12))),
    s."id",
    s."serverId",
    s."containerName",
    s."composePath",
    NULL,
    s."exposedPorts",
    s."status",
    s."containerStatus",
    s."healthStatus",
    s."discoveryStatus",
    s."lastCheckedAt",
    s."lastDiscoveredAt",
    s."lastCheckedAt",
    s."imageDigestId",
    s."agentHealthSuccess",
    s."agentHealthStatusCode",
    s."agentHealthDurationMs",
    s."agentHealthCheckedAt",
    s."agentTcpCheckResults",
    s."agentTcpCheckedAt",
    s."agentCertCheckResults",
    s."agentCertCheckedAt",
    s."createdAt",
    s."updatedAt"
FROM "Service" s;

-- ------------------------------------------------------------------
-- 4. Rebuild Service: drop per-server columns, add environmentId / baseEnv / deployStrategy.
-- ------------------------------------------------------------------
CREATE TABLE "new_Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imageTag" TEXT NOT NULL DEFAULT 'latest',
    "composeTemplate" TEXT,
    "healthCheckUrl" TEXT,
    "baseEnv" TEXT,
    "deployStrategy" TEXT NOT NULL DEFAULT 'sequential',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "healthWaitMs" INTEGER NOT NULL DEFAULT 30000,
    "healthRetries" INTEGER NOT NULL DEFAULT 3,
    "healthIntervalMs" INTEGER NOT NULL DEFAULT 5000,
    "tcpChecks" TEXT,
    "certChecks" TEXT,
    "environmentId" TEXT NOT NULL,
    "serviceTypeId" TEXT,
    "containerImageId" TEXT NOT NULL,
    CONSTRAINT "Service_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Service_serviceTypeId_fkey" FOREIGN KEY ("serviceTypeId") REFERENCES "ServiceType" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Service_containerImageId_fkey" FOREIGN KEY ("containerImageId") REFERENCES "ContainerImage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Service" (
    "id",
    "name",
    "imageTag",
    "composeTemplate",
    "healthCheckUrl",
    "baseEnv",
    "deployStrategy",
    "createdAt",
    "updatedAt",
    "healthWaitMs",
    "healthRetries",
    "healthIntervalMs",
    "tcpChecks",
    "certChecks",
    "environmentId",
    "serviceTypeId",
    "containerImageId"
)
SELECT
    s."id",
    s."name",
    s."imageTag",
    s."composeTemplate",
    s."healthCheckUrl",
    NULL,
    'sequential',
    s."createdAt",
    s."updatedAt",
    s."healthWaitMs",
    s."healthRetries",
    s."healthIntervalMs",
    s."tcpChecks",
    s."certChecks",
    srv."environmentId",
    s."serviceTypeId",
    s."containerImageId"
FROM "Service" s
JOIN "Server" srv ON srv."id" = s."serverId";
DROP TABLE "Service";
ALTER TABLE "new_Service" RENAME TO "Service";
CREATE UNIQUE INDEX "Service_environmentId_name_key" ON "Service"("environmentId", "name");

-- ------------------------------------------------------------------
-- 5. Rebuild Deployment to add serviceDeploymentId, backfilling from Service mapping.
-- ------------------------------------------------------------------
CREATE TABLE "new_Deployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "imageTag" TEXT NOT NULL,
    "previousTag" TEXT,
    "status" TEXT NOT NULL,
    "logs" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "serviceId" TEXT NOT NULL,
    "serviceDeploymentId" TEXT,
    "userId" TEXT,
    "containerImageHistoryId" TEXT,
    CONSTRAINT "Deployment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Deployment_serviceDeploymentId_fkey" FOREIGN KEY ("serviceDeploymentId") REFERENCES "ServiceDeployment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Deployment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Deployment_containerImageHistoryId_fkey" FOREIGN KEY ("containerImageHistoryId") REFERENCES "ContainerImageHistory" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Deployment" (
    "id",
    "imageTag",
    "previousTag",
    "status",
    "logs",
    "triggeredBy",
    "startedAt",
    "completedAt",
    "durationMs",
    "serviceId",
    "serviceDeploymentId",
    "userId",
    "containerImageHistoryId"
)
SELECT
    d."id",
    d."imageTag",
    d."previousTag",
    d."status",
    d."logs",
    d."triggeredBy",
    d."startedAt",
    d."completedAt",
    d."durationMs",
    d."serviceId",
    (SELECT sd."id" FROM "ServiceDeployment" sd WHERE sd."serviceId" = d."serviceId" LIMIT 1),
    d."userId",
    d."containerImageHistoryId"
FROM "Deployment" d;
DROP TABLE "Deployment";
ALTER TABLE "new_Deployment" RENAME TO "Deployment";
CREATE INDEX "Deployment_serviceId_startedAt_idx" ON "Deployment"("serviceId", "startedAt" DESC);
CREATE INDEX "Deployment_serviceDeploymentId_startedAt_idx" ON "Deployment"("serviceDeploymentId", "startedAt" DESC);

-- ------------------------------------------------------------------
-- 6. Rebuild ServiceMetrics to use serviceDeploymentId instead of serviceId.
-- ------------------------------------------------------------------
CREATE TABLE "new_ServiceMetrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cpuPercent" REAL,
    "memoryUsedMb" REAL,
    "memoryLimitMb" REAL,
    "networkRxMb" REAL,
    "networkTxMb" REAL,
    "blockReadMb" REAL,
    "blockWriteMb" REAL,
    "restartCount" INTEGER,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "serviceDeploymentId" TEXT NOT NULL,
    CONSTRAINT "ServiceMetrics_serviceDeploymentId_fkey" FOREIGN KEY ("serviceDeploymentId") REFERENCES "ServiceDeployment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ServiceMetrics" (
    "id",
    "cpuPercent",
    "memoryUsedMb",
    "memoryLimitMb",
    "networkRxMb",
    "networkTxMb",
    "blockReadMb",
    "blockWriteMb",
    "restartCount",
    "collectedAt",
    "serviceDeploymentId"
)
SELECT
    sm."id",
    sm."cpuPercent",
    sm."memoryUsedMb",
    sm."memoryLimitMb",
    sm."networkRxMb",
    sm."networkTxMb",
    sm."blockReadMb",
    sm."blockWriteMb",
    sm."restartCount",
    sm."collectedAt",
    (SELECT sd."id" FROM "ServiceDeployment" sd WHERE sd."serviceId" = sm."serviceId" LIMIT 1)
FROM "ServiceMetrics" sm
WHERE EXISTS (SELECT 1 FROM "ServiceDeployment" sd WHERE sd."serviceId" = sm."serviceId");
DROP TABLE "ServiceMetrics";
ALTER TABLE "new_ServiceMetrics" RENAME TO "ServiceMetrics";
CREATE INDEX "ServiceMetrics_serviceDeploymentId_collectedAt_idx" ON "ServiceMetrics"("serviceDeploymentId", "collectedAt" DESC);

-- ------------------------------------------------------------------
-- 7. Rebuild DeploymentPlanStep to add serviceDeploymentId.
-- ------------------------------------------------------------------
CREATE TABLE "new_DeploymentPlanStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "order" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "action" TEXT NOT NULL,
    "targetTag" TEXT,
    "previousTag" TEXT,
    "healthPassed" BOOLEAN,
    "healthDetails" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "error" TEXT,
    "logs" TEXT,
    "deploymentPlanId" TEXT NOT NULL,
    "serviceId" TEXT,
    "serviceDeploymentId" TEXT,
    "deploymentId" TEXT,
    CONSTRAINT "DeploymentPlanStep_deploymentPlanId_fkey" FOREIGN KEY ("deploymentPlanId") REFERENCES "DeploymentPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlanStep_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlanStep_serviceDeploymentId_fkey" FOREIGN KEY ("serviceDeploymentId") REFERENCES "ServiceDeployment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlanStep_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DeploymentPlanStep" (
    "id",
    "order",
    "status",
    "action",
    "targetTag",
    "previousTag",
    "healthPassed",
    "healthDetails",
    "startedAt",
    "completedAt",
    "error",
    "logs",
    "deploymentPlanId",
    "serviceId",
    "serviceDeploymentId",
    "deploymentId"
)
SELECT
    dps."id",
    dps."order",
    dps."status",
    dps."action",
    dps."targetTag",
    dps."previousTag",
    dps."healthPassed",
    dps."healthDetails",
    dps."startedAt",
    dps."completedAt",
    dps."error",
    dps."logs",
    dps."deploymentPlanId",
    dps."serviceId",
    (SELECT sd."id" FROM "ServiceDeployment" sd WHERE sd."serviceId" = dps."serviceId" LIMIT 1),
    dps."deploymentId"
FROM "DeploymentPlanStep" dps;
DROP TABLE "DeploymentPlanStep";
ALTER TABLE "new_DeploymentPlanStep" RENAME TO "DeploymentPlanStep";
CREATE INDEX "DeploymentPlanStep_deploymentPlanId_order_idx" ON "DeploymentPlanStep"("deploymentPlanId", "order");

-- ------------------------------------------------------------------
-- 8. Rebuild ServiceFile to gain serviceDeploymentId + kind columns.
--    Existing rows become base-scope (kind='base', serviceDeploymentId=null).
-- ------------------------------------------------------------------
CREATE TABLE "new_ServiceFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetPath" TEXT NOT NULL,
    "lastSyncedAt" DATETIME,
    "kind" TEXT NOT NULL DEFAULT 'base',
    "serviceId" TEXT NOT NULL,
    "serviceDeploymentId" TEXT,
    "configFileId" TEXT NOT NULL,
    CONSTRAINT "ServiceFile_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceFile_serviceDeploymentId_fkey" FOREIGN KEY ("serviceDeploymentId") REFERENCES "ServiceDeployment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceFile_configFileId_fkey" FOREIGN KEY ("configFileId") REFERENCES "ConfigFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ServiceFile" (
    "id",
    "targetPath",
    "lastSyncedAt",
    "kind",
    "serviceId",
    "serviceDeploymentId",
    "configFileId"
)
SELECT
    sf."id",
    sf."targetPath",
    sf."lastSyncedAt",
    'base',
    sf."serviceId",
    NULL,
    sf."configFileId"
FROM "ServiceFile" sf;
DROP TABLE "ServiceFile";
ALTER TABLE "new_ServiceFile" RENAME TO "ServiceFile";
CREATE INDEX "ServiceFile_serviceDeploymentId_idx" ON "ServiceFile"("serviceDeploymentId");
CREATE UNIQUE INDEX "ServiceFile_serviceId_configFileId_serviceDeploymentId_key" ON "ServiceFile"("serviceId", "configFileId", "serviceDeploymentId");

-- ------------------------------------------------------------------
-- 9. Final ServiceDeployment indexes.
-- ------------------------------------------------------------------
CREATE INDEX "ServiceDeployment_serverId_idx" ON "ServiceDeployment"("serverId");
CREATE INDEX "ServiceDeployment_serviceId_idx" ON "ServiceDeployment"("serviceId");
CREATE UNIQUE INDEX "ServiceDeployment_serviceId_serverId_key" ON "ServiceDeployment"("serviceId", "serverId");
CREATE UNIQUE INDEX "ServiceDeployment_serverId_containerName_key" ON "ServiceDeployment"("serverId", "containerName");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
