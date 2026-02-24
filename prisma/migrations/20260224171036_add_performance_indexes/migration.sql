-- CreateIndex
CREATE INDEX "Notification_environmentId_idx" ON "Notification"("environmentId");

-- CreateIndex
CREATE INDEX "ServiceDependency_dependentId_idx" ON "ServiceDependency"("dependentId");

-- CreateIndex
CREATE INDEX "ServiceDependency_dependsOnId_idx" ON "ServiceDependency"("dependsOnId");
