/**
 * Key usage extraction.
 *
 * Replaces the per-key, per-file regex scan used by the secrets/vars list
 * endpoints with an explicit join table (`SecretUsage` / `VarUsage`) that is
 * maintained on every ConfigFile content write. This file owns:
 *
 *   1. The extractor that finds referenced UPPER_SNAKE_CASE keys in a config
 *      file's content (`${KEY}`, `$KEY`, `{{KEY}}`, and `^KEY=` lines).
 *   2. The diff-and-write helpers that sync the join-table rows for a single
 *      config file. Callers pass either `prisma` or a transaction client.
 *
 * Binary files contribute no usage; helpers clear any pre-existing rows when
 * `isBinary` is true.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

/** Prisma client or transactional client — both expose `secretUsage`/`varUsage`. */
type Db = PrismaClient | Prisma.TransactionClient;

/** Stable shape passed to the sync helpers. */
export interface ConfigFileForUsage {
  id: string;
  environmentId: string;
  content: string;
  isBinary: boolean;
}

/** Same key validation we apply on Secret/Var create (see `createSecretSchema`). */
const KEY_VALIDATION_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Extract every UPPER_SNAKE_CASE key referenced from `content` via the four
 * patterns recognised by the secrets/vars usage tracker:
 *   - `${KEY}`
 *   - `$KEY` (must be followed by a non-word boundary)
 *   - `{{KEY}}`
 *   - `^KEY=` (multiline — env-file style)
 *
 * Keys that don't match `^[A-Z][A-Z0-9_]*$` are discarded so junk like
 * `${1}` or `$path` never reaches the join table.
 */
export function extractReferencedKeys(content: string): Set<string> {
  const keys = new Set<string>();
  if (!content) return keys;

  // ${KEY}
  for (const match of content.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) {
    keys.add(match[1]!);
  }

  // $KEY (bare). Forbid trailing word chars so `$FOOBAR` doesn't match `FOO`.
  for (const match of content.matchAll(/\$([A-Z][A-Z0-9_]*)(?![A-Z0-9_])/g)) {
    keys.add(match[1]!);
  }

  // {{KEY}}
  for (const match of content.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)) {
    keys.add(match[1]!);
  }

  // ^KEY= (multiline)
  for (const match of content.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
    keys.add(match[1]!);
  }

  // Defence in depth — drop anything that slips through (none of the regexes
  // above should produce a non-conforming key, but the join table requires it).
  for (const key of keys) {
    if (!KEY_VALIDATION_RE.test(key)) {
      keys.delete(key);
    }
  }

  return keys;
}

/**
 * Sync `SecretUsage` rows for a single config file.
 *
 * Diffs existing rows against the keys extracted from `content` and writes
 * the minimal create/delete set. Binary files clear existing rows and skip
 * extraction (asset uploads never reference secrets).
 */
export async function syncSecretUsageForConfigFile(
  db: Db,
  configFile: ConfigFileForUsage
): Promise<void> {
  const { id: configFileId, environmentId, content, isBinary } = configFile;
  const referencedKeys = isBinary ? new Set<string>() : extractReferencedKeys(content);

  const existing = await db.secretUsage.findMany({
    where: { configFileId },
    select: { secretKey: true },
  });
  const existingKeys = new Set(existing.map((row) => row.secretKey));

  const toCreate: string[] = [];
  for (const key of referencedKeys) {
    if (!existingKeys.has(key)) toCreate.push(key);
  }

  const toDelete: string[] = [];
  for (const key of existingKeys) {
    if (!referencedKeys.has(key)) toDelete.push(key);
  }

  if (toDelete.length > 0) {
    await db.secretUsage.deleteMany({
      where: { configFileId, secretKey: { in: toDelete } },
    });
  }

  if (toCreate.length > 0) {
    await db.secretUsage.createMany({
      data: toCreate.map((secretKey) => ({ environmentId, secretKey, configFileId })),
    });
  }
}

/** Mirror of `syncSecretUsageForConfigFile` for the `VarUsage` table. */
export async function syncVarUsageForConfigFile(
  db: Db,
  configFile: ConfigFileForUsage
): Promise<void> {
  const { id: configFileId, environmentId, content, isBinary } = configFile;
  const referencedKeys = isBinary ? new Set<string>() : extractReferencedKeys(content);

  const existing = await db.varUsage.findMany({
    where: { configFileId },
    select: { varKey: true },
  });
  const existingKeys = new Set(existing.map((row) => row.varKey));

  const toCreate: string[] = [];
  for (const key of referencedKeys) {
    if (!existingKeys.has(key)) toCreate.push(key);
  }

  const toDelete: string[] = [];
  for (const key of existingKeys) {
    if (!referencedKeys.has(key)) toDelete.push(key);
  }

  if (toDelete.length > 0) {
    await db.varUsage.deleteMany({
      where: { configFileId, varKey: { in: toDelete } },
    });
  }

  if (toCreate.length > 0) {
    await db.varUsage.createMany({
      data: toCreate.map((varKey) => ({ environmentId, varKey, configFileId })),
    });
  }
}

/**
 * Sync both `SecretUsage` and `VarUsage` rows for a config file. Callers use
 * this from every code path that mutates `ConfigFile.content` (create,
 * update, restore from history, scan-apply, asset upload).
 */
export async function syncUsageForConfigFile(
  db: Db,
  configFile: ConfigFileForUsage
): Promise<void> {
  await syncSecretUsageForConfigFile(db, configFile);
  await syncVarUsageForConfigFile(db, configFile);
}
