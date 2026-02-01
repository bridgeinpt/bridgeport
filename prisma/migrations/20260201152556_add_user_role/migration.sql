/*
  Warnings:

  - You are about to drop the column `checksum` on the `ConfigFile` table. All the data in the column will be lost.
  - You are about to drop the column `mimeType` on the `ConfigFile` table. All the data in the column will be lost.
  - You are about to drop the column `path` on the `ConfigFile` table. All the data in the column will be lost.
  - You are about to drop the column `size` on the `ConfigFile` table. All the data in the column will be lost.
  - You are about to drop the column `description` on the `ServiceFile` table. All the data in the column will be lost.
  - You are about to drop the column `mountPath` on the `ServiceFile` table. All the data in the column will be lost.
  - Added the required column `content` to the `ConfigFile` table without a default value. This is not possible if the table is not empty.
  - Added the required column `targetPath` to the `ServiceFile` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "RegistryConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "registryUrl" TEXT NOT NULL,
    "repositoryPrefix" TEXT,
    "encryptedToken" TEXT,
    "tokenNonce" TEXT,
    "username" TEXT,
    "encryptedPassword" TEXT,
    "passwordNonce" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "RegistryConnection_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ConfigFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "ConfigFile_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConfigFile" ("createdAt", "description", "environmentId", "filename", "id", "name", "updatedAt") SELECT "createdAt", "description", "environmentId", "filename", "id", "name", "updatedAt" FROM "ConfigFile";
DROP TABLE "ConfigFile";
ALTER TABLE "new_ConfigFile" RENAME TO "ConfigFile";
CREATE UNIQUE INDEX "ConfigFile_environmentId_name_key" ON "ConfigFile"("environmentId", "name");
CREATE TABLE "new_Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "imageName" TEXT NOT NULL,
    "imageTag" TEXT NOT NULL DEFAULT 'latest',
    "composePath" TEXT,
    "envTemplateName" TEXT,
    "composeTemplate" TEXT,
    "healthCheckUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "discoveryStatus" TEXT NOT NULL DEFAULT 'found',
    "lastCheckedAt" DATETIME,
    "lastDiscoveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "autoUpdate" BOOLEAN NOT NULL DEFAULT false,
    "latestAvailableTag" TEXT,
    "latestAvailableDigest" TEXT,
    "lastUpdateCheckAt" DATETIME,
    "serverId" TEXT NOT NULL,
    "registryConnectionId" TEXT,
    CONSTRAINT "Service_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Service_registryConnectionId_fkey" FOREIGN KEY ("registryConnectionId") REFERENCES "RegistryConnection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Service" ("composePath", "composeTemplate", "containerName", "createdAt", "envTemplateName", "healthCheckUrl", "id", "imageName", "imageTag", "lastCheckedAt", "name", "serverId", "status", "updatedAt") SELECT "composePath", "composeTemplate", "containerName", "createdAt", "envTemplateName", "healthCheckUrl", "id", "imageName", "imageTag", "lastCheckedAt", "name", "serverId", "status", "updatedAt" FROM "Service";
DROP TABLE "Service";
ALTER TABLE "new_Service" RENAME TO "Service";
CREATE UNIQUE INDEX "Service_serverId_name_key" ON "Service"("serverId", "name");
CREATE TABLE "new_ServiceFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetPath" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "configFileId" TEXT NOT NULL,
    CONSTRAINT "ServiceFile_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceFile_configFileId_fkey" FOREIGN KEY ("configFileId") REFERENCES "ConfigFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ServiceFile" ("configFileId", "id", "serviceId") SELECT "configFileId", "id", "serviceId" FROM "ServiceFile";
DROP TABLE "ServiceFile";
ALTER TABLE "new_ServiceFile" RENAME TO "ServiceFile";
CREATE UNIQUE INDEX "ServiceFile_serviceId_configFileId_key" ON "ServiceFile"("serviceId", "configFileId");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
-- Insert existing users with 'admin' role (existing users become admins)
INSERT INTO "new_User" ("createdAt", "email", "id", "name", "passwordHash", "updatedAt", "role") SELECT "createdAt", "email", "id", "name", "passwordHash", "updatedAt", 'admin' FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "RegistryConnection_environmentId_name_key" ON "RegistryConnection"("environmentId", "name");
