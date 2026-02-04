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
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "metricsMode" TEXT NOT NULL DEFAULT 'disabled',
    "agentToken" TEXT,
    "agentStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastAgentPushAt" DATETIME,
    "agentVersion" TEXT,
    "agentStatusChangedAt" DATETIME,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "Server_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Server" ("agentStatus", "agentStatusChangedAt", "agentToken", "agentVersion", "createdAt", "environmentId", "hostname", "id", "lastAgentPushAt", "lastCheckedAt", "metricsMode", "name", "publicIp", "status", "tags", "updatedAt") SELECT "agentStatus", "agentStatusChangedAt", "agentToken", "agentVersion", "createdAt", "environmentId", "hostname", "id", "lastAgentPushAt", "lastCheckedAt", "metricsMode", "name", "publicIp", "status", "tags", "updatedAt" FROM "Server";
DROP TABLE "Server";
ALTER TABLE "new_Server" RENAME TO "Server";
CREATE UNIQUE INDEX "Server_environmentId_name_key" ON "Server"("environmentId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
