import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export async function initializeDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    console.log('Database connected');

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
