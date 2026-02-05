-- CreateTable
CREATE TABLE "DataStore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "databaseId" TEXT,
    "host" TEXT,
    "port" INTEGER,
    "encryptedCredentials" TEXT,
    "credentialsNonce" TEXT,
    "databaseName" TEXT,
    "redisDb" INTEGER,
    "serverId" TEXT,
    "filePath" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "collectionIntervalSec" INTEGER NOT NULL DEFAULT 60,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "lastCollectedAt" DATETIME,
    "lastError" TEXT,
    "isCluster" BOOLEAN NOT NULL DEFAULT false,
    "clusterNodes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DataStore_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DataStore_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "Database" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DataStore_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DataStoreMetrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dataStoreId" TEXT NOT NULL,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metricsJson" TEXT NOT NULL,
    CONSTRAINT "DataStoreMetrics_dataStoreId_fkey" FOREIGN KEY ("dataStoreId") REFERENCES "DataStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DataStore_databaseId_key" ON "DataStore"("databaseId");

-- CreateIndex
CREATE INDEX "DataStore_environmentId_idx" ON "DataStore"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "DataStore_environmentId_name_key" ON "DataStore"("environmentId", "name");

-- CreateIndex
CREATE INDEX "DataStoreMetrics_dataStoreId_collectedAt_idx" ON "DataStoreMetrics"("dataStoreId", "collectedAt" DESC);
