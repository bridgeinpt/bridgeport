-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Environment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "sshPrivateKey" TEXT,
    "sshUser" TEXT NOT NULL DEFAULT 'root',
    "allowSecretReveal" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Environment" ("createdAt", "id", "name", "sshPrivateKey", "sshUser", "updatedAt") SELECT "createdAt", "id", "name", "sshPrivateKey", "sshUser", "updatedAt" FROM "Environment";
DROP TABLE "Environment";
ALTER TABLE "new_Environment" RENAME TO "Environment";
CREATE UNIQUE INDEX "Environment_name_key" ON "Environment"("name");
CREATE TABLE "new_Secret" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "description" TEXT,
    "neverReveal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "Secret_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Secret" ("createdAt", "description", "encryptedValue", "environmentId", "id", "key", "nonce", "updatedAt") SELECT "createdAt", "description", "encryptedValue", "environmentId", "id", "key", "nonce", "updatedAt" FROM "Secret";
DROP TABLE "Secret";
ALTER TABLE "new_Secret" RENAME TO "Secret";
CREATE UNIQUE INDEX "Secret_environmentId_key_key" ON "Secret"("environmentId", "key");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
