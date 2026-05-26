-- AlterTable
ALTER TABLE "Server" ADD COLUMN "lastCheckAt" DATETIME;
ALTER TABLE "Server" ADD COLUMN "lastCheckDurationMs" INTEGER;
ALTER TABLE "Server" ADD COLUMN "lastCheckError" TEXT;
ALTER TABLE "Server" ADD COLUMN "lastCheckStatus" TEXT;
ALTER TABLE "Server" ADD COLUMN "lastCheckType" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN "lastCheckAt" DATETIME;
ALTER TABLE "Service" ADD COLUMN "lastCheckDurationMs" INTEGER;
ALTER TABLE "Service" ADD COLUMN "lastCheckError" TEXT;
ALTER TABLE "Service" ADD COLUMN "lastCheckStatus" TEXT;
ALTER TABLE "Service" ADD COLUMN "lastCheckType" TEXT;

-- Backfill Server.lastCheck* from most recent HealthCheckLog (resourceType = 'server').
-- The @@index([resourceId, createdAt(sort: Desc)]) on HealthCheckLog keeps this cheap.
UPDATE "Server"
SET
  "lastCheckStatus"     = (SELECT h."status"       FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastCheckAt"         = (SELECT h."createdAt"    FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastCheckType"       = (SELECT h."checkType"    FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastCheckDurationMs" = (SELECT h."durationMs"   FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastCheckError"      = (SELECT h."errorMessage" FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id" ORDER BY h."createdAt" DESC LIMIT 1)
WHERE EXISTS (
  SELECT 1 FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id"
);

-- Backfill Service.lastCheck* from most recent HealthCheckLog. Both 'service' and 'container'
-- resourceTypes point at Service.id (per scheduler.ts: container_health checks update services).
UPDATE "Service"
SET
  "lastCheckStatus"     = (SELECT h."status"       FROM "HealthCheckLog" h WHERE h."resourceType" IN ('service', 'container') AND h."resourceId" = "Service"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastCheckAt"         = (SELECT h."createdAt"    FROM "HealthCheckLog" h WHERE h."resourceType" IN ('service', 'container') AND h."resourceId" = "Service"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastCheckType"       = (SELECT h."checkType"    FROM "HealthCheckLog" h WHERE h."resourceType" IN ('service', 'container') AND h."resourceId" = "Service"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastCheckDurationMs" = (SELECT h."durationMs"   FROM "HealthCheckLog" h WHERE h."resourceType" IN ('service', 'container') AND h."resourceId" = "Service"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastCheckError"      = (SELECT h."errorMessage" FROM "HealthCheckLog" h WHERE h."resourceType" IN ('service', 'container') AND h."resourceId" = "Service"."id" ORDER BY h."createdAt" DESC LIMIT 1)
WHERE EXISTS (
  SELECT 1 FROM "HealthCheckLog" h WHERE h."resourceType" IN ('service', 'container') AND h."resourceId" = "Service"."id"
);
