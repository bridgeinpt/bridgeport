-- CreateTable
CREATE TABLE "NotificationSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "slackChannelId" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NotificationSettings_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NotificationSettings_slackChannelId_fkey" FOREIGN KEY ("slackChannelId") REFERENCES "SlackChannel" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ConfigFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "description" TEXT,
    "isBinary" BOOLEAN NOT NULL DEFAULT false,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "autoResync" BOOLEAN NOT NULL DEFAULT true,
    "language" TEXT NOT NULL DEFAULT 'plaintext',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "ConfigFile_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConfigFile" ("autoResync", "content", "createdAt", "description", "environmentId", "fileSize", "filename", "id", "isBinary", "mimeType", "name", "updatedAt") SELECT "autoResync", "content", "createdAt", "description", "environmentId", "fileSize", "filename", "id", "isBinary", "mimeType", "name", "updatedAt" FROM "ConfigFile";
DROP TABLE "ConfigFile";
ALTER TABLE "new_ConfigFile" RENAME TO "ConfigFile";
CREATE UNIQUE INDEX "ConfigFile_environmentId_name_key" ON "ConfigFile"("environmentId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "NotificationSettings_environmentId_key" ON "NotificationSettings"("environmentId");
