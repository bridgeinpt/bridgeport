-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "deployedDigestId" TEXT,
    CONSTRAINT "ContainerImage_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContainerImage_registryConnectionId_fkey" FOREIGN KEY ("registryConnectionId") REFERENCES "RegistryConnection" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ContainerImage_deployedDigestId_fkey" FOREIGN KEY ("deployedDigestId") REFERENCES "ImageDigest" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ContainerImage" ("autoUpdate", "createdAt", "environmentId", "id", "imageName", "lastCheckedAt", "name", "registryConnectionId", "tagFilter", "updateAvailable", "updatedAt") SELECT "autoUpdate", "createdAt", "environmentId", "id", "imageName", "lastCheckedAt", "name", "registryConnectionId", "tagFilter", "updateAvailable", "updatedAt" FROM "ContainerImage";
DROP TABLE "ContainerImage";
ALTER TABLE "new_ContainerImage" RENAME TO "ContainerImage";
CREATE UNIQUE INDEX "ContainerImage_environmentId_imageName_key" ON "ContainerImage"("environmentId", "imageName");
-- Backfill deployedDigestId from existing service data
UPDATE "ContainerImage" SET "deployedDigestId" = (
  SELECT "imageDigestId" FROM "Service"
  WHERE "Service"."containerImageId" = "ContainerImage"."id"
    AND "Service"."imageDigestId" IS NOT NULL
  LIMIT 1
);
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
