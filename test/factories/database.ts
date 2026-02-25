/**
 * Database factory for tests.
 */
import { PrismaClient } from '@prisma/client';

let counter = 0;
function nextId() {
  return ++counter;
}

export interface CreateTestDatabaseOptions {
  name?: string;
  type?: string;
  environmentId: string;
  serverId?: string;
  host?: string;
  port?: number;
  databaseName?: string;
  monitoringEnabled?: boolean;
  collectionIntervalSec?: number;
}

export async function createTestDatabase(
  prisma: PrismaClient,
  options: CreateTestDatabaseOptions
) {
  const n = nextId();
  return prisma.database.create({
    data: {
      name: options.name ?? `test-db-${n}`,
      type: options.type ?? 'postgres',
      host: options.host ?? 'localhost',
      port: options.port ?? 5432,
      databaseName: options.databaseName ?? `testdb_${n}`,
      monitoringEnabled: options.monitoringEnabled ?? false,
      collectionIntervalSec: options.collectionIntervalSec ?? 300,
      environmentId: options.environmentId,
      serverId: options.serverId,
    },
  });
}

export function resetDatabaseCounter() {
  counter = 0;
}
