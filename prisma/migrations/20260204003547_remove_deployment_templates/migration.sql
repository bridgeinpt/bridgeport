/*
  Warnings:

  - You are about to drop the `DeploymentTemplate` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `templateId` on the `DeploymentPlan` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "DeploymentTemplate_environmentId_name_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "DeploymentTemplate";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    CONSTRAINT "DeploymentPlan_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlan_containerImageId_fkey" FOREIGN KEY ("containerImageId") REFERENCES "ContainerImage" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DeploymentPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DeploymentPlan" ("autoRollback", "completedAt", "containerImageId", "createdAt", "environmentId", "error", "id", "imageTag", "logs", "name", "parallelExecution", "startedAt", "status", "triggerType", "triggeredBy", "userId") SELECT "autoRollback", "completedAt", "containerImageId", "createdAt", "environmentId", "error", "id", "imageTag", "logs", "name", "parallelExecution", "startedAt", "status", "triggerType", "triggeredBy", "userId" FROM "DeploymentPlan";
DROP TABLE "DeploymentPlan";
ALTER TABLE "new_DeploymentPlan" RENAME TO "DeploymentPlan";
CREATE INDEX "DeploymentPlan_environmentId_createdAt_idx" ON "DeploymentPlan"("environmentId", "createdAt" DESC);
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
