import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding default service types...');

  // Django Service Type
  const django = await prisma.serviceType.upsert({
    where: { name: 'django' },
    update: {},
    create: {
      name: 'django',
      displayName: 'Django',
      commands: {
        create: [
          {
            name: 'shell',
            displayName: 'Django Shell',
            command: 'python manage.py shell',
            description: 'Open interactive Django shell',
            sortOrder: 0,
          },
          {
            name: 'dbshell',
            displayName: 'Database Shell',
            command: 'python manage.py dbshell',
            description: 'Open database shell',
            sortOrder: 1,
          },
          {
            name: 'migrate',
            displayName: 'Run Migrations',
            command: 'python manage.py migrate',
            description: 'Run database migrations',
            sortOrder: 2,
          },
          {
            name: 'makemigrations',
            displayName: 'Make Migrations',
            command: 'python manage.py makemigrations',
            description: 'Create new migration files',
            sortOrder: 3,
          },
          {
            name: 'collectstatic',
            displayName: 'Collect Static',
            command: 'python manage.py collectstatic --noinput',
            description: 'Collect static files',
            sortOrder: 4,
          },
          {
            name: 'createsuperuser',
            displayName: 'Create Superuser',
            command: 'python manage.py createsuperuser',
            description: 'Create admin user',
            sortOrder: 5,
          },
        ],
      },
    },
  });

  console.log(`  Created/updated Django service type (${django.id})`);

  // Node.js Service Type
  const nodejs = await prisma.serviceType.upsert({
    where: { name: 'nodejs' },
    update: {},
    create: {
      name: 'nodejs',
      displayName: 'Node.js',
      commands: {
        create: [
          {
            name: 'repl',
            displayName: 'Node REPL',
            command: 'node',
            description: 'Open Node.js REPL',
            sortOrder: 0,
          },
          {
            name: 'npm-install',
            displayName: 'NPM Install',
            command: 'npm install',
            description: 'Install dependencies',
            sortOrder: 1,
          },
          {
            name: 'npm-build',
            displayName: 'NPM Build',
            command: 'npm run build',
            description: 'Build project',
            sortOrder: 2,
          },
          {
            name: 'npm-test',
            displayName: 'NPM Test',
            command: 'npm test',
            description: 'Run tests',
            sortOrder: 3,
          },
        ],
      },
    },
  });

  console.log(`  Created/updated Node.js service type (${nodejs.id})`);

  // Generic Service Type (basic shell access)
  const generic = await prisma.serviceType.upsert({
    where: { name: 'generic' },
    update: {},
    create: {
      name: 'generic',
      displayName: 'Generic',
      commands: {
        create: [
          {
            name: 'sh',
            displayName: 'Shell',
            command: '/bin/sh',
            description: 'Open shell',
            sortOrder: 0,
          },
          {
            name: 'bash',
            displayName: 'Bash',
            command: '/bin/bash',
            description: 'Open bash shell',
            sortOrder: 1,
          },
        ],
      },
    },
  });

  console.log(`  Created/updated Generic service type (${generic.id})`);

  console.log('Seed completed successfully');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
