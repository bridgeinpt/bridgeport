import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Fall back to a placeholder file URL when DATABASE_URL is unset so that
// `prisma generate` (which doesn't talk to the DB) still works in CI and
// fresh checkouts. Migrations and runtime require the real URL.
const databaseUrl = process.env.DATABASE_URL ?? 'file:./bridgeport.db';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: databaseUrl,
  },
});
