# BridgePort

A lightweight, self-hosted deployment management tool for Docker-based infrastructure.

---

## ⛔ CRITICAL: DATABASE SCHEMA CHANGES ⛔

**BridgePort is a product used by multiple deployments. Schema changes MUST be automatic and safe.**

### THE GOLDEN RULE

**Container updates must ALWAYS work automatically. Zero human intervention.**

When someone pulls a new image and restarts the container, it MUST:
1. Detect pending migrations
2. Apply them safely
3. Start the application

If this fails, the deployment is broken. This is unacceptable.

### HOW IT WORKS

1. **Entrypoint script** (`docker/entrypoint.sh`) runs on every container start
2. **Prisma Migrate** applies pending migrations automatically via `prisma migrate deploy`
3. **Migrations are SQL files** in `prisma/migrations/` - they handle data transformations

### DEVELOPMENT WORKFLOW

When making schema changes:

```bash
# 1. Edit prisma/schema.prisma

# 2. Create a migration (this generates SQL and applies it to dev DB)
npx prisma migrate dev --name descriptive_name

# 3. Review the generated SQL in prisma/migrations/YYYYMMDD_descriptive_name/
#    - Prisma auto-generates safe migrations
#    - For complex changes, edit the SQL to add data transformations

# 4. Test the migration
npm run dev  # Verify app works

# 5. Commit the migration files with your code changes
git add prisma/migrations/ prisma/schema.prisma
git commit -m "Add feature X with migration"
```

### HANDLING BREAKING CHANGES

Prisma Migrate handles most cases automatically, but some require manual SQL:

**Adding required columns:**
```sql
-- Prisma generates this automatically when you provide a default
ALTER TABLE "Service" ADD COLUMN "newField" TEXT NOT NULL DEFAULT '';
```

**Adding required foreign keys:**
```sql
-- Step 1: Add nullable column
ALTER TABLE "Service" ADD COLUMN "imageId" TEXT;

-- Step 2: Create related records and populate
INSERT INTO "ContainerImage" (id, name, ...)
SELECT ... FROM "Service" WHERE "imageId" IS NULL;

UPDATE "Service" SET "imageId" = (SELECT id FROM "ContainerImage" WHERE ...);

-- Step 3: Recreate table with NOT NULL constraint (SQLite limitation)
-- Prisma generates this automatically
```

**IMPORTANT:** If Prisma can't auto-generate a safe migration, it will prompt you.
Edit the generated SQL file to add data transformation logic BEFORE committing.

### WHAT TO NEVER DO

```bash
# ❌ NEVER use db push in production
npx prisma db push  # This bypasses migrations!

# ❌ NEVER commit schema changes without migrations
git add prisma/schema.prisma  # Missing migrations!

# ❌ NEVER manually edit production databases
sqlite3 prod.db "ALTER TABLE..."  # Breaks migration state!
```

### WHAT TO ALWAYS DO

```bash
# ✅ ALWAYS use migrate dev for schema changes
npx prisma migrate dev --name add_user_preferences

# ✅ ALWAYS commit migrations with schema
git add prisma/schema.prisma prisma/migrations/

# ✅ ALWAYS test migrations on a copy of production data
cp prod.db test.db && DATABASE_URL=file:./test.db npx prisma migrate deploy
```

### PRE-DEPLOYMENT CHECKLIST

Before merging any schema change:

- [ ] `npx prisma migrate dev` succeeded
- [ ] Migration SQL file reviewed for data safety
- [ ] Tested with existing data (not just empty database)
- [ ] Migration files committed to git
- [ ] No `prisma db push` commands in the change

### EMERGENCY: CONTAINER WON'T START

If migrations fail on deployment:

1. Check logs: `docker logs bridgeport`
2. The issue is in the migration SQL - fix it in the codebase
3. Rebuild and redeploy the image
4. Migrations will retry automatically

For legacy databases without migration history, the entrypoint auto-baselines them.

---

## Tech Stack

- **Backend**: Node.js, Fastify, TypeScript
- **Frontend**: React, Vite, Tailwind CSS, Recharts (charts)
- **Database**: SQLite with Prisma ORM
- **Encryption**: AES-256-GCM for secrets
- **Error Monitoring**: Sentry (optional, backend + frontend)
- **Monitoring Agent**: Go
- **CLI**: Go (Cobra framework)

## Project Structure

Backend in `src/` (lib, routes, services, plugins), frontend in `ui/`, Go agent in `bridgeport-agent/`, CLI in `cli/`, plugins in `plugins/`, tests in `tests/`, configs in `config/`.

> **Full structure**: [`docs/development/project-structure.md`](docs/development/project-structure.md)

## Development Commands

```bash
# Install dependencies
npm install
cd ui && npm install && cd ..

# Generate Prisma client (required after schema changes)
npm run db:generate

# Run migrations (development)
npx prisma migrate dev --name descriptive_name

# Start backend (port 3000)
npm run dev

# Start frontend (port 5173, separate terminal)
cd ui && npm run dev

# Build
npm run build
cd ui && npm run build

# Build Go agent
cd bridgeport-agent && make build-linux

# Build CLI
cd cli && make build
```

## Testing

Two vitest configs that must never be mixed: **integration** (`config/vitest.config.ts`, real SQLite, `isolate: false`) and **unit** (`config/vitest.unit.config.ts`, mocked Prisma, `isolate: true`).

```bash
npx vitest run --config config/vitest.config.ts       # Integration tests
npx vitest run --config config/vitest.unit.config.ts   # Unit tests
npx vitest run src/routes/auth.test.ts                 # Single file
```

> **Full guide** (examples, factories, what to test): [`docs/development/testing-guide.md`](docs/development/testing-guide.md)

## Versioning

BridgePort uses git-based versioning derived at build time:

- **App version**: `YYYYMMDDHH-{7-char SHA}` from current commit (passed as `APP_VERSION` build arg)
- **Agent version**: Derived from last commit touching `bridgeport-agent/` directory
- **CLI version**: Derived from last commit touching `cli/` directory

This means:
- No version files to maintain in the repo
- Agent/CLI versions only change when their code changes
- UI displays app version via `import.meta.env.VITE_APP_VERSION`
- Bundled agent/CLI versions stored in text files inside the Docker image

## Architecture & Reference

Key patterns (API routes, RBAC, DB access, encryption, metrics, orchestration, notifications), data models, environment variables, and UI features.

> **Full reference**: [`docs/development/architecture.md`](docs/development/architecture.md)

## Code Conventions

### Shared Helpers (`src/lib/helpers.ts`)

Use these instead of reimplementing:
- `safeJsonParse(json, defaultValue)` — null-safe JSON.parse with fallback, never throws
- `getErrorMessage(error, defaultMessage)` — extract message from unknown error values
- `parsePaginationQuery(query, defaults)` — parse limit/offset from Fastify query params

### Tag Filter Utilities (`src/lib/image-utils.ts`)

- `parseTagFilter(tagFilter)` — split comma-separated glob patterns
- `matchesTagFilter(tag, patterns)` — glob match a tag against patterns
- `getBestTag(tags, patterns)` — pick best display tag from a list
- `getDefaultTag(tagFilter)` — first pattern from tagFilter (fallback tag)
- `formatDigestShort(digest)` — first 12 chars of SHA digest

### Backend Patterns

- **Batch DB writes**: Use `createMany()` instead of looping with individual `create()` calls
- **Narrow includes**: When loading relations, `select` only the fields you need (don't load full Server objects just for `name`)
- **Parallel queries**: Independent DB queries should use `Promise.all()`, not sequential awaits
- **Cleanup functions**: Retention-based cleanup belongs in the service layer (e.g., `cleanupOldImageDigests()`), called from the scheduler

### Frontend Patterns

- **Memoize chart data**: Wrap `prepareChartData()` calls in `useMemo` — monitoring pages auto-refresh every 30s
- **Separate effects by dependency**: Don't refetch environment-wide data on pagination changes
- **Cap unbounded stores**: `breadcrumbNames` capped at 200 entries to prevent memory growth

## Important Notes

- BridgePort is a **generic, vendor-neutral tool** - do not add code tied to any specific company or hosting provider
- All secrets must be encrypted at rest
- SSH keys are stored encrypted per-environment
- Audit logging is required for sensitive operations
- File edits automatically save to history for rollback
- Agent tokens are per-server, generated when enabling agent mode
- System settings use a cached singleton pattern - call `getSystemSettings()` for current values
- Health check logs are stored in `HealthCheckLog` with automatic cleanup based on retention settings
- Notification types are initialized on startup via `initializeNotificationTypes()`
- Plugins are synced on startup via `syncPlugins()` from the `PLUGINS_DIR` directory
- Per-environment settings are created eagerly on environment creation via `createDefaultSettings()`
- Admin pages use a separate layout (`AdminLayout` + `AdminSidebar`) at `/admin/*` routes
- ContainerImage is required for every Service - central entity for image management
- **Docs stay in sync with code.** When you change `src/routes/**`, `src/services/**`, `prisma/schema.prisma`, `ui/src/pages/**`, or settings, update the matching file under `docs/guides/` or `docs/reference/` in the same PR. A Stop hook (`scripts/check-docs-drift.sh`) prints a reminder when code paths change without any `docs/` update.

## UI/UX Guidelines

Persist user preferences via Zustand, use skeleton loading states, no `<h1>` page titles (breadcrumbs handle that), use `ui/src/lib/status.ts` for status colors. Card layout for most lists, table layout for dense data.

> **Full guidelines** (layouts, badges, buttons, patterns): [`docs/development/ui-guidelines.md`](docs/development/ui-guidelines.md)
