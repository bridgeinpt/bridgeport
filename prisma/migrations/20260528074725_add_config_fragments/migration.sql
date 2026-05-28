-- CreateTable
CREATE TABLE "ConfigFragment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConfigFragment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConfigFileFragment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configFileId" TEXT NOT NULL,
    "fragmentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "ConfigFileFragment_configFileId_fkey" FOREIGN KEY ("configFileId") REFERENCES "ConfigFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConfigFileFragment_fragmentId_fkey" FOREIGN KEY ("fragmentId") REFERENCES "ConfigFragment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ConfigFragment_environmentId_name_key" ON "ConfigFragment"("environmentId", "name");

-- CreateIndex
CREATE INDEX "ConfigFileFragment_configFileId_position_idx" ON "ConfigFileFragment"("configFileId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigFileFragment_configFileId_fragmentId_key" ON "ConfigFileFragment"("configFileId", "fragmentId");
