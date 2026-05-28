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

/**
 * Detect a Prisma unique-constraint violation (P2002) without depending on
 * `Prisma.PrismaClientKnownRequestError` (which would require importing the
 * runtime class — kept loose to play nicely with the better-sqlite3 adapter).
 */
function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'P2002') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('Unique constraint');
}

/** Stable shape passed to the sync helpers. */
export interface ConfigFileForUsage {
  id: string;
  environmentId: string;
  content: string;
  isBinary: boolean;
  /**
   * Optional ordered fragment includes. When present, the extractor scans both
   * the ConfigFile's own content AND each fragment's content for `${KEY}`
   * references — otherwise a fragment-only placeholder would be invisible to
   * the usage tracker (and to the auto-resync trigger that reads it).
   */
  includedFragments?: ReadonlyArray<{ fragment: { content: string } }>;
}

/**
 * Build the "scan blob" for usage extraction: the concatenation of every
 * included fragment's content (in caller-supplied order) plus the ConfigFile's
 * own content. We don't need the language-aware header injection from
 * `composeFragmentedContent` here — the regexes only care about the literal
 * `${KEY}` etc. tokens, and headers like `# === fragment: x ===` carry no
 * uppercase placeholders. A simple newline join keeps boundaries clean so a
 * `^KEY=` at the start of one section can't accidentally swallow the previous
 * section's trailing characters.
 */
function buildScanContent(configFile: ConfigFileForUsage): string {
  const fragmentContent = (configFile.includedFragments ?? [])
    .map((f) => f.fragment.content)
    .join('\n');
  if (!fragmentContent) return configFile.content;
  return `${fragmentContent}\n${configFile.content}`;
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
  const { id: configFileId, environmentId, isBinary } = configFile;
  // Scan fragment contents + own content so a `${KEY}` reference that lives
  // only inside an included fragment still produces a SecretUsage row.
  const referencedKeys = isBinary
    ? new Set<string>()
    : extractReferencedKeys(buildScanContent(configFile));

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
    // Race protection: two concurrent writes to the same configFile can both
    // pass the diff check and collide on the @@unique(env, key, file) index.
    // Prisma 7 + better-sqlite3 doesn't expose `skipDuplicates` on createMany,
    // so on P2002 we re-read existing rows and retry with the filtered set.
    try {
      await db.secretUsage.createMany({
        data: toCreate.map((secretKey) => ({ environmentId, secretKey, configFileId })),
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const afterRace = await db.secretUsage.findMany({
        where: { configFileId },
        select: { secretKey: true },
      });
      const nowExisting = new Set(afterRace.map((row) => row.secretKey));
      const retry = toCreate.filter((key) => !nowExisting.has(key));
      if (retry.length > 0) {
        await db.secretUsage.createMany({
          data: retry.map((secretKey) => ({ environmentId, secretKey, configFileId })),
        });
      }
    }
  }
}

/** Mirror of `syncSecretUsageForConfigFile` for the `VarUsage` table. */
export async function syncVarUsageForConfigFile(
  db: Db,
  configFile: ConfigFileForUsage
): Promise<void> {
  const { id: configFileId, environmentId, isBinary } = configFile;
  // See syncSecretUsageForConfigFile — same scan over fragment content +
  // own content so fragment-only references aren't invisible.
  const referencedKeys = isBinary
    ? new Set<string>()
    : extractReferencedKeys(buildScanContent(configFile));

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
    // See syncSecretUsageForConfigFile — mirror race protection for the
    // VarUsage @@unique(env, varKey, file) index.
    try {
      await db.varUsage.createMany({
        data: toCreate.map((varKey) => ({ environmentId, varKey, configFileId })),
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const afterRace = await db.varUsage.findMany({
        where: { configFileId },
        select: { varKey: true },
      });
      const nowExisting = new Set(afterRace.map((row) => row.varKey));
      const retry = toCreate.filter((key) => !nowExisting.has(key));
      if (retry.length > 0) {
        await db.varUsage.createMany({
          data: retry.map((varKey) => ({ environmentId, varKey, configFileId })),
        });
      }
    }
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
