-- CreateTable
CREATE TABLE "ServerRegistryLogin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "registryConnectionId" TEXT NOT NULL,
    "loggedInAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServerRegistryLogin_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ServerRegistryLogin_registryConnectionId_fkey" FOREIGN KEY ("registryConnectionId") REFERENCES "RegistryConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ServerRegistryLogin_serverId_registryConnectionId_key" ON "ServerRegistryLogin"("serverId", "registryConnectionId");

-- CreateIndex
CREATE INDEX "ServerRegistryLogin_registryConnectionId_idx" ON "ServerRegistryLogin"("registryConnectionId");
