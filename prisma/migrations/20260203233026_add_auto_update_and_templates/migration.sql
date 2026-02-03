/*
  Warnings:

  - You are about to drop the column `autoUpdate` on the `Service` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN "durationMs" INTEGER;

-- CreateTable
CREATE TABLE "DeploymentTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "environmentId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "DeploymentTemplate_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeploymentTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ContainerImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imageName" TEXT NOT NULL,
    "currentTag" TEXT NOT NULL,
    "latestTag" TEXT,
    "latestDigest" TEXT,
    "lastCheckedAt" DATETIME,
    "autoUpdate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    "registryConnectionId" TEXT,
    CONSTRAINT "ContainerImage_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContainerImage_registryConnectionId_fkey" FOREIGN KEY ("registryConnectionId") REFERENCES "RegistryConnection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- Copy data including autoUpdate migrated from Service (if ANY linked service has autoUpdate=true)
INSERT INTO "new_ContainerImage" ("createdAt", "currentTag", "environmentId", "id", "imageName", "lastCheckedAt", "latestDigest", "latestTag", "name", "registryConnectionId", "updatedAt", "autoUpdate")
SELECT
    ci."createdAt",
    ci."currentTag",
    ci."environmentId",
    ci."id",
    ci."imageName",
    ci."lastCheckedAt",
    ci."latestDigest",
    ci."latestTag",
    ci."name",
    ci."registryConnectionId",
    ci."updatedAt",
    COALESCE((SELECT MAX(s."autoUpdate") FROM "Service" s WHERE s."containerImageId" = ci."id"), 0)
FROM "ContainerImage" ci;
DROP TABLE "ContainerImage";
ALTER TABLE "new_ContainerImage" RENAME TO "ContainerImage";
CREATE UNIQUE INDEX "ContainerImage_environmentId_imageName_key" ON "ContainerImage"("environmentId", "imageName");
CREATE TABLE "new_DeploymentPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "imageTag" TEXT,
    "triggerType" TEXT NOT NULL,
    "triggeredBy" TEXT,
    "autoRollback" BOOLEAN NOT NULL DEFAULT true,
    "parallelExecution" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "error" TEXT,
    "logs" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "environmentId" TEXT NOT NULL,
    "containerImageId" TEXT,
    "userId" TEXT,
    "templateId" TEXT,
    CONSTRAINT "DeploymentPlan_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlan_containerImageId_fkey" FOREIGN KEY ("containerImageId") REFERENCES "ContainerImage" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlan_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DeploymentTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DeploymentPlan" ("autoRollback", "completedAt", "containerImageId", "createdAt", "environmentId", "error", "id", "imageTag", "logs", "name", "startedAt", "status", "triggerType", "triggeredBy", "userId") SELECT "autoRollback", "completedAt", "containerImageId", "createdAt", "environmentId", "error", "id", "imageTag", "logs", "name", "startedAt", "status", "triggerType", "triggeredBy", "userId" FROM "DeploymentPlan";
DROP TABLE "DeploymentPlan";
ALTER TABLE "new_DeploymentPlan" RENAME TO "DeploymentPlan";
CREATE INDEX "DeploymentPlan_environmentId_createdAt_idx" ON "DeploymentPlan"("environmentId", "createdAt" DESC);
CREATE TABLE "new_Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "imageTag" TEXT NOT NULL DEFAULT 'latest',
    "composePath" TEXT,
    "composeTemplate" TEXT,
    "healthCheckUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "containerStatus" TEXT NOT NULL DEFAULT 'unknown',
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "exposedPorts" TEXT,
    "discoveryStatus" TEXT NOT NULL DEFAULT 'found',
    "lastCheckedAt" DATETIME,
    "lastDiscoveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "healthWaitMs" INTEGER NOT NULL DEFAULT 30000,
    "healthRetries" INTEGER NOT NULL DEFAULT 3,
    "healthIntervalMs" INTEGER NOT NULL DEFAULT 5000,
    "agentHealthSuccess" BOOLEAN,
    "agentHealthStatusCode" INTEGER,
    "agentHealthDurationMs" INTEGER,
    "agentHealthCheckedAt" DATETIME,
    "serverId" TEXT NOT NULL,
    "serviceTypeId" TEXT,
    "containerImageId" TEXT NOT NULL,
    CONSTRAINT "Service_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Service_serviceTypeId_fkey" FOREIGN KEY ("serviceTypeId") REFERENCES "ServiceType" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Service_containerImageId_fkey" FOREIGN KEY ("containerImageId") REFERENCES "ContainerImage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Service" ("agentHealthCheckedAt", "agentHealthDurationMs", "agentHealthStatusCode", "agentHealthSuccess", "composePath", "composeTemplate", "containerImageId", "containerName", "containerStatus", "createdAt", "discoveryStatus", "exposedPorts", "healthCheckUrl", "healthIntervalMs", "healthRetries", "healthStatus", "healthWaitMs", "id", "imageTag", "lastCheckedAt", "lastDiscoveredAt", "name", "serverId", "serviceTypeId", "status", "updatedAt") SELECT "agentHealthCheckedAt", "agentHealthDurationMs", "agentHealthStatusCode", "agentHealthSuccess", "composePath", "composeTemplate", "containerImageId", "containerName", "containerStatus", "createdAt", "discoveryStatus", "exposedPorts", "healthCheckUrl", "healthIntervalMs", "healthRetries", "healthStatus", "healthWaitMs", "id", "imageTag", "lastCheckedAt", "lastDiscoveredAt", "name", "serverId", "serviceTypeId", "status", "updatedAt" FROM "Service";
DROP TABLE "Service";
ALTER TABLE "new_Service" RENAME TO "Service";
CREATE UNIQUE INDEX "Service_serverId_name_key" ON "Service"("serverId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentTemplate_environmentId_name_key" ON "DeploymentTemplate"("environmentId", "name");
