---
allowed-tools: Bash, Read
description: Test Prisma migrations safely against a copy of data
---

# Test Migration

Safely test Prisma migrations against a copy of your database before applying to production.

## Steps

1. Copy the database to a test location
2. Run migrations against the copy
3. Verify the migration succeeded
4. Report any issues

## Usage

For testing against production data:

```bash
# Copy production database
cp /path/to/production.db /tmp/test-migration.db

# Run migrations against the copy
DATABASE_URL="file:/tmp/test-migration.db" npx prisma migrate deploy

# Verify schema is correct
DATABASE_URL="file:/tmp/test-migration.db" npx prisma db pull --print
```

For testing a new migration in development:

```bash
# Create test database
DATABASE_URL="file:/tmp/test-bridgeport.db" npx prisma migrate dev --name test_migration

# Review the generated SQL
cat prisma/migrations/*/migration.sql
```

## Pre-deployment checklist

- [ ] Migration SQL reviewed for data safety
- [ ] Tested with existing data (not just empty database)
- [ ] No `prisma db push` commands in the change
- [ ] Migration files committed to git

## Important

Never use `prisma db push` in production - it bypasses migrations and can cause data loss.
