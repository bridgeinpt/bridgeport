-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Environment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "publicIp" TEXT,
    "tags" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "Server_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "imageName" TEXT NOT NULL,
    "imageTag" TEXT NOT NULL DEFAULT 'latest',
    "composePath" TEXT,
    "envTemplateName" TEXT,
    "composeTemplate" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "serverId" TEXT NOT NULL,
    CONSTRAINT "Service_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "imageTag" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "logs" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "serviceId" TEXT NOT NULL,
    "userId" TEXT,
    CONSTRAINT "Deployment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Deployment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Secret" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "Secret_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EnvTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ConfigFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "ConfigFile_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ServiceFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mountPath" TEXT NOT NULL,
    "description" TEXT,
    "serviceId" TEXT NOT NULL,
    "configFileId" TEXT NOT NULL,
    CONSTRAINT "ServiceFile_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServiceFile_configFileId_fkey" FOREIGN KEY ("configFileId") REFERENCES "ConfigFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeploymentArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deploymentId" TEXT NOT NULL,
    CONSTRAINT "DeploymentArtifact_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Environment_name_key" ON "Environment"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Server_environmentId_name_key" ON "Server"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Service_serverId_name_key" ON "Service"("serverId", "name");

-- CreateIndex
CREATE INDEX "Deployment_serviceId_startedAt_idx" ON "Deployment"("serviceId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Secret_environmentId_key_key" ON "Secret"("environmentId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "EnvTemplate_name_key" ON "EnvTemplate"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigFile_environmentId_name_key" ON "ConfigFile"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceFile_serviceId_configFileId_key" ON "ServiceFile"("serviceId", "configFileId");
