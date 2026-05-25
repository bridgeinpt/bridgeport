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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "environmentId" TEXT NOT NULL,
    CONSTRAINT "ConfigFile_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConfigFile" ("content", "createdAt", "description", "environmentId", "fileSize", "filename", "id", "isBinary", "mimeType", "name", "updatedAt") SELECT "content", "createdAt", "description", "environmentId", "fileSize", "filename", "id", "isBinary", "mimeType", "name", "updatedAt" FROM "ConfigFile";
DROP TABLE "ConfigFile";
ALTER TABLE "new_ConfigFile" RENAME TO "ConfigFile";
CREATE UNIQUE INDEX "ConfigFile_environmentId_name_key" ON "ConfigFile"("environmentId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
