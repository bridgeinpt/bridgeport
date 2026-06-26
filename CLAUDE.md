# BRIDGEPORT

A lightweight, self-hosted tool to deploy, orchestrate, and monitor Docker services across all your servers — production-grade ops without Kubernetes.

---

## ⛔ CRITICAL: DATABASE SCHEMA CHANGES ⛔

**BRIDGEPORT is a product used by multiple deployments. Schema changes MUST be automatic and safe.**

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
pnpm exec prisma migrate dev --name descriptive_name

# 3. Review the generated SQL in prisma/migrations/YYYYMMDD_descriptive_name/
#    - Prisma auto-generates safe migrations
#    - For complex changes, edit the SQL to add data transformations

# 4. Test the migration
pnpm run dev  # Verify app works

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
pnpm exec prisma db push  # This bypasses migrations!

# ❌ NEVER commit schema changes without migrations
git add prisma/schema.prisma  # Missing migrations!

# ❌ NEVER manually edit production databases
sqlite3 prod.db "ALTER TABLE..."  # Breaks migration state!
```

### WHAT TO ALWAYS DO

```bash
# ✅ ALWAYS use migrate dev for schema changes
pnpm exec prisma migrate dev --name add_user_preferences

# ✅ ALWAYS commit migrations with schema
git add prisma/schema.prisma prisma/migrations/

# ✅ ALWAYS test migrations on a copy of production data
cp prod.db test.db && DATABASE_URL=file:./test.db pnpm exec prisma migrate deploy
```

### PRE-DEPLOYMENT CHECKLIST

Before merging any schema change:

- [ ] `pnpm exec prisma migrate dev` succeeded
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
# Install dependencies (single pnpm workspace covers root + ui/)
# Requires pnpm: `npm install -g pnpm` (or Corepack on Node <25).
pnpm install
# The allowBuilds allowlist in pnpm-workspace.yaml builds better-sqlite3's
# native binding at install time — no separate rebuild step needed.
# See docs/development/supply-chain.md.

# Generate Prisma client (required after schema changes)
pnpm run db:generate

# Run migrations (development)
pnpm exec prisma migrate dev --name descriptive_name

# Start backend (port 3000)
pnpm run dev

# Start frontend (port 5173, separate terminal)
pnpm --filter bridgeport-ui run dev

# Build
pnpm run build
pnpm --filter bridgeport-ui run build

# Build Go agent
cd bridgeport-agent && make build-linux

# Build CLI
cd cli && make build
```

## Testing

Two vitest configs that must never be mixed: **integration** (`config/vitest.config.ts`, real SQLite, `isolate: false`) and **unit** (`config/vitest.unit.config.ts`, mocked Prisma, `isolate: true`).

```bash
pnpm exec vitest run --config config/vitest.config.ts       # Integration tests
pnpm exec vitest run --config config/vitest.unit.config.ts   # Unit tests
pnpm exec vitest run src/routes/auth.test.ts                 # Single file
```

> **Full guide** (examples, factories, what to test): [`docs/development/testing-guide.md`](docs/development/testing-guide.md)

## Common Pitfalls / CI Quirks

Hard-won gotchas that aren't obvious from the code — check here before debugging a "mysterious" failure:

- **Never run bare `npm test` / `vitest run`.** There is no root vitest config, so a bare run skips `tests/setup.ts` (leaving `MASTER_KEY`/`JWT_SECRET` unset → route tests error at collection), runs `ui/**` under the wrong environment, and globs any `.claude/worktrees/` copies — hundreds of spurious failures. Always use the two scoped configs above (and `cd ui && pnpm exec vitest run` for UI).
- **Fresh git worktrees need `pnpm install` before pushing.** A new `.claude/worktrees/` checkout has no installed `ui/` devDeps, so the pre-push hook (which runs `src/lib/` vitest for backend *and* UI) dies with a cryptic `@vitejs/plugin-react` error. Run `pnpm install` in the worktree first — don't reach for `--no-verify`.
- **Route schema changes require an OpenAPI snapshot refresh.** Adding/changing a `src/routes/**` route that carries a `routeSchema` needs `pnpm run openapi:dump` + the regenerated `openapi.json` committed, or the **OpenAPI Spec Drift** CI check fails even when everything else is green. Body-less write routes can also drop `openapi.test.ts`'s WRITE-body coverage floor (0.62) — fix with a real request body or route consolidation, never by lowering the floor.
- **GitHub Actions are allowlisted.** Only approved actions run; an un-allowlisted third-party action makes the job fail with `startup_failure`. Also: `build.yml` (the Docker image build) does **not** run on PRs, so verify Docker/image changes locally.
- **CodeQL `js/missing-rate-limiting` false positive.** Adding Fastify `{schema}` route-options to a handler already covered by the global rate limit trips this alert. It's a known false positive — dismiss it; the global limiter still applies.
- **Global `onSend` hooks must be sync, 4-arg `done`-callback style.** A deferring/async global `onSend` double-writes headers (`ERR_HTTP_HEADERS_SENT`) against the error-handler's payload-rewriting `onSend`. Do async work in `onResponse` instead.

## Versioning

BRIDGEPORT uses git-based versioning derived at build time:

- **App version**: `YYYYMMDDHH-{7-char SHA}` from current commit (passed as `APP_VERSION` build arg)
- **Agent version**: Derived from last commit touching `bridgeport-agent/` directory
- **CLI version**: Derived from last commit touching `cli/` directory

This means:
- No version files to maintain in the repo
- Agent/CLI versions only change when their code changes
- UI displays app version via `import.meta.env.VITE_APP_VERSION`
- Bundled agent/CLI versions stored in text files inside the Docker image

## Go SDK (`client/`) & Terraform Provider

`client/` is an importable Go SDK (`github.com/bridgeinpt/bridgeport/client`) for the HTTP API. The official [`terraform-provider-bridgeport`](https://github.com/bridgeinpt/terraform-provider-bridgeport) (separate repo, published to the Terraform + OpenTofu registries) is built on top of it — see [`docs/guides/terraform.md`](docs/guides/terraform.md). This repo owns the contract that keeps them in lockstep.

- **The SDK has its own version line.** Bump `client/VERSION` (semver) when you change anything under `client/`; a CI job auto-tags `client/vX.Y.Z` on merge to master from that marker. New method = minor bump; behavior change/removal = major. The provider pins a `client/vX.Y.Z` and bumps it to pick up new methods.
- **Keep the SDK in lockstep with the API.** Any API change the SDK should expose (new route, changed shape, new field) lands the matching SDK method **in the same PR**, with `client/VERSION` bumped. The checked-in OpenAPI snapshot and the [API stability policy](docs/api-stability.md) are the contract.
- **⚠️ Tell the provider repo when an SDK change affects it.** When an SDK change is **breaking**, or it **resolves an SDK-gap issue the provider raised against this repo**: either comment on the originating [`terraform-provider-bridgeport`](https://github.com/bridgeinpt/terraform-provider-bridgeport/issues) issue, or — if none exists — open a new one telling them what changed and what to update on their side. The provider must never silently fall behind a breaking SDK release.

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
- **Shell composition**: Any value interpolated into a command string passed to `client.exec()`, `client.execStream()`, or local `execAsync()` must be wrapped in `shellEscape()` from `src/lib/ssh.ts`. Double-quoting (`"${path}"`) is insufficient — `$`, backticks, and `$()` are still interpreted by the shell. For file contents that need to reach a remote file, prefer `client.writeFile()` over heredocs so the content isn't subject to shell parsing at all.

### Frontend Patterns

- **Memoize chart data**: Wrap `prepareChartData()` calls in `useMemo` — monitoring pages auto-refresh every 30s
- **Separate effects by dependency**: Don't refetch environment-wide data on pagination changes
- **Cap unbounded stores**: `breadcrumbNames` capped at 200 entries to prevent memory growth

## Important Notes

- BRIDGEPORT is a **generic, vendor-neutral tool** - do not add code tied to any specific company or hosting provider
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
- Service is a template (image, env, health, compose, container-image link); per-server runtime lives on ServiceDeployment (containerName, status, discovery, ports). UI/API back-compat: a `service.server`-style accessor still resolves to the first deployment's server, but new code should read from `serviceDeployments[]`
- ConfigFragment is env-scoped, reusable text shared across config files; when an in-use fragment is deleted/edited the dependent files are auto-resynced. Config files support `{{range servers tag="..."}}` templating to iterate over tagged servers
- `SyncBatch`/`SyncBatchOperation` back atomic multi-resource syncs: all-or-nothing transactional rollouts with rollback and dry-run preview (`src/services/sync-batch.ts`)
- `ServiceAccount` is a machine identity for API access (survives user turnover); API token scope is set via `allEnvironments` or the `ApiTokenEnvironment` join table, with a per-token `role` cap
- `ServiceType`/`ServiceTypeCommand` and `DatabaseType`/`DatabaseTypeCommand` are plugin-defined types with predefined commands (shell, migrate, etc.), seeded from `plugins/` on startup
- `ExternalEntity` (CDNs, clients, third-party deps) and `ServerCluster` (logical server groupings) are topology nodes beyond services/databases, rendered on the dashboard diagram
- `SecretUsage`/`VarUsage` join tables track which config files reference which secrets/vars, so list endpoints avoid regex-scanning config content
- Denormalized `lastHealthCheck*` fields on `Server`/`ServiceDeployment` are a read cache for fast list rendering; `HealthCheckLog` remains the source of truth
- **Debugging against a live instance:** if `BRIDGEPORT_URL` and `BRIDGEPORT_TOKEN` are set in `.env` (a read-only service-account token), you can query a running instance for real data — `curl -H "Authorization: Bearer $BRIDGEPORT_TOKEN" "$BRIDGEPORT_URL/api/environments"`. Read-only only: never run mutating calls without explicit per-action approval. (Secret-value reveal is admin-only, so a viewer/operator token can't read decrypted secrets anyway.) See [`docs/operations/troubleshooting.md`](docs/operations/troubleshooting.md#querying-a-live-instance-read-only-api-access).
- **Docs stay in sync with code.** When you change `src/routes/**`, `src/services/**`, `prisma/schema.prisma`, `ui/src/pages/**`, or settings, update the matching file under `docs/guides/` or `docs/reference/` in the same PR. A Stop hook (`scripts/check-docs-drift.sh`) prints a reminder when code paths change without any `docs/` update.

## UI/UX Guidelines

The UI is built on **shadcn/ui** (Radix + Tailwind v4 + CSS-variable theming), with a Deep Slate dark theme and an opt-in light theme (`ThemeProvider` + user-menu switcher, default `system`). Primitives live in `ui/src/components/ui/`; add new ones with `cd ui && pnpm dlx shadcn@latest add <component>`.

Key conventions: style with **semantic tokens** (`bg-background`, `bg-card`, `bg-primary` sky, `bg-destructive` red, `bg-brand` burgundy, `bg-success/warning/info`) — never raw `slate-*`/`primary-NNN` ramps; status via `statusVariant()`/`StatusBadge` (`ui/src/lib/status.ts`); confirmations via `useConfirm()` (not `window.confirm`); modals via `Dialog`; forms via shadcn `Form` (react-hook-form + zod); toasts via Sonner (`toast`/`useToast`); icons via `lucide-react` (`components/Icons.tsx` re-exports). No `<h1>` page titles (Breadcrumb owns them); skeleton loading states; cards for most lists, `Table` for dense data. Prefer role-based test queries; Radix supplies a11y roles/focus-trap for free.

> **Full guidelines** (tokens, theming, variants, composites, forms, a11y): [`docs/development/ui-guidelines.md`](docs/development/ui-guidelines.md)
