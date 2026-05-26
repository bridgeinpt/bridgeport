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
--
-- IMPORTANT: We use GLOB instead of LIKE because:
--   1. LIKE treats `_` as a single-char wildcard — so a key `DB_URL` would
--      match `${DBXURL}` (false positive). GLOB treats `_` literally.
--   2. LIKE is ASCII-case-insensitive by default in SQLite — key `PATH` would
--      match `$path`. GLOB is case-sensitive, matching the runtime extractor
--      which uses `[A-Z]` regex (src/lib/key-usage-extraction.ts).
--   3. For bare `$KEY` we need a non-word boundary after the key (otherwise
--      `KEY` matches `$KEYBOARD`). GLOB's `[!A-Z0-9_]` negative class gives
--      us that — with a separate end-of-content equality for `$KEY` at EOF.
--   4. GLOB has no anchoring (no `^`/`$`), so for `^KEY=` (env-file style) we
--      check (a) start-of-content via substr equality and (b) after-newline
--      via instr(content, '\nKEY=').
INSERT OR IGNORE INTO "SecretUsage" ("id", "environmentId", "secretKey", "configFileId")
SELECT lower(hex(randomblob(12))), cf."environmentId", s."key", cf."id"
FROM "ConfigFile" cf
JOIN "Secret" s ON s."environmentId" = cf."environmentId"
WHERE cf."isBinary" = 0 AND (
    cf."content" GLOB ('*${' || s."key" || '}*') OR
    cf."content" GLOB ('*$' || s."key" || '[!A-Z0-9_]*') OR
    substr(cf."content", length(cf."content") - length(s."key")) = ('$' || s."key") OR
    cf."content" GLOB ('*{{' || s."key" || '}}*') OR
    substr(cf."content", 1, length(s."key") + 1) = (s."key" || '=') OR
    instr(cf."content", char(10) || s."key" || '=') > 0
);

INSERT OR IGNORE INTO "VarUsage" ("id", "environmentId", "varKey", "configFileId")
SELECT lower(hex(randomblob(12))), cf."environmentId", v."key", cf."id"
FROM "ConfigFile" cf
JOIN "Var" v ON v."environmentId" = cf."environmentId"
WHERE cf."isBinary" = 0 AND (
    cf."content" GLOB ('*${' || v."key" || '}*') OR
    cf."content" GLOB ('*$' || v."key" || '[!A-Z0-9_]*') OR
    substr(cf."content", length(cf."content") - length(v."key")) = ('$' || v."key") OR
    cf."content" GLOB ('*{{' || v."key" || '}}*') OR
    substr(cf."content", 1, length(v."key") + 1) = (v."key" || '=') OR
    instr(cf."content", char(10) || v."key" || '=') > 0
);
