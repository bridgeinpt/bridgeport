-- CreateIndex
CREATE INDEX "ServiceConnection_environmentId_sourceType_sourceId_idx" ON "ServiceConnection"("environmentId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "ServiceConnection_environmentId_targetType_targetId_idx" ON "ServiceConnection"("environmentId", "targetType", "targetId");
