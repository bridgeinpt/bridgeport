-- AlterTable
ALTER TABLE "Server" ADD COLUMN "lastHealthCheckAt" DATETIME;
ALTER TABLE "Server" ADD COLUMN "lastHealthCheckDurationMs" INTEGER;
ALTER TABLE "Server" ADD COLUMN "lastHealthCheckError" TEXT;
ALTER TABLE "Server" ADD COLUMN "lastHealthCheckStatus" TEXT;
ALTER TABLE "Server" ADD COLUMN "lastHealthCheckType" TEXT;

-- AlterTable
ALTER TABLE "ServiceDeployment" ADD COLUMN "lastHealthCheckAt" DATETIME;
ALTER TABLE "ServiceDeployment" ADD COLUMN "lastHealthCheckDurationMs" INTEGER;
ALTER TABLE "ServiceDeployment" ADD COLUMN "lastHealthCheckError" TEXT;
ALTER TABLE "ServiceDeployment" ADD COLUMN "lastHealthCheckStatus" TEXT;
ALTER TABLE "ServiceDeployment" ADD COLUMN "lastHealthCheckType" TEXT;

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

-- Backfill ServiceDeployment.lastHealthCheck* from most recent HealthCheckLog with
-- resourceType = 'service_deployment' ONLY. Container checks (resourceType = 'container')
-- write to HealthCheckLog for audit but do NOT update the ServiceDeployment cache — that
-- would let a container_health failure clobber a passing URL probe result. The dashboard
-- reflects the URL/SSH health check, matching pre-PR behavior.
UPDATE "ServiceDeployment"
SET
  "lastHealthCheckStatus"     = (SELECT h."status"       FROM "HealthCheckLog" h WHERE h."resourceType" = 'service_deployment' AND h."resourceId" = "ServiceDeployment"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckAt"         = (SELECT h."createdAt"    FROM "HealthCheckLog" h WHERE h."resourceType" = 'service_deployment' AND h."resourceId" = "ServiceDeployment"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckType"       = (SELECT h."checkType"    FROM "HealthCheckLog" h WHERE h."resourceType" = 'service_deployment' AND h."resourceId" = "ServiceDeployment"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckDurationMs" = (SELECT h."durationMs"   FROM "HealthCheckLog" h WHERE h."resourceType" = 'service_deployment' AND h."resourceId" = "ServiceDeployment"."id" ORDER BY h."createdAt" DESC LIMIT 1),
  "lastHealthCheckError"      = (SELECT h."errorMessage" FROM "HealthCheckLog" h WHERE h."resourceType" = 'service_deployment' AND h."resourceId" = "ServiceDeployment"."id" ORDER BY h."createdAt" DESC LIMIT 1)
WHERE EXISTS (
  SELECT 1 FROM "HealthCheckLog" h WHERE h."resourceType" = 'service_deployment' AND h."resourceId" = "ServiceDeployment"."id"
);
