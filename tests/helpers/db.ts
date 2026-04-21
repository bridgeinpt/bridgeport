/**
 * Test database helpers for BRIDGEPORT.
 *
 * Uses a file-based SQLite database (not in-memory, because Prisma's
 * `db push` needs a file URL). The database is created at the same path
 * as DATABASE_URL so that the singleton PrismaClient from src/lib/db.ts
 * (used by the authenticate plugin and other services) shares the same
 * database as the test PrismaClient.
 *
 * With vitest `isolate: false` + `pool: 'forks'`, all test files run in
 * one child process sequentially. We must NOT delete the DB file between
 * suites because the singleton PrismaClient keeps an open file descriptor.
 * Instead, we create the schema once and clean data between suites.
 *
 * Usage in tests:
 *   import { setupTestDb, teardownTestDb, getTestPrisma } from '../../test/helpers/db.js';
 *
 *   let prisma: ReturnType<typeof getTestPrisma>;
 *
 *   beforeAll(async () => {
 *     prisma = await setupTestDb();
 *   });
 *   afterAll(async () => {
 *     await teardownTestDb();
 *   });
 */
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { invalidateSettingsCache } from '../../src/services/system-settings.js';

let testPrisma: PrismaClient | null = null;
let testDbPath: string | null = null;
let schemaCreated = false;

/**
 * Resolve the SQLite file path from a DATABASE_URL like "file:./test.db".
 */
function resolveDbPath(dbUrl: string): string {
  const filePath = dbUrl.replace(/^file:/, '');
  return resolve(filePath);
}

/**
 * Creates or reuses the SQLite test database at the DATABASE_URL path,
 * cleans all data, and returns a connected PrismaClient instance.
 *
 * Uses the same path as process.env.DATABASE_URL so that the singleton
 * PrismaClient from src/lib/db.ts also connects to this database.
 */
export async function setupTestDb(): Promise<PrismaClient> {
  const dbUrl = process.env.DATABASE_URL || 'file:./test.db';
  testDbPath = resolveDbPath(dbUrl);

  if (!schemaCreated || !existsSync(testDbPath)) {
    // First call (or DB was removed): create schema from scratch
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const p = testDbPath + suffix;
      if (existsSync(p)) {
        rmSync(p, { force: true });
      }
    }

    execSync('npx prisma db push --skip-generate --accept-data-loss', {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'pipe',
      timeout: 30_000,
    });

    schemaCreated = true;
  }

  // Create or reuse PrismaClient connected to the test database
  if (!testPrisma) {
    testPrisma = new PrismaClient({
      datasources: {
        db: { url: dbUrl },
      },
      log: [], // Quiet in tests
    });
    await testPrisma.$connect();
  }

  // Always clean all data — with isolate: false, multiple test files'
  // beforeAll blocks may have already inserted data before this suite runs.
  await cleanAllTables(testPrisma);

  return testPrisma;
}

/**
 * Returns the current test PrismaClient. Throws if setupTestDb() hasn't been called.
 */
export function getTestPrisma(): PrismaClient {
  if (!testPrisma) {
    throw new Error('Test database not initialized. Call setupTestDb() first.');
  }
  return testPrisma;
}

/**
 * Cleans data between test suites. Does NOT delete the DB file
 * (the singleton PrismaClient has an open connection to it).
 */
export async function teardownTestDb(): Promise<void> {
  // Don't disconnect or delete — the singleton prisma needs the file alive.
  // Data cleanup happens at the start of the next setupTestDb() call.
}

/**
 * Deletes all data from the database while preserving the schema.
 */
async function cleanAllTables(prisma: PrismaClient): Promise<void> {
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT name FROM sqlite_master
    WHERE type='table'
    AND name NOT LIKE '_prisma%'
    AND name NOT LIKE 'sqlite_%'
  `;

  await prisma.$executeRaw`PRAGMA foreign_keys = OFF`;

  for (const { name } of tables) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${name}"`);
  }

  await prisma.$executeRaw`PRAGMA foreign_keys = ON`;

  // Invalidate in-memory caches that depend on DB data
  invalidateSettingsCache();
}

/**
 * Deletes all data from the database while preserving the schema.
 * Useful for cleaning between tests in the same suite.
 */
export async function cleanTestDb(): Promise<void> {
  await cleanAllTables(getTestPrisma());
}

export { testPrisma };
