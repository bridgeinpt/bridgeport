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
    CONSTRAINT "Database_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Database_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Database" ("backupCompression", "backupCompressionLevel", "backupFormat", "backupLocalPath", "backupSpacesBucket", "backupSpacesPrefix", "backupStorageType", "createdAt", "credentialsNonce", "databaseName", "encryptedCredentials", "environmentId", "filePath", "host", "id", "name", "pgDumpOptions", "port", "serverId", "type", "updatedAt") SELECT "backupCompression", "backupCompressionLevel", "backupFormat", "backupLocalPath", "backupSpacesBucket", "backupSpacesPrefix", "backupStorageType", "createdAt", "credentialsNonce", "databaseName", "encryptedCredentials", "environmentId", "filePath", "host", "id", "name", "pgDumpOptions", "port", "serverId", "type", "updatedAt" FROM "Database";
DROP TABLE "Database";
ALTER TABLE "new_Database" RENAME TO "Database";
CREATE UNIQUE INDEX "Database_environmentId_name_key" ON "Database"("environmentId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
