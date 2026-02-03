import { prisma } from '../lib/db.js';

const DEFAULT_SERVICE_TYPES = [
  {
    name: 'django',
    displayName: 'Django',
    commands: [
      { name: 'shell', displayName: 'Django Shell', command: 'python manage.py shell', description: 'Interactive Django shell', sortOrder: 0 },
      { name: 'dbshell', displayName: 'Database Shell', command: 'python manage.py dbshell', description: 'Database CLI shell', sortOrder: 1 },
      { name: 'migrate', displayName: 'Run Migrations', command: 'python manage.py migrate', description: 'Apply database migrations', sortOrder: 2 },
      { name: 'makemigrations', displayName: 'Make Migrations', command: 'python manage.py makemigrations', description: 'Create new migrations', sortOrder: 3 },
      { name: 'collectstatic', displayName: 'Collect Static', command: 'python manage.py collectstatic --noinput', description: 'Collect static files', sortOrder: 4 },
      { name: 'createsuperuser', displayName: 'Create Superuser', command: 'python manage.py createsuperuser', description: 'Create admin user', sortOrder: 5 },
    ],
  },
  {
    name: 'nodejs',
    displayName: 'Node.js',
    commands: [
      { name: 'repl', displayName: 'Node REPL', command: 'node', description: 'Interactive Node.js REPL', sortOrder: 0 },
      { name: 'npm-install', displayName: 'Install Dependencies', command: 'npm install', description: 'Install npm packages', sortOrder: 1 },
      { name: 'npm-build', displayName: 'Build', command: 'npm run build', description: 'Build the project', sortOrder: 2 },
      { name: 'npm-test', displayName: 'Run Tests', command: 'npm test', description: 'Run test suite', sortOrder: 3 },
    ],
  },
  {
    name: 'generic',
    displayName: 'Generic',
    commands: [
      { name: 'sh', displayName: 'Shell', command: '/bin/sh', description: 'Basic shell', sortOrder: 0 },
      { name: 'bash', displayName: 'Bash', command: '/bin/bash', description: 'Bash shell (if available)', sortOrder: 1 },
    ],
  },
];

/**
 * Initialize default service types if they don't exist.
 * Called on server startup to ensure defaults are always available.
 */
export async function initializeServiceTypes(): Promise<void> {
  const existingCount = await prisma.serviceType.count();

  if (existingCount > 0) {
    // Service types already exist, skip initialization
    return;
  }

  console.log('Initializing default service types...');

  for (const type of DEFAULT_SERVICE_TYPES) {
    await prisma.serviceType.create({
      data: {
        name: type.name,
        displayName: type.displayName,
        commands: {
          create: type.commands,
        },
      },
    });
  }

  console.log(`Created ${DEFAULT_SERVICE_TYPES.length} default service types`);
}
