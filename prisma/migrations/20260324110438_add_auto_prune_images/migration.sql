-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OperationsSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "defaultDockerMode" TEXT NOT NULL DEFAULT 'ssh',
    "defaultMetricsMode" TEXT NOT NULL DEFAULT 'disabled',
    "autoPruneImages" BOOLEAN NOT NULL DEFAULT false,
    "pruneImagesMode" TEXT NOT NULL DEFAULT 'dangling',
    CONSTRAINT "OperationsSettings_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_OperationsSettings" ("defaultDockerMode", "defaultMetricsMode", "environmentId", "id") SELECT "defaultDockerMode", "defaultMetricsMode", "environmentId", "id" FROM "OperationsSettings";
DROP TABLE "OperationsSettings";
ALTER TABLE "new_OperationsSettings" RENAME TO "OperationsSettings";
CREATE UNIQUE INDEX "OperationsSettings_environmentId_key" ON "OperationsSettings"("environmentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
