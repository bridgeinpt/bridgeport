#!/bin/sh
set -e

echo "=== BRIDGEPORT Startup ==="

# Get database path from DATABASE_URL
DB_PATH="${DATABASE_URL#file:}"
echo "Database path: $DB_PATH"

# Ensure data directory exists
mkdir -p "$(dirname "$DB_PATH")" 2>/dev/null || true

if [ -f "$DB_PATH" ]; then
    echo "Database exists"

    # Check if _prisma_migrations table exists
    if sqlite3 "$DB_PATH" "SELECT 1 FROM _prisma_migrations LIMIT 1" 2>/dev/null; then
        echo "Migration history found"
    else
        echo "Legacy database detected (no migration history)"
        echo "Creating migration baseline..."

        # Create the _prisma_migrations table
        sqlite3 "$DB_PATH" "
            CREATE TABLE IF NOT EXISTS _prisma_migrations (
                id                  TEXT PRIMARY KEY NOT NULL,
                checksum            TEXT NOT NULL,
                finished_at         DATETIME,
                migration_name      TEXT NOT NULL,
                logs                TEXT,
                rolled_back_at      DATETIME,
                started_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                applied_steps_count INTEGER NOT NULL DEFAULT 0
            );
        "

        # Mark the init migration as already applied
        # This prevents Prisma from trying to recreate all tables
        sqlite3 "$DB_PATH" "
            INSERT OR IGNORE INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
            VALUES (
                '$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo $(date +%s))',
                '$(sha256sum /app/prisma/migrations/*/migration.sql 2>/dev/null | head -1 | cut -d' ' -f1 || echo 'legacy')',
                datetime('now'),
                '20260203215738_init',
                1
            );
        "
        echo "Baseline created"
    fi
else
    echo "No database found, will create fresh"
fi

# Run any pending migrations
echo "Applying migrations..."
npx prisma migrate deploy

echo "=== Starting BRIDGEPORT ==="
exec node dist/server.js
