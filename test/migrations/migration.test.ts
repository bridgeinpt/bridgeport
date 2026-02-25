import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('database migrations', () => {
  it('should apply all migrations to a fresh database', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bp-migration-'));
    const dbPath = join(tmpDir, 'test.db');

    try {
      const result = execSync(
        `DATABASE_URL=file:${dbPath} npx prisma migrate deploy`,
        { encoding: 'utf8', timeout: 30_000 }
      );

      expect(result).toContain('All migrations have been successfully applied');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should produce schema matching prisma schema', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bp-migration-'));
    const dbPath = join(tmpDir, 'test.db');

    try {
      // Apply migrations
      execSync(`DATABASE_URL=file:${dbPath} npx prisma migrate deploy`, {
        encoding: 'utf8',
      });

      // Verify no drift
      const result = execSync(
        `DATABASE_URL=file:${dbPath} npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma`,
        { encoding: 'utf8' }
      );

      // No diff means migrations match schema — Prisma outputs "No difference detected." when clean
      expect(result.trim()).toMatch(/No difference detected|^$/);

    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should be idempotent — running deploy twice does not error', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bp-migration-'));
    const dbPath = join(tmpDir, 'test.db');

    try {
      execSync(`DATABASE_URL=file:${dbPath} npx prisma migrate deploy`, {
        encoding: 'utf8',
      });

      // Run again
      const result = execSync(
        `DATABASE_URL=file:${dbPath} npx prisma migrate deploy`,
        { encoding: 'utf8' }
      );

      expect(result).toMatch(/already been applied|No pending migrations to apply/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
