-- CreateTable
CREATE TABLE "SecretUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "secretKey" TEXT NOT NULL,
    "configFileId" TEXT NOT NULL,
    CONSTRAINT "SecretUsage_configFileId_fkey" FOREIGN KEY ("configFileId") REFERENCES "ConfigFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VarUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "varKey" TEXT NOT NULL,
    "configFileId" TEXT NOT NULL,
    CONSTRAINT "VarUsage_configFileId_fkey" FOREIGN KEY ("configFileId") REFERENCES "ConfigFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SecretUsage_environmentId_secretKey_idx" ON "SecretUsage"("environmentId", "secretKey");

-- CreateIndex
CREATE UNIQUE INDEX "SecretUsage_environmentId_secretKey_configFileId_key" ON "SecretUsage"("environmentId", "secretKey", "configFileId");

-- CreateIndex
CREATE INDEX "VarUsage_environmentId_varKey_idx" ON "VarUsage"("environmentId", "varKey");

-- CreateIndex
CREATE UNIQUE INDEX "VarUsage_environmentId_varKey_configFileId_key" ON "VarUsage"("environmentId", "varKey", "configFileId");

-- Backfill: populate usage rows from existing ConfigFile content. Mirrors the
-- four patterns the application recognises (${KEY}, $KEY, {{KEY}}, ^KEY=). Uses
-- INSERT OR IGNORE so the migration is idempotent and safe to re-run if the
-- entrypoint retries it. Ids are random 24-char hex (Prisma uses cuid going
-- forward; format doesn't matter — only uniqueness inside the table).
INSERT OR IGNORE INTO "SecretUsage" ("id", "environmentId", "secretKey", "configFileId")
SELECT lower(hex(randomblob(12))), cf."environmentId", s."key", cf."id"
FROM "ConfigFile" cf
JOIN "Secret" s ON s."environmentId" = cf."environmentId"
WHERE cf."isBinary" = 0 AND (
    cf."content" LIKE '%${' || s."key" || '}%' OR
    cf."content" LIKE '%$' || s."key" || '%' OR
    cf."content" LIKE '%{{' || s."key" || '}}%' OR
    cf."content" LIKE s."key" || '=%' OR
    cf."content" LIKE '%' || char(10) || s."key" || '=%'
);

INSERT OR IGNORE INTO "VarUsage" ("id", "environmentId", "varKey", "configFileId")
SELECT lower(hex(randomblob(12))), cf."environmentId", v."key", cf."id"
FROM "ConfigFile" cf
JOIN "Var" v ON v."environmentId" = cf."environmentId"
WHERE cf."isBinary" = 0 AND (
    cf."content" LIKE '%${' || v."key" || '}%' OR
    cf."content" LIKE '%$' || v."key" || '%' OR
    cf."content" LIKE '%{{' || v."key" || '}}%' OR
    cf."content" LIKE v."key" || '=%' OR
    cf."content" LIKE '%' || char(10) || v."key" || '=%'
);
