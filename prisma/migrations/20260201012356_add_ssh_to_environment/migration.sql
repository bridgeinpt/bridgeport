-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Environment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sshPrivateKey" TEXT,
    "sshUser" TEXT NOT NULL DEFAULT 'root',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Environment" ("createdAt", "id", "name", "updatedAt") SELECT "createdAt", "id", "name", "updatedAt" FROM "Environment";
DROP TABLE "Environment";
ALTER TABLE "new_Environment" RENAME TO "Environment";
CREATE UNIQUE INDEX "Environment_name_key" ON "Environment"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
