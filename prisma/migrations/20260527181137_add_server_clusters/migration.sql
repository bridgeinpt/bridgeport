-- CreateTable
CREATE TABLE "ServerCluster" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "collapsed" BOOLEAN NOT NULL DEFAULT false,
    "x" REAL NOT NULL,
    "y" REAL NOT NULL,
    "width" REAL,
    "height" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ServerCluster_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Server" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "publicIp" TEXT,
    "tags" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "serverType" TEXT NOT NULL DEFAULT 'remote',
    "dockerMode" TEXT NOT NULL DEFAULT 'ssh',
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastHealthCheckStatus" TEXT,
    "lastHealthCheckAt" DATETIME,
    "lastHealthCheckType" TEXT,
    "lastHealthCheckDurationMs" INTEGER,
    "lastHealthCheckError" TEXT,
    "metricsMode" TEXT NOT NULL DEFAULT 'disabled',
    "agentToken" TEXT,
    "agentStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastAgentPushAt" DATETIME,
    "agentVersion" TEXT,
    "agentStatusChangedAt" DATETIME,
    "environmentId" TEXT NOT NULL,
    "clusterId" TEXT,
    CONSTRAINT "Server_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Server_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "ServerCluster" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Server" ("agentStatus", "agentStatusChangedAt", "agentToken", "agentVersion", "createdAt", "dockerMode", "environmentId", "hostname", "id", "lastAgentPushAt", "lastCheckedAt", "lastHealthCheckAt", "lastHealthCheckDurationMs", "lastHealthCheckError", "lastHealthCheckStatus", "lastHealthCheckType", "metricsMode", "name", "publicIp", "serverType", "status", "tags", "updatedAt") SELECT "agentStatus", "agentStatusChangedAt", "agentToken", "agentVersion", "createdAt", "dockerMode", "environmentId", "hostname", "id", "lastAgentPushAt", "lastCheckedAt", "lastHealthCheckAt", "lastHealthCheckDurationMs", "lastHealthCheckError", "lastHealthCheckStatus", "lastHealthCheckType", "metricsMode", "name", "publicIp", "serverType", "status", "tags", "updatedAt" FROM "Server";
DROP TABLE "Server";
ALTER TABLE "new_Server" RENAME TO "Server";
CREATE INDEX "Server_clusterId_idx" ON "Server"("clusterId");
CREATE UNIQUE INDEX "Server_environmentId_name_key" ON "Server"("environmentId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ServerCluster_environmentId_idx" ON "ServerCluster"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ServerCluster_environmentId_name_key" ON "ServerCluster"("environmentId", "name");
