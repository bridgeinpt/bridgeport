-- CreateIndex
-- Discovery matches services against Docker containers by containerName, so it must
-- be unique per server. Historically containerName == name on every row (both set
-- by discovery), so adding the constraint over existing data is safe.
CREATE UNIQUE INDEX "Service_serverId_containerName_key" ON "Service"("serverId", "containerName");
