-- CreateTable
CREATE TABLE "ExternalEntity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "iconKey" TEXT,
    "x" REAL NOT NULL,
    "y" REAL NOT NULL,
    "width" REAL,
    "height" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExternalEntity_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ExternalEntity_environmentId_idx" ON "ExternalEntity"("environmentId");
