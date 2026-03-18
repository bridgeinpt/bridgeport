-- CreateTable
CREATE TABLE "Var" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "environmentId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Var_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ConfigurationSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "allowSecretReveal" BOOLEAN NOT NULL DEFAULT true,
    "scanMinLength" INTEGER NOT NULL DEFAULT 6,
    "scanEntropyThreshold" INTEGER NOT NULL DEFAULT 25,
    CONSTRAINT "ConfigurationSettings_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConfigurationSettings" ("allowSecretReveal", "environmentId", "id") SELECT "allowSecretReveal", "environmentId", "id" FROM "ConfigurationSettings";
DROP TABLE "ConfigurationSettings";
ALTER TABLE "new_ConfigurationSettings" RENAME TO "ConfigurationSettings";
CREATE UNIQUE INDEX "ConfigurationSettings_environmentId_key" ON "ConfigurationSettings"("environmentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Var_environmentId_key_key" ON "Var"("environmentId", "key");
