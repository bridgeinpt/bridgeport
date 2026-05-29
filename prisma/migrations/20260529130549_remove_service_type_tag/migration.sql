/*
  Warnings:

  - You are about to drop the column `typeTag` on the `Service` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
INSERT INTO "new_Service" ("baseEnv", "certChecks", "composeTemplate", "containerImageId", "createdAt", "deployStrategy", "environmentId", "healthCheckUrl", "healthIntervalMs", "healthRetries", "healthWaitMs", "id", "imageTag", "name", "serviceTypeId", "tcpChecks", "updatedAt") SELECT "baseEnv", "certChecks", "composeTemplate", "containerImageId", "createdAt", "deployStrategy", "environmentId", "healthCheckUrl", "healthIntervalMs", "healthRetries", "healthWaitMs", "id", "imageTag", "name", "serviceTypeId", "tcpChecks", "updatedAt" FROM "Service";
DROP TABLE "Service";
ALTER TABLE "new_Service" RENAME TO "Service";
CREATE UNIQUE INDEX "Service_environmentId_name_key" ON "Service"("environmentId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
