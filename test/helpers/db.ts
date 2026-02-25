/**
 * Test database helpers for BridgePort.
 *
 * Uses a file-based SQLite database per test run (not in-memory, because
 * Prisma's `db push` needs a file URL). The database is created fresh for
 * each test suite via `setupTestDb()` and torn down after.
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
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let testPrisma: PrismaClient | null = null;
let testDbDir: string | null = null;
let testDbPath: string | null = null;

/**
 * Creates a temporary SQLite database, applies the schema via `prisma db push`,
 * and returns a connected PrismaClient instance.
 */
export async function setupTestDb(): Promise<PrismaClient> {
  // Create a temp directory for the test database
  testDbDir = mkdtempSync(join(tmpdir(), 'bp-test-'));
  testDbPath = join(testDbDir, 'test.db');

  const dbUrl = `file:${testDbPath}`;

  // Apply schema without generating client (we already have it)
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    timeout: 30_000,
  });

  // Create a new PrismaClient connected to the test database
  testPrisma = new PrismaClient({
    datasources: {
      db: { url: dbUrl },
    },
    log: [], // Quiet in tests
  });

  await testPrisma.$connect();

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
 * Disconnects the PrismaClient and cleans up the temporary database files.
 */
export async function teardownTestDb(): Promise<void> {
  if (testPrisma) {
    await testPrisma.$disconnect();
    testPrisma = null;
  }

  if (testDbDir && existsSync(testDbDir)) {
    rmSync(testDbDir, { recursive: true, force: true });
    testDbDir = null;
    testDbPath = null;
  }
}

/**
 * Deletes all data from the database while preserving the schema.
 * Useful for cleaning between tests in the same suite.
 */
export async function cleanTestDb(): Promise<void> {
  const prisma = getTestPrisma();

  // Get all table names except Prisma internals
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT name FROM sqlite_master
    WHERE type='table'
    AND name NOT LIKE '_prisma%'
    AND name NOT LIKE 'sqlite_%'
  `;

  // Disable FK checks, delete all rows, then re-enable
  await prisma.$executeRaw`PRAGMA foreign_keys = OFF`;

  for (const { name } of tables) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${name}"`);
  }

  await prisma.$executeRaw`PRAGMA foreign_keys = ON`;
}

export { testPrisma };
