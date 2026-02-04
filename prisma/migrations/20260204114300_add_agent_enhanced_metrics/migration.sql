-- AlterTable
ALTER TABLE "ServerMetrics" ADD COLUMN "maxFds" INTEGER;
ALTER TABLE "ServerMetrics" ADD COLUMN "openFds" INTEGER;
ALTER TABLE "ServerMetrics" ADD COLUMN "swapTotalMb" REAL;
ALTER TABLE "ServerMetrics" ADD COLUMN "swapUsedMb" REAL;
ALTER TABLE "ServerMetrics" ADD COLUMN "tcpCloseWait" INTEGER;
ALTER TABLE "ServerMetrics" ADD COLUMN "tcpEstablished" INTEGER;
ALTER TABLE "ServerMetrics" ADD COLUMN "tcpListen" INTEGER;
ALTER TABLE "ServerMetrics" ADD COLUMN "tcpTimeWait" INTEGER;
ALTER TABLE "ServerMetrics" ADD COLUMN "tcpTotal" INTEGER;

-- CreateTable
CREATE TABLE "AgentContainerSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentContainerSnapshot_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentProcessSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentProcessSnapshot_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentContainerSnapshot_serverId_key" ON "AgentContainerSnapshot"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProcessSnapshot_serverId_key" ON "AgentProcessSnapshot"("serverId");
