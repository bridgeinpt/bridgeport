-- CreateTable
CREATE TABLE "DatabaseType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isCustomized" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'plugin',
    "connectionFields" TEXT NOT NULL,
    "backupCommand" TEXT,
    "restoreCommand" TEXT,
    "defaultPort" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DatabaseTypeCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "databaseTypeId" TEXT NOT NULL,
    CONSTRAINT "DatabaseTypeCommand_databaseTypeId_fkey" FOREIGN KEY ("databaseTypeId") REFERENCES "DatabaseType" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Database" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "databaseName" TEXT,
    "encryptedCredentials" TEXT,
    "credentialsNonce" TEXT,
    "filePath" TEXT,
    "backupStorageType" TEXT NOT NULL DEFAULT 'local',
    "backupLocalPath" TEXT,
    "backupSpacesBucket" TEXT,
    "backupSpacesPrefix" TEXT,
    "backupFormat" TEXT NOT NULL DEFAULT 'plain',
    "backupCompression" TEXT NOT NULL DEFAULT 'none',
    "backupCompressionLevel" INTEGER NOT NULL DEFAULT 6,
    "pgDumpOptions" TEXT,
    "pgDumpTimeoutMs" INTEGER NOT NULL DEFAULT 300000,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    "serverId" TEXT,
    "databaseTypeId" TEXT,
    CONSTRAINT "Database_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Database_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Database_databaseTypeId_fkey" FOREIGN KEY ("databaseTypeId") REFERENCES "DatabaseType" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Database" ("backupCompression", "backupCompressionLevel", "backupFormat", "backupLocalPath", "backupSpacesBucket", "backupSpacesPrefix", "backupStorageType", "createdAt", "credentialsNonce", "databaseName", "encryptedCredentials", "environmentId", "filePath", "host", "id", "name", "pgDumpOptions", "pgDumpTimeoutMs", "port", "serverId", "type", "updatedAt") SELECT "backupCompression", "backupCompressionLevel", "backupFormat", "backupLocalPath", "backupSpacesBucket", "backupSpacesPrefix", "backupStorageType", "createdAt", "credentialsNonce", "databaseName", "encryptedCredentials", "environmentId", "filePath", "host", "id", "name", "pgDumpOptions", "pgDumpTimeoutMs", "port", "serverId", "type", "updatedAt" FROM "Database";
DROP TABLE "Database";
ALTER TABLE "new_Database" RENAME TO "Database";
CREATE UNIQUE INDEX "Database_environmentId_name_key" ON "Database"("environmentId", "name");
CREATE TABLE "new_ServiceType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isCustomized" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'plugin',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ServiceType" ("createdAt", "displayName", "id", "name", "updatedAt") SELECT "createdAt", "displayName", "id", "name", "updatedAt" FROM "ServiceType";
DROP TABLE "ServiceType";
ALTER TABLE "new_ServiceType" RENAME TO "ServiceType";
CREATE UNIQUE INDEX "ServiceType_name_key" ON "ServiceType"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "DatabaseType_name_key" ON "DatabaseType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "DatabaseTypeCommand_databaseTypeId_name_key" ON "DatabaseTypeCommand"("databaseTypeId", "name");
