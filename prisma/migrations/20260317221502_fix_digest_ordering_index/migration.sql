-- CreateIndex
CREATE INDEX "ImageDigest_containerImageId_pushedAt_idx" ON "ImageDigest"("containerImageId", "pushedAt" DESC);
