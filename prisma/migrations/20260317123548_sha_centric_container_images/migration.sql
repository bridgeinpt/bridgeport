/*
  SHA-Centric Container Image Management Migration

  This migration:
  1. Creates the ImageDigest table for tracking discovered image SHAs
  2. Removes currentTag, latestTag, latestDigest, deployedDigest from ContainerImage
  3. Adds tagFilter to ContainerImage (derived from old currentTag)
  4. Adds imageDigestId FK to Service and ContainerImageHistory
  5. Backfills ImageDigest records from existing deployedDigest data
  6. Links existing Services and History entries to backfilled digests
*/

-- CreateTable
CREATE TABLE "ImageDigest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerImageId" TEXT NOT NULL,
    "manifestDigest" TEXT NOT NULL,
    "configDigest" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "size" BIGINT,
    "pushedAt" DATETIME,
    "discoveredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImageDigest_containerImageId_fkey" FOREIGN KEY ("containerImageId") REFERENCES "ContainerImage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Backfill ImageDigest from existing ContainerImage.deployedDigest
-- Uses hex(randomblob(12)) to generate unique IDs (24 hex chars, similar to cuid length)
INSERT INTO "ImageDigest" ("id", "containerImageId", "manifestDigest", "tags", "discoveredAt", "updatedAt")
SELECT
    lower(hex(randomblob(12))),
    "id",
    "deployedDigest",
    json_array(COALESCE("currentTag", 'latest')),
    COALESCE("lastCheckedAt", datetime('now')),
    datetime('now')
FROM "ContainerImage"
WHERE "deployedDigest" IS NOT NULL AND "deployedDigest" != '';

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Recreate ContainerImage: drop removed columns, add tagFilter derived from currentTag
CREATE TABLE "new_ContainerImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "imageName" TEXT NOT NULL,
    "tagFilter" TEXT NOT NULL DEFAULT 'latest',
    "lastCheckedAt" DATETIME,
    "updateAvailable" BOOLEAN NOT NULL DEFAULT false,
    "autoUpdate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    "registryConnectionId" TEXT,
    CONSTRAINT "ContainerImage_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContainerImage_registryConnectionId_fkey" FOREIGN KEY ("registryConnectionId") REFERENCES "RegistryConnection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
-- Copy data, deriving tagFilter from the old currentTag value
INSERT INTO "new_ContainerImage" ("id", "name", "imageName", "tagFilter", "lastCheckedAt", "updateAvailable", "autoUpdate", "createdAt", "updatedAt", "environmentId", "registryConnectionId")
SELECT "id", "name", "imageName", COALESCE("currentTag", 'latest'), "lastCheckedAt", "updateAvailable", "autoUpdate", "createdAt", "updatedAt", "environmentId", "registryConnectionId"
FROM "ContainerImage";
DROP TABLE "ContainerImage";
ALTER TABLE "new_ContainerImage" RENAME TO "ContainerImage";
CREATE UNIQUE INDEX "ContainerImage_environmentId_imageName_key" ON "ContainerImage"("environmentId", "imageName");

-- Recreate ContainerImageHistory: add imageDigestId
CREATE TABLE "new_ContainerImageHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tag" TEXT NOT NULL,
    "digest" TEXT,
    "status" TEXT NOT NULL DEFAULT 'success',
    "deployedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deployedBy" TEXT,
    "containerImageId" TEXT NOT NULL,
    "imageDigestId" TEXT,
    CONSTRAINT "ContainerImageHistory_containerImageId_fkey" FOREIGN KEY ("containerImageId") REFERENCES "ContainerImage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContainerImageHistory_imageDigestId_fkey" FOREIGN KEY ("imageDigestId") REFERENCES "ImageDigest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ContainerImageHistory" ("id", "tag", "digest", "status", "deployedAt", "deployedBy", "containerImageId")
SELECT "id", "tag", "digest", "status", "deployedAt", "deployedBy", "containerImageId"
FROM "ContainerImageHistory";
DROP TABLE "ContainerImageHistory";
ALTER TABLE "new_ContainerImageHistory" RENAME TO "ContainerImageHistory";
CREATE INDEX "ContainerImageHistory_containerImageId_deployedAt_idx" ON "ContainerImageHistory"("containerImageId", "deployedAt" DESC);

-- Backfill ContainerImageHistory.imageDigestId by matching on containerImageId + digest
UPDATE "ContainerImageHistory"
SET "imageDigestId" = (
    SELECT "id" FROM "ImageDigest"
    WHERE "ImageDigest"."containerImageId" = "ContainerImageHistory"."containerImageId"
      AND "ImageDigest"."manifestDigest" = "ContainerImageHistory"."digest"
    LIMIT 1
)
WHERE "digest" IS NOT NULL AND "digest" != '';

-- Recreate Service: add imageDigestId
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
    "tcpChecks" TEXT,
    "agentTcpCheckResults" TEXT,
    "agentTcpCheckedAt" DATETIME,
    "certChecks" TEXT,
    "agentCertCheckResults" TEXT,
    "agentCertCheckedAt" DATETIME,
    "serverId" TEXT NOT NULL,
    "serviceTypeId" TEXT,
    "containerImageId" TEXT NOT NULL,
    "imageDigestId" TEXT,
    CONSTRAINT "Service_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Service_serviceTypeId_fkey" FOREIGN KEY ("serviceTypeId") REFERENCES "ServiceType" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Service_containerImageId_fkey" FOREIGN KEY ("containerImageId") REFERENCES "ContainerImage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Service_imageDigestId_fkey" FOREIGN KEY ("imageDigestId") REFERENCES "ImageDigest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Service" ("id", "name", "containerName", "imageTag", "composePath", "composeTemplate", "healthCheckUrl", "status", "containerStatus", "healthStatus", "exposedPorts", "discoveryStatus", "lastCheckedAt", "lastDiscoveredAt", "createdAt", "updatedAt", "healthWaitMs", "healthRetries", "healthIntervalMs", "agentHealthSuccess", "agentHealthStatusCode", "agentHealthDurationMs", "agentHealthCheckedAt", "tcpChecks", "agentTcpCheckResults", "agentTcpCheckedAt", "certChecks", "agentCertCheckResults", "agentCertCheckedAt", "serverId", "serviceTypeId", "containerImageId")
SELECT "id", "name", "containerName", "imageTag", "composePath", "composeTemplate", "healthCheckUrl", "status", "containerStatus", "healthStatus", "exposedPorts", "discoveryStatus", "lastCheckedAt", "lastDiscoveredAt", "createdAt", "updatedAt", "healthWaitMs", "healthRetries", "healthIntervalMs", "agentHealthSuccess", "agentHealthStatusCode", "agentHealthDurationMs", "agentHealthCheckedAt", "tcpChecks", "agentTcpCheckResults", "agentTcpCheckedAt", "certChecks", "agentCertCheckResults", "agentCertCheckedAt", "serverId", "serviceTypeId", "containerImageId"
FROM "Service";
DROP TABLE "Service";
ALTER TABLE "new_Service" RENAME TO "Service";
CREATE UNIQUE INDEX "Service_serverId_name_key" ON "Service"("serverId", "name");

-- Backfill Service.imageDigestId by matching on containerImageId to the backfilled ImageDigest
UPDATE "Service"
SET "imageDigestId" = (
    SELECT "id" FROM "ImageDigest"
    WHERE "ImageDigest"."containerImageId" = "Service"."containerImageId"
    ORDER BY "ImageDigest"."discoveredAt" DESC
    LIMIT 1
)
WHERE "containerImageId" IN (SELECT DISTINCT "containerImageId" FROM "ImageDigest");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ImageDigest_containerImageId_discoveredAt_idx" ON "ImageDigest"("containerImageId", "discoveredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ImageDigest_containerImageId_manifestDigest_key" ON "ImageDigest"("containerImageId", "manifestDigest");
