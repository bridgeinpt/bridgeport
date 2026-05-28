-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "batchId" TEXT;

-- CreateTable
CREATE TABLE "SyncBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "rollbackOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "idempotencyKey" TEXT,
    "idempotencyBodyHash" TEXT,
    "userId" TEXT,
    "apiTokenId" TEXT,
    "serviceAccountId" TEXT,
    "environmentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SyncBatchOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "configFileId" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "previousContent" TEXT,
    "previousIsBinary" BOOLEAN NOT NULL DEFAULT false,
    "results" TEXT,
    "rollbackError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "SyncBatchOperation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SyncBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SyncBatch_createdAt_idx" ON "SyncBatch"("createdAt");

-- CreateIndex
CREATE INDEX "SyncBatch_environmentId_idx" ON "SyncBatch"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncBatch_idempotencyKey_idempotencyBodyHash_key" ON "SyncBatch"("idempotencyKey", "idempotencyBodyHash");

-- CreateIndex
CREATE INDEX "SyncBatchOperation_batchId_index_idx" ON "SyncBatchOperation"("batchId", "index");

-- CreateIndex
CREATE INDEX "SyncBatchOperation_configFileId_idx" ON "SyncBatchOperation"("configFileId");

-- CreateIndex
CREATE INDEX "AuditLog_batchId_idx" ON "AuditLog"("batchId");
