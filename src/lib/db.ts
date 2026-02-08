import { PrismaClient, Prisma } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

/**
 * Check if an error is a Prisma "record not found" error.
 * This includes P2025 (record not found) and NotFoundError from findUniqueOrThrow.
 */
export function isPrismaNotFoundError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2025';
  }
  if (error instanceof Error && error.name === 'NotFoundError') {
    return true;
  }
  return false;
}

export async function initializeDatabase(): Promise<void> {
  try {
    await prisma.$connect();

    // Configure SQLite for concurrent access performance
    // WAL mode allows concurrent readers + single writer without blocking
    await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL');
    // Wait up to 5 seconds when database is locked instead of failing immediately
    await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000');
    // NORMAL is safe with WAL and avoids extra fsync on every commit
    await prisma.$executeRawUnsafe('PRAGMA synchronous = NORMAL');
    // Store temp tables in memory for faster operations
    await prisma.$executeRawUnsafe('PRAGMA temp_store = MEMORY');
    // Increase cache size to 64MB (negative = KiB)
    await prisma.$executeRawUnsafe('PRAGMA cache_size = -64000');
    console.log('Database connected (WAL mode, busy_timeout=5000ms)');

    // Initialize management environment with localhost server
    await initializeManagementEnvironment();
  } catch (error) {
    console.error('Failed to connect to database:', error);
    throw error;
  }
}

async function initializeManagementEnvironment(): Promise<void> {
  // Create or get the management environment
  let managementEnv = await prisma.environment.findUnique({
    where: { name: 'management' },
  });

  if (!managementEnv) {
    managementEnv = await prisma.environment.create({
      data: { name: 'management' },
    });
    console.log('Created management environment');
  }

  // Create or update localhost server
  const existingLocalhost = await prisma.server.findUnique({
    where: {
      environmentId_name: {
        environmentId: managementEnv.id,
        name: 'localhost',
      },
    },
  });

  if (!existingLocalhost) {
    await prisma.server.create({
      data: {
        name: 'localhost',
        hostname: '127.0.0.1',
        tags: JSON.stringify(['management', 'self']),
        environmentId: managementEnv.id,
      },
    });
    console.log('Created localhost server for self-monitoring');
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
