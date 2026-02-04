-- CreateTable
CREATE TABLE "SlackChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slackChannelName" TEXT,
    "webhookUrl" TEXT NOT NULL,
    "webhookUrlNonce" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastTestedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SlackTypeRouting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "typeId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "environmentIds" TEXT,
    CONSTRAINT "SlackTypeRouting_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "NotificationType" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SlackTypeRouting_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "SlackChannel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SlackTypeRouting_typeId_channelId_key" ON "SlackTypeRouting"("typeId", "channelId");
