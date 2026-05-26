-- AlterTable
ALTER TABLE "Server" ADD COLUMN "lastHealthCheckAt" DATETIME;
ALTER TABLE "Server" ADD COLUMN "lastHealthCheckDurationMs" INTEGER;
ALTER TABLE "Server" ADD COLUMN "lastHealthCheckError" TEXT;
ALTER TABLE "Server" ADD COLUMN "lastHealthCheckStatus" TEXT;
ALTER TABLE "Server" ADD COLUMN "lastHealthCheckType" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN "lastHealthCheckAt" DATETIME;
ALTER TABLE "Service" ADD COLUMN "lastHealthCheckDurationMs" INTEGER;
ALTER TABLE "Service" ADD COLUMN "lastHealthCheckError" TEXT;
ALTER TABLE "Service" ADD COLUMN "lastHealthCheckStatus" TEXT;
ALTER TABLE "Service" ADD COLUMN "lastHealthCheckType" TEXT;

-- Backfill Server.lastHealthCheck* from most recent HealthCheckLog (resourceType = 'server').
-- The @@index([resourceId, createdAt(sort: Desc)]) on HealthCheckLog keeps this cheap.
UPDATE "Server"
SET
  "lastHealthCheckStatus"     = (SELECT h."status"       FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckAt"         = (SELECT h."createdAt"    FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckType"       = (SELECT h."checkType"    FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckDurationMs" = (SELECT h."durationMs"   FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckError"      = (SELECT h."errorMessage" FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id" ORDER BY h."createdAt" DESC LIMIT 1)
WHERE EXISTS (
  SELECT 1 FROM "HealthCheckLog" h WHERE h."resourceType" = 'server' AND h."resourceId" = "Server"."id"
);

-- Backfill Service.lastHealthCheck* from most recent HealthCheckLog with resourceType = 'service'
-- ONLY. Container checks (resourceType = 'container') write to HealthCheckLog for audit but do
-- NOT update the Service cache — that would let a container_health failure clobber a passing URL
-- probe result. The dashboard reflects the URL/SSH health check, matching pre-PR behavior.
UPDATE "Service"
SET
  "lastHealthCheckStatus"     = (SELECT h."status"       FROM "HealthCheckLog" h WHERE h."resourceType" = 'service' AND h."resourceId" = "Service"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckAt"         = (SELECT h."createdAt"    FROM "HealthCheckLog" h WHERE h."resourceType" = 'service' AND h."resourceId" = "Service"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckType"       = (SELECT h."checkType"    FROM "HealthCheckLog" h WHERE h."resourceType" = 'service' AND h."resourceId" = "Service"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckDurationMs" = (SELECT h."durationMs"   FROM "HealthCheckLog" h WHERE h."resourceType" = 'service' AND h."resourceId" = "Service"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckError"      = (SELECT h."errorMessage" FROM "HealthCheckLog" h WHERE h."resourceType" = 'service' AND h."resourceId" = "Service"."id" ORDER BY h."createdAt" DESC LIMIT 1)
WHERE EXISTS (
  SELECT 1 FROM "HealthCheckLog" h WHERE h."resourceType" = 'service' AND h."resourceId" = "Service"."id"
);
