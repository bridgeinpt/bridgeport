-- CreateTable
CREATE TABLE "ServiceAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdByUserId" TEXT,
    CONSTRAINT "ServiceAccount_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiTokenEnvironment" (
    "apiTokenId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,

    PRIMARY KEY ("apiTokenId", "environmentId"),
    CONSTRAINT "ApiTokenEnvironment_apiTokenId_fkey" FOREIGN KEY ("apiTokenId") REFERENCES "ApiToken" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApiTokenEnvironment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccount_name_key" ON "ServiceAccount"("name");

-- CreateIndex
CREATE INDEX "ApiTokenEnvironment_environmentId_idx" ON "ApiTokenEnvironment"("environmentId");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- ApiToken: add tokenPrefix/role/allEnvironments/serviceAccountId, make userId nullable
CREATE TABLE "new_ApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "allEnvironments" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "serviceAccountId" TEXT,
    CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ApiToken_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "ServiceAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Backfill role from each token's owner so existing tokens preserve their effective permissions
INSERT INTO "new_ApiToken" ("id", "name", "tokenHash", "tokenPrefix", "role", "allEnvironments", "lastUsedAt", "expiresAt", "createdAt", "userId", "serviceAccountId")
SELECT
    t."id",
    t."name",
    t."tokenHash",
    NULL,
    COALESCE(u."role", 'viewer'),
    true,
    t."lastUsedAt",
    t."expiresAt",
    t."createdAt",
    t."userId",
    NULL
FROM "ApiToken" t
LEFT JOIN "User" u ON u."id" = t."userId";
DROP TABLE "ApiToken";
ALTER TABLE "new_ApiToken" RENAME TO "ApiToken";
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- AuditLog: add apiTokenId and serviceAccountId
CREATE TABLE "new_AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "resourceName" TEXT,
    "details" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "environmentId" TEXT,
    "apiTokenId" TEXT,
    "serviceAccountId" TEXT,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_apiTokenId_fkey" FOREIGN KEY ("apiTokenId") REFERENCES "ApiToken" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "ServiceAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AuditLog" ("id", "action", "resourceType", "resourceId", "resourceName", "details", "success", "error", "createdAt", "userId", "environmentId")
SELECT "id", "action", "resourceType", "resourceId", "resourceName", "details", "success", "error", "createdAt", "userId", "environmentId" FROM "AuditLog";
DROP TABLE "AuditLog";
ALTER TABLE "new_AuditLog" RENAME TO "AuditLog";
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt" DESC);
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");
CREATE INDEX "AuditLog_environmentId_idx" ON "AuditLog"("environmentId");
CREATE INDEX "AuditLog_apiTokenId_idx" ON "AuditLog"("apiTokenId");
CREATE INDEX "AuditLog_serviceAccountId_idx" ON "AuditLog"("serviceAccountId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
