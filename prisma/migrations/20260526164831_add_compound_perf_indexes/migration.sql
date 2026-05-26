-- CreateIndex
CREATE INDEX "AuditLog_environmentId_createdAt_idx" ON "AuditLog"("environmentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_createdAt_idx" ON "AuditLog"("resourceType", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Database_environmentId_monitoringEnabled_idx" ON "Database"("environmentId", "monitoringEnabled");

-- CreateIndex
CREATE INDEX "HealthCheckLog_resourceType_resourceId_createdAt_idx" ON "HealthCheckLog"("resourceType", "resourceId", "createdAt" DESC);
