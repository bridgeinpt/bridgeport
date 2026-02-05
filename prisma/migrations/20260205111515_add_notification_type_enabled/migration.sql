-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_NotificationType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "template" TEXT NOT NULL,
    "defaultChannels" TEXT NOT NULL DEFAULT '["in_app"]',
    "severity" TEXT NOT NULL DEFAULT 'info',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "bounceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "bounceThreshold" INTEGER NOT NULL DEFAULT 3,
    "bounceCooldown" INTEGER NOT NULL DEFAULT 900,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_NotificationType" ("bounceCooldown", "bounceEnabled", "bounceThreshold", "category", "code", "createdAt", "defaultChannels", "description", "id", "name", "severity", "template") SELECT "bounceCooldown", "bounceEnabled", "bounceThreshold", "category", "code", "createdAt", "defaultChannels", "description", "id", "name", "severity", "template" FROM "NotificationType";
DROP TABLE "NotificationType";
ALTER TABLE "new_NotificationType" RENAME TO "NotificationType";
CREATE UNIQUE INDEX "NotificationType_code_key" ON "NotificationType"("code");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
