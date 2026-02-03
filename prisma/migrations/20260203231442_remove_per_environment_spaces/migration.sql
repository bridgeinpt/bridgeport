/*
  Warnings:

  - You are about to drop the column `encryptedSpacesSecret` on the `Environment` table. All the data in the column will be lost.
  - You are about to drop the column `spacesAccessKey` on the `Environment` table. All the data in the column will be lost.
  - You are about to drop the column `spacesEndpoint` on the `Environment` table. All the data in the column will be lost.
  - You are about to drop the column `spacesRegion` on the `Environment` table. All the data in the column will be lost.
  - You are about to drop the column `spacesSecretNonce` on the `Environment` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Environment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sshPrivateKey" TEXT,
    "sshUser" TEXT NOT NULL DEFAULT 'root',
    "allowSecretReveal" BOOLEAN NOT NULL DEFAULT true,
    "allowBackupDownload" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "schedulerConfig" TEXT
);
INSERT INTO "new_Environment" ("allowBackupDownload", "allowSecretReveal", "createdAt", "id", "name", "schedulerConfig", "sshPrivateKey", "sshUser", "updatedAt") SELECT "allowBackupDownload", "allowSecretReveal", "createdAt", "id", "name", "schedulerConfig", "sshPrivateKey", "sshUser", "updatedAt" FROM "Environment";
DROP TABLE "Environment";
ALTER TABLE "new_Environment" RENAME TO "Environment";
CREATE UNIQUE INDEX "Environment_name_key" ON "Environment"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
