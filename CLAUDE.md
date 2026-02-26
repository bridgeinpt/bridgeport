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

```
bridgeport/
├── src/                      # Backend
│   ├── server.ts             # Fastify entry point
│   ├── lib/                  # Core utilities
│   │   ├── config.ts         # Environment configuration (Zod schema)
│   │   ├── crypto.ts         # Encryption utilities
│   │   ├── db.ts             # Prisma client
│   │   ├── docker.ts         # Docker client abstraction (socket + SSH)
│   │   ├── ssh.ts            # SSH client wrapper
│   │   ├── scheduler.ts      # Background job scheduler
│   │   ├── registry.ts       # Container registry client factory
│   │   ├── image-utils.ts    # Image name parsing + tag utilities
│   │   └── sentry.ts         # Sentry error monitoring init
│   ├── routes/               # API routes
│   │   ├── auth.ts           # Authentication (login, token refresh)
│   │   ├── users.ts          # User management (RBAC)
│   │   ├── environments.ts   # Environment CRUD
│   │   ├── environment-settings.ts # Per-module env settings (GET/PATCH/reset)
│   │   ├── servers.ts        # Server management
│   │   ├── services.ts       # Container management
│   │   ├── secrets.ts        # Secret management + env templates
│   │   ├── config-files.ts   # Config files with history
│   │   ├── registries.ts     # Registry connections
│   │   ├── container-images.ts # Container image management + deploy triggers
│   │   ├── service-dependencies.ts # Service dependency CRUD
│   │   ├── deployment-plans.ts # Orchestrated deployment plans
│   │   ├── compose.ts        # Docker compose template preview/generation
│   │   ├── databases.ts      # Database backup + monitoring management
│   │   ├── metrics.ts        # Server/service metrics + agent ingest
│   │   ├── monitoring.ts     # Health logs, metrics history, SSH testing, overview
│   │   ├── topology.ts       # Service topology connections + diagram layouts
│   │   ├── notifications.ts  # User notifications + preferences + types
│   │   ├── settings.ts       # Service types CRUD
│   │   ├── spaces.ts         # Global Spaces configuration
│   │   ├── system-settings.ts # System-wide operational settings
│   │   ├── audit.ts          # Audit logs
│   │   ├── webhooks.ts       # CI/CD webhooks (incoming)
│   │   ├── downloads.ts      # CLI binary downloads
│   │   └── admin/            # Admin-only route modules
│   │       ├── smtp.ts       # SMTP email configuration
│   │       ├── webhooks.ts   # Outgoing webhook configuration
│   │       └── slack.ts      # Slack channel + routing configuration
│   ├── services/             # Business logic
│   │   ├── metrics.ts        # SSH metrics collection
│   │   ├── deploy.ts         # Service deployment logic
│   │   ├── orchestration.ts  # Deployment plan builder + executor
│   │   ├── image-management.ts # Container image CRUD + tag history
│   │   ├── compose.ts        # Compose template rendering + artifacts
│   │   ├── health-checks.ts  # Health check business logic + scheduler config
│   │   ├── health-verification.ts # Post-deploy health verification
│   │   ├── database-backup.ts # Backup execution
│   │   ├── database-monitoring-collector.ts # Database metrics collection scheduler
│   │   ├── database-query-executor.ts # Generic SQL/SSH query executor
│   │   ├── host-detection.ts # Docker host detection + bootstrap
│   │   ├── notifications.ts  # Notification creation + delivery + type management
│   │   ├── bounce-tracker.ts # Consecutive failure tracking for bounce logic
│   │   ├── email.ts          # SMTP email sender
│   │   ├── slack-notifications.ts # Slack webhook sender
│   │   ├── agent-deploy.ts   # Agent auto-deployment via SSH
│   │   ├── agent-events.ts   # Agent lifecycle event logging
│   │   ├── audit.ts          # Audit log helper
│   │   ├── auth.ts           # Auth bootstrap + user management
│   │   ├── servers.ts        # Server business logic
│   │   ├── services.ts       # Service business logic
│   │   ├── secrets.ts        # Secret CRUD helpers
│   │   ├── registries.ts     # Registry connection helpers
│   │   ├── service-types.ts  # Service type utilities
│   │   ├── plugin-loader.ts  # Plugin sync, reset, export
│   │   ├── environment-settings.ts # Per-module settings registry + CRUD
│   │   ├── system-settings.ts # Cached system settings singleton
│   │   └── outgoing-webhooks.ts # Webhook delivery with retries
│   └── plugins/              # Fastify plugins
│       ├── authenticate.ts   # JWT authentication
│       └── authorize.ts      # RBAC middleware
├── ui/                       # Frontend (React + Vite)
│   ├── src/
│   │   ├── components/       # Reusable components
│   │   │   ├── Layout.tsx    # Navigation sidebar with env selector
│   │   │   ├── AdminLayout.tsx # Admin area layout wrapper
│   │   │   ├── AdminSidebar.tsx # Admin navigation sidebar
│   │   │   ├── TopBar.tsx    # Top bar with breadcrumbs
│   │   │   ├── Breadcrumbs.tsx # Route-aware breadcrumbs
│   │   │   ├── NotificationBell.tsx # Notification dropdown
│   │   │   ├── DependencyGraph.tsx # Service dependency visualization
│   │   │   ├── DependencyEditor.tsx # Dependency CRUD modal
│   │   │   ├── DependencyFlow.tsx # Flow diagram for dependencies
│   │   │   ├── DeploymentProgress.tsx # Deployment plan progress tracker
│   │   │   ├── HealthConfigEditor.tsx # Per-service health check config
│   │   │   ├── monitoring/   # Shared monitoring components
│   │   │   │   ├── ChartCard.tsx       # Recharts line chart wrapper
│   │   │   │   ├── StatCard.tsx        # Stat card with color variants
│   │   │   │   ├── MetricGauge.tsx     # Progress bar gauge
│   │   │   │   ├── TimeRangeSelector.tsx # Time range segmented buttons
│   │   │   │   └── AutoRefreshToggle.tsx # Auto-refresh checkbox
│   │   │   └── topology/     # Topology diagram components
│   │   │       ├── TopologyDiagram.tsx  # Main diagram canvas
│   │   │       ├── ServiceNode.tsx      # Service node renderer
│   │   │       ├── DatabaseNode.tsx     # Database node renderer
│   │   │       ├── ServerGroupNode.tsx  # Server group renderer
│   │   │       ├── NodePopover.tsx      # Node detail popover
│   │   │       └── AddConnectionModal.tsx # Connection creation modal
│   │   ├── pages/            # Page components
│   │   │   ├── Dashboard.tsx # Overview with topology diagram + stats
│   │   │   ├── Servers.tsx   # Server list
│   │   │   ├── ServerDetail.tsx # Server config + monitoring
│   │   │   ├── Services.tsx  # Service list
│   │   │   ├── ServiceDetail.tsx # Service deploy + health checks
│   │   │   │   └── service-detail/ # Service detail sub-components
│   │   │   │       ├── DeployCard.tsx        # Deploy UI card
│   │   │   │       ├── DeploymentHistory.tsx # Past deployments
│   │   │   │       ├── ActionHistory.tsx     # Service action log
│   │   │   │       ├── ConfigFilesCard.tsx   # Config file attachments
│   │   │   │       └── HealthCheckResultCard.tsx # Health check display
│   │   │   ├── ContainerImages.tsx # Container image management
│   │   │   ├── DeploymentPlans.tsx # Deployment plan list
│   │   │   ├── DeploymentPlanDetail.tsx # Deployment plan detail + progress
│   │   │   ├── Registries.tsx # Registry connection list
│   │   │   ├── Databases.tsx # Database list
│   │   │   ├── DatabaseDetail.tsx # Database config + backups + monitoring
│   │   │   ├── Secrets.tsx   # Secret management
│   │   │   ├── ConfigFiles.tsx # Config file grid
│   │   │   ├── Settings.tsx  # Per-environment settings (tabbed)
│   │   │   ├── Notifications.tsx # User notification inbox
│   │   │   ├── Login.tsx     # Login page
│   │   │   ├── Monitoring.tsx # Monitoring overview summary hub
│   │   │   ├── MonitoringServers.tsx   # Server metrics + charts
│   │   │   ├── MonitoringServices.tsx  # Service metrics + charts
│   │   │   ├── MonitoringDatabases.tsx # Database monitoring grid
│   │   │   ├── DatabaseMonitoringDetail.tsx # Database monitoring detail + charts
│   │   │   ├── MonitoringHealth.tsx # Health check logs
│   │   │   ├── MonitoringAgents.tsx # Agent management, SSH testing
│   │   │   └── admin/        # Admin-only pages
│   │   │       ├── About.tsx          # App version + CLI downloads
│   │   │       ├── SystemSettings.tsx # System-wide settings
│   │   │       ├── ServiceTypes.tsx   # Service type management
│   │   │       ├── DatabaseTypes.tsx  # Database type management
│   │   │       ├── Storage.tsx        # Global Spaces configuration
│   │   │       ├── Users.tsx          # User management
│   │   │       ├── Audit.tsx          # Audit log viewer
│   │   │       └── NotificationSettings.tsx # Notification type + channel config
│   │   └── lib/              # Utilities
│   │       ├── api.ts        # API client
│   │       ├── store.ts      # Zustand stores (persisted)
│   │       ├── status.ts     # Status color/label utilities
│   │       ├── topology.ts   # Topology graph helpers
│   │       └── sentry.ts     # Sentry frontend init
│   └── public/               # Static assets
├── plugins/                  # Plugin JSON definitions
│   ├── service-types/        # Service type definitions (Django, Node.js, etc.)
│   └── database-types/       # Database type definitions with monitoring queries
├── bridgeport-agent/         # Go monitoring agent
│   ├── main.go               # Agent entry point
│   ├── collector/
│   │   ├── system.go         # CPU, memory, disk, load
│   │   └── docker.go         # Container metrics
│   ├── go.mod
│   └── Makefile
├── cli/                      # Go command-line interface
│   ├── main.go               # CLI entry point
│   ├── cmd/                  # Command implementations
│   │   ├── root.go           # Root command, global flags
│   │   ├── login.go          # Authentication
│   │   ├── list.go           # List servers
│   │   ├── status.go         # Server details
│   │   ├── ssh.go            # SSH access
│   │   ├── exec.go           # Container exec
│   │   ├── logs.go           # Container logs
│   │   └── run.go            # Predefined commands
│   ├── internal/             # Internal packages
│   │   ├── api/              # API client
│   │   ├── config/           # Config management
│   │   ├── ssh/              # SSH connectivity
│   │   ├── docker/           # Docker operations
│   │   └── output/           # Terminal formatting
│   ├── go.mod
│   └── Makefile
├── config/                   # Build/test configuration
│   ├── vitest.config.ts      # Integration test config
│   ├── vitest.unit.config.ts # Unit test config
│   ├── vitest.workspace.ts   # Vitest workspace
│   └── codecov.yml           # Code coverage config
├── prisma/schema.prisma      # Database schema
├── docker/                   # Docker + Caddy configuration
├── docs/                     # Project documentation
└── tests/                    # Test infrastructure
    ├── helpers/              # Test app builder, auth helpers
    ├── factories/            # Test data factories
    └── security/             # RBAC matrix tests
```

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

BridgePort uses Vitest with **two separate configs** that must never be mixed:

| Config | Scope | Isolation | Database |
|--------|-------|-----------|----------|
| `config/vitest.config.ts` | Integration tests (`src/routes/`, `tests/`) | `isolate: false`, `maxWorkers: 1` | Real SQLite |
| `config/vitest.unit.config.ts` | Unit tests (`src/services/`, `src/lib/`) | `isolate: true` | Mocked via `vi.mock` |

**Why two configs?** Integration tests share a real SQLite database and need `isolate: false` so the singleton PrismaClient stays alive across files. Unit tests use `vi.mock('../lib/db.js')` to mock Prisma, and need `isolate: true` so mocks don't leak between files. Mixing them in one process causes data races or mock pollution.

### Running Tests

```bash
# Integration tests (routes, security, smoke)
npx vitest run --config config/vitest.config.ts

# Unit tests (services, lib)
npx vitest run --config config/vitest.unit.config.ts

# Single test file
npx vitest run src/routes/auth.test.ts

# Watch mode
npx vitest --watch src/routes/auth.test.ts
```

### Test File Placement

- **Route tests**: `src/routes/<name>.test.ts` (next to the route file)
- **Service unit tests**: `src/services/<name>.test.ts` (next to the service file)
- **Lib unit tests**: `src/lib/<name>.test.ts`
- **Security tests**: `tests/security/<name>.test.ts`
- **Smoke tests**: `tests/smoke.test.ts`

### Writing Integration Tests (Routes)

Integration tests use a real Fastify instance with all routes registered, backed by a real SQLite database.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('example routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();

    // Use unique emails per test file to avoid conflicts with other files
    const admin = await createTestUser(app.prisma, { email: 'admin@example.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@example.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'example-env' });
    envId = env.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/environments/:envId/things', () => {
    it('should list things', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/things`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('things');
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/things`,
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject viewer for admin-only route', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/things`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'test' },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
```

**Key rules for integration tests:**

1. **Use `buildTestApp()`** — creates a fully-configured Fastify instance with all routes
2. **Use `app.inject()`** — Fastify's built-in HTTP injection (no real server needed)
3. **Use factories** — `createTestUser`, `createTestEnvironment`, `createTestServer`, `createTestContainerImage`, `createTestService` for test data setup
4. **Use unique emails** per test file (e.g., `admin@myfeature.test`) to avoid conflicts since all test files share one database
5. **Always test**: happy path, authentication (401), authorization (403), validation (400), and not-found (404)
6. **Use `app.prisma`** for direct database assertions or extra setup
7. **Match actual route URLs** — check the route file for exact paths (e.g., `/api/settings/system` not `/api/system-settings`)
8. **Match actual field names** — check the Prisma schema and Zod validation for correct request/response shapes

### Writing Unit Tests (Services)

Unit tests mock all dependencies (especially Prisma) and test business logic in isolation.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Hoist mocks BEFORE imports
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    myModel: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// 2. Mock the db module
vi.mock('../lib/db.js', () => ({ prisma: mockPrisma }));

// 3. Import the module under test AFTER mocking
import { createThing, listThings } from './my-service.js';

describe('my-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a thing', async () => {
    mockPrisma.myModel.create.mockResolvedValue({ id: '1', name: 'test' });

    const result = await createThing({ name: 'test' });

    expect(result).toMatchObject({ id: '1', name: 'test' });
    expect(mockPrisma.myModel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'test' }),
    });
  });
});
```

**Key rules for unit tests:**

1. **Use `vi.hoisted()`** to define mocks before any module imports
2. **Use `vi.mock('../lib/db.js')`** to replace the Prisma singleton
3. **Import the module under test AFTER `vi.mock()` calls**
4. **Use `vi.clearAllMocks()`** in `beforeEach`
5. **Mock only what's needed** — only the Prisma models/methods your service uses
6. **Also mock other services** if your service imports them (e.g., `vi.mock('./audit.js')`)

### Available Factories

All factories are in `tests/factories/` and can be imported from `tests/factories/index.js`:

| Factory | Required Fields | Default Role/Type |
|---------|----------------|-------------------|
| `createTestUser(prisma, opts)` | — | `role: 'admin'`, `password: 'test-password-123'` |
| `createTestEnvironment(prisma, opts)` | — | Auto-named `test-env-N` |
| `createTestServer(prisma, opts)` | `environmentId` | `dockerMode: 'ssh'` |
| `createTestContainerImage(prisma, opts)` | `environmentId` | `currentTag: 'latest'` |
| `createTestService(prisma, opts)` | `serverId`, `containerImageId` | Auto-named `service-N` |

Every `Service` requires a `ContainerImage` — always create the image first.

### What to Test for New Routes

For every new API route, test at minimum:

1. **Happy path** — correct response status and shape
2. **Authentication** — returns 401 without token
3. **Authorization** — returns 403 for insufficient role (if route uses `requireAdmin`/`requireOperator`)
4. **Validation** — returns 400 for invalid input (if route validates body/params)
5. **Not found** — returns 404 for non-existent resources
6. **Conflicts** — returns 409 for duplicate entries (if applicable)
7. **Add to security tests** — add the route to `tests/security/rbac-matrix.test.ts` in the appropriate role array (`adminRoutes`, `operatorRoutes`, or `viewerRoutes`)

### What to Test for Bug Fixes

1. **Reproduce the bug** — write a failing test that demonstrates the bug
2. **Fix the code** — make the test pass
3. **Keep the test** — it serves as regression protection

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

## Key Patterns

### API Routes
Routes are in `src/routes/`. Each route file exports a Fastify plugin:

```typescript
export default async function (fastify: FastifyInstance) {
  fastify.get('/api/example', async (request, reply) => {
    // Handler
  });
}
```

### Authorization (RBAC)
Use middleware from `src/plugins/authorize.ts`:

```typescript
import { requireAdmin, requireOperator } from '../plugins/authorize.js';

// Admin only route
fastify.post('/api/users', { preHandler: [fastify.authenticate, requireAdmin] }, handler);

// Admin or Operator
fastify.post('/api/deploy', { preHandler: [fastify.authenticate, requireOperator] }, handler);
```

Three roles: `admin` > `operator` > `viewer`

### Database Access
Use Prisma client from `src/lib/db.ts`:

```typescript
import { prisma } from '../lib/db';
const servers = await prisma.server.findMany();
```

### Secret Encryption
Secrets are encrypted with AES-256-GCM. Use `src/lib/crypto.ts`:

```typescript
import { encrypt, decrypt } from '../lib/crypto';
const encrypted = encrypt(plaintext);
const decrypted = decrypt(encrypted);
```

### Frontend State
Zustand stores in `ui/src/lib/store.ts`. API client in `ui/src/lib/api.ts`.

Environment selection is persisted to localStorage via Zustand persist middleware.

### Metrics Collection
Two modes for server metrics:

1. **SSH Polling** (`src/services/metrics.ts`): BridgePort collects via SSH
2. **Agent Push** (`src/routes/metrics.ts`): Agent sends to `/api/metrics/ingest`

### Database Monitoring
Plugin-driven monitoring for PostgreSQL, MySQL, and SQLite databases:

1. **Monitoring queries** defined in `plugins/database-types/*.json` under `monitoring` key
2. **SQL mode** (`pg`/`mysql2`): Direct database connections for query execution
3. **SSH mode**: Command execution via SSH for file-based databases (SQLite)
4. **Collector** (`src/services/database-monitoring-collector.ts`): Scheduled collection respecting per-database intervals
5. **Query executor** (`src/services/database-query-executor.ts`): Generic executor supporting scalar, row, and rows result types

### Deployment Orchestration
Multi-service deployment with dependency-aware ordering:

1. **Container Images** (`src/services/image-management.ts`): Central image entity shared across services
2. **Dependencies** (`ServiceDependency` model): `health_before` and `deploy_after` types control ordering
3. **Orchestration** (`src/services/orchestration.ts`): Plan builder resolves dependency order, executor runs steps
4. **Health Verification** (`src/services/health-verification.ts`): Post-deploy health checks with retries
5. **Auto-Rollback**: On failure, all previously deployed services roll back to previous tags

### Notification System
Multi-channel notification delivery:

1. **Types** defined in `src/services/notifications.ts` with templates and severity
2. **Channels**: In-app, email (SMTP), outgoing webhooks, Slack
3. **Bounce logic** (`src/services/bounce-tracker.ts`): Prevents alert storms from repeated failures
4. **Preferences**: Per-user, per-type channel selection with optional environment filtering

## Environment Variables

Required for development:

```bash
DATABASE_URL=file:./dev.db
MASTER_KEY=<openssl rand -base64 32>
JWT_SECRET=<openssl rand -base64 32>
```

Optional settings:

```bash
HOST=0.0.0.0
PORT=3000
UPLOAD_DIR=./uploads
CORS_ORIGIN=https://deploy.example.com  # Comma-separated origins
PLUGINS_DIR=./plugins                    # Plugin JSON directory

# Initial admin (created on first boot if no users exist)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-secure-password

# Scheduler intervals (all in seconds)
SCHEDULER_ENABLED=true
SCHEDULER_SERVER_HEALTH_INTERVAL=60     # Server health checks
SCHEDULER_SERVICE_HEALTH_INTERVAL=60    # Service health checks
SCHEDULER_DISCOVERY_INTERVAL=300        # Container discovery
SCHEDULER_UPDATE_CHECK_INTERVAL=1800    # Registry update checks
SCHEDULER_METRICS_INTERVAL=300          # SSH metrics collection
SCHEDULER_BACKUP_CHECK_INTERVAL=60      # Backup schedule check

# Sentry error monitoring (opt-in)
SENTRY_BACKEND_DSN=https://key@sentry.io/12345
SENTRY_FRONTEND_DSN=https://key@sentry.io/67890
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0            # 0.0-1.0
SENTRY_ENABLED=true                     # Kill switch
```

## Key Models

```
# Core Resources
User               - Authentication with role (admin/operator/viewer), lastActiveAt, apiTokens
ApiToken           - Per-user API tokens with hash, expiry, last used tracking
Environment        - Logical grouping with SSH key, per-module settings (General/Monitoring/Operations/Data/Configuration)
Server             - Physical/virtual machine with metricsMode, dockerMode (ssh/socket), agent status tracking
Service            - Docker container linked to ContainerImage, with dependencies, health config, TCP/cert checks
Secret             - Encrypted key-value with neverReveal flag
ConfigFile         - Synced configuration files (text + binary support with isBinary, mimeType)
FileHistory        - Edit history for config files
Deployment         - Deployment record with logs, duration, linked to ContainerImageHistory
DeploymentArtifact - Generated compose/env/config files per deployment

# Orchestration
ContainerImage        - Central image entity linked to services, with currentTag/latestTag/autoUpdate
ContainerImageHistory - Tag deployment history per image (success/failed/rolled_back)
ServiceDependency     - Deployment order dependencies (health_before, deploy_after)
DeploymentPlan        - Orchestrated multi-service deployment with auto-rollback
DeploymentPlanStep    - Individual steps in a deployment plan (deploy/health_check/rollback)

# Data Management
Database           - Registered database for backups + monitoring (editable after creation)
DatabaseBackup     - Backup record with status, progress, duration
DatabaseMetrics    - Time-series database monitoring metrics (JSON blob per collection)
BackupSchedule     - Cron-based backup scheduling
ServiceDatabase    - Links services to databases with connection env var

# Monitoring & Metrics
ServerMetrics      - Time-series server metrics (CPU, memory, disk, load, TCP, FDs)
ServiceMetrics     - Time-series container metrics (CPU, memory, network, block I/O)
HealthCheckLog     - Health check results with duration, status, response details
AgentContainerSnapshot - Agent-reported container discovery data (latest per server)
AgentProcessSnapshot   - Agent-reported top processes (latest per server)
AgentEvent         - Agent lifecycle events (deploy, status change, token regen)

# Registry & Images
RegistryConnection - Container registry with refreshIntervalMinutes, autoLinkPattern

# Notifications
NotificationType       - Notification type definitions with templates, severity, bounce settings
Notification           - Individual notifications sent to users (in-app, email, webhook)
NotificationPreference - Per-user, per-type notification channel preferences
BounceTracker          - Consecutive failure tracking for bounce logic

# Integrations
SmtpConfig         - SMTP email configuration (singleton-like)
WebhookConfig      - Outgoing webhook endpoints with filtering
SlackChannel       - Slack incoming webhook channels
SlackTypeRouting   - Routes notification types to Slack channels

# Service Topology
ServiceConnection  - User-defined connections between services/databases (port, protocol, direction)
DiagramLayout      - Persisted node positions per environment for topology diagram

# Global Settings
ServiceType        - Predefined service types (Django, Node.js, etc.) with commands
ServiceTypeCommand - Commands for a service type (shell, migrate, etc.)
DatabaseType       - Database engine types (PostgreSQL, MySQL, SQLite) with monitoring queries
DatabaseTypeCommand - Commands for a database type (shell, vacuum, etc.)
SpacesConfig       - Global DO Spaces credentials
SpacesEnvironment  - Per-environment Spaces enable/disable
SystemSettings     - System-wide operational settings (timeouts, limits, retries, URLs)

# Per-Environment Settings (one row each per environment)
GeneralSettings       - sshUser
MonitoringSettings    - Intervals, retention, metric toggles, bounce thresholds
OperationsSettings    - Default docker/metrics modes
DataSettings          - Backup download, default monitoring settings
ConfigurationSettings - Secret reveal permissions
```

## UI Features

### Navigation (Sidebar Groups)
- **Operations**: Dashboard, Servers, Services, Databases
- **Monitoring**: Overview, Servers, Services, Databases, Health Checks, Agents & SSH
- **Orchestration**: Container Images, Deployment Plans, Registries
- **Configuration**: Environment Settings (admin), Secrets, Config Files
- **Clickable Logo**: Click sidebar logo to navigate to dashboard
- **My Account Modal**: Click user icon in sidebar to access profile and password change (all users)
- **Notification Bell**: In-app notification dropdown with unread count
- **Collapsible Groups**: Sidebar groups collapse/expand, state persisted to localStorage

### Server Management
- **Monitoring Card**: Configure metrics mode (disabled/SSH/agent), view real-time metrics
- **Create Service**: Manually create services before containers exist
- **Discover Containers**: Auto-discover running Docker containers

### Service Management
- **Deploy**: Deploy new image tags with pull, linked to ContainerImage
- **Health Checks**: Manual health checks with detailed results (container + URL)
- **Health Check Config**: Per-service health wait, retries, interval for deployment orchestration
- **TCP/Cert Checks**: Agent-performed TCP port connectivity and TLS certificate expiry checks
- **Dependencies**: Define deployment order dependencies between services
- **Health Check History**: View past health check results from audit log
- **Deployment History**: View past deployments with expandable logs
- **Config Files**: Attach and sync config files to servers
- **Compose Templates**: Docker compose template management with placeholder substitution

### Container Image Management (`/container-images`)
- **Central Image Entity**: One image can be linked to multiple services
- **Tag History**: Track all deployed tags with success/failure/rollback status
- **Registry Integration**: Check for updates from linked registries
- **Auto-Update**: Per-image toggle for automatic deployment on new tags
- **Deploy All**: Deploy a tag to all linked services via orchestration

### Deployment Orchestration (`/deployment-plans`)
- **Multi-Service Deployment**: Deploy to multiple services with dependency-aware ordering
- **Auto-Rollback**: Automatically roll back all services on failure
- **Step Tracking**: Real-time progress of deploy/health_check/rollback steps
- **Parallel Execution**: Option to run same-level services in parallel

### Database Management
- **Edit Databases**: Edit existing database configurations (name, connection, backup settings)
- **Backup Management**: View, create, and delete backups with schedule configuration
- **Database Monitoring**: Enable/disable monitoring, configure collection intervals, test connections
- **Monitoring Queries**: Plugin-driven (defined in database type JSON files), supports PostgreSQL, MySQL, SQLite

### Notifications (`/notifications`)
- **In-App Inbox**: Notification list with read/unread, filtering by category
- **Preferences**: Per-user, per-type channel preferences (in-app, email, webhook)
- **Bounce Logic**: Consecutive failure tracking to avoid alert storms

### Monitoring Hub (`/monitoring/*`)
- **Overview** (`/monitoring`): Summary hub with quick stats and links to sub-pages
- **Servers** (`/monitoring/servers`): Server metrics with time-series charts (CPU, Memory, Disk, Load, Swap, TCP)
- **Services** (`/monitoring/services`): Service metrics with charts (CPU, Memory, Network RX/TX)
- **Databases** (`/monitoring/databases`): Database monitoring grid with status, key metrics, sparklines
- **Database Detail** (`/monitoring/databases/:id`): Dynamic charts driven by plugin monitoring queries
- **Health Checks** (`/monitoring/health`): Filterable health check logs with pagination
- **Agents** (`/monitoring/agents`): Agent management, SSH connectivity testing, upgrade indicators
- Shared components in `ui/src/components/monitoring/` (ChartCard, StatCard, MetricGauge, etc.)
- Auto-refresh every 30 seconds

### Service Topology (Dashboard)
- **Interactive Diagram**: Visual service/database topology on the dashboard
- **Connections**: User-defined connections with port, protocol, direction
- **Draggable Nodes**: Positions persisted per environment
- **Server Groups**: Services grouped by server visually

### Agent Upgrade Indicators
- Server detail page shows "Update available" badge when deployed agent differs from bundled version
- Monitoring Agents page shows upgrade status column for all agents
- Bundled agent version exposed via `/health` and agent status API

### Admin Area (`/admin/*`) - Separate Layout
- **About** (`/admin/about`): App version + CLI tool downloads
- **System** (`/admin/system`): SSH timeouts, webhook retries, backup timeouts, limits, URLs
- **Service Types** (`/admin/service-types`): Manage predefined service types and commands
- **Database Types** (`/admin/database-types`): Manage database type definitions and monitoring queries
- **Storage** (`/admin/storage`): Global DO Spaces config with per-environment toggles
- **Users** (`/admin/users`): User management with active status tracking
- **Audit** (`/admin/audit`): Audit log viewer
- **Notifications** (`/admin/notifications`): Notification type config, SMTP, Slack channels, webhooks

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

## UI/UX Guidelines

### 1. Persist User Preferences
All user-configurable UI state should be persisted to localStorage via Zustand:

**Must persist:**
- Filter selections (toggles, dropdowns)
- Time range selections
- Collapse/expand states
- Auto-refresh toggles
- Sort preferences

**Use existing patterns:**
- Extend `useAppStore` in `ui/src/lib/store.ts`
- Use Zustand's `persist` middleware with `partialize`
- Key pattern: `{pageName}{PreferenceName}` (e.g., `servicesShowUpdatesOnly`)

### 2. Information Hierarchy
Dashboard and list pages should follow clear hierarchy:
1. **Alerts/Actions first** - Things requiring attention
2. **Summary cards** - High-level counts and status
3. **Primary content** - Main data (services, health grid)
4. **Secondary content** - Updates, activity, detailed tables

Avoid overloading pages with redundant data - link to detail pages instead.

### 3. Consistent Patterns
- **Page titles**: Do NOT add `<h1>` titles in pages - titles are shown in breadcrumbs (TopBar). Pages should only have a description paragraph (`<p className="text-slate-400">`). Detail pages show the item name as styled text (`<span className="text-xl font-bold">`), not `<h1>`.
- **Filters**: Use segmented buttons for time ranges, checkboxes for boolean filters
- **Status colors**: Always use `ui/src/lib/status.ts` utilities
- **Dismissible items**: Alerts/notifications should be dismissible (session-only)
- **Loading states**: Use skeleton placeholders, not spinners
- **Tabs**: Use underline style with `border-brand-600 text-white` for active state

### 4. State Management Rules
- **Page-local state**: Only for truly ephemeral UI (modal open, hover states)
- **Zustand store**: For anything that should survive navigation
- **Session storage**: For dismissals that should reset on browser close

### 5. List Page Patterns

All list pages should follow consistent patterns for layout, navigation, and actions.

#### Card Layout (Standard for most lists)

Use this structure for Servers, Databases, Registries, and similar resource lists:

```tsx
<div className="panel">
  <div className="flex items-start justify-between">
    <div className="flex items-start gap-4">
      {/* Icon container */}
      <div className="p-3 bg-slate-800 rounded-lg">
        <ResourceIcon className="w-6 h-6 text-primary-400" />
      </div>
      <div>
        {/* Row 1: Name + badges */}
        <div className="flex items-center gap-2 flex-wrap">
          <Link to={`/resource/${item.id}`} className="text-lg font-semibold text-white hover:text-primary-400">
            {item.name}
          </Link>
          <span className="badge bg-green-500/20 text-green-400 text-xs">status</span>
          <span className="badge bg-slate-700 text-slate-300 text-xs">type</span>
        </div>
        {/* Row 2: Subtitle (monospace for technical info) */}
        <p className="text-slate-400 text-sm mt-1 font-mono">{item.technicalInfo}</p>
        {/* Row 3: Metadata */}
        <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
          <span>Count info</span>
          <span>Timestamp info</span>
        </div>
      </div>
    </div>
    {/* Action buttons */}
    <div className="flex gap-2">
      <button className="btn btn-ghost text-sm">Secondary</button>
      <button className="btn btn-primary text-sm">Primary</button>
    </div>
  </div>
</div>
```

#### Table Layout (For dense tabular data)

Use tables when showing many columns of comparable data where rows need side-by-side comparison:

```tsx
<table className="w-full">
  <thead>
    <tr className="text-left text-slate-400 text-sm border-b border-slate-700">
      <th className="pb-3 font-medium">Name</th>
      {/* More columns... */}
    </tr>
  </thead>
  <tbody className="divide-y divide-slate-700">
    <tr className="text-slate-300">
      <td className="py-4">
        <Link to={`/item/${id}`} className="text-white hover:text-primary-400 font-medium">
          {name}
        </Link>
      </td>
    </tr>
  </tbody>
</table>
```

**Note:** Prefer card layout for most lists. Tables are best for audit logs, health check history, and similar dense data.

#### Navigation Rules

- **If page has a detail view**: Make the item name a `<Link>` - do NOT add a separate "View" button
- **If page uses modals only**: Use action buttons (Edit, Delete) without navigation links
- **Never have both**: A clickable name AND a "View" button (redundant)

#### Action Button Conventions (Hybrid Pattern)

Action buttons use a hybrid pattern: context-specific actions as text buttons, standard actions as icon-only buttons.

**Hybrid Layout:**
```tsx
<div className="flex items-center gap-2">
  {/* Context-specific: text buttons */}
  <button className="btn btn-primary text-sm">Deploy latest</button>
  <button className="btn btn-ghost text-sm">Discover</button>

  {/* Standard actions: icon-only buttons */}
  <button className="p-1.5 text-slate-400 hover:text-white rounded" title="View">
    <EyeIcon className="w-4 h-4" />
  </button>
  <button className="p-1.5 text-slate-400 hover:text-white rounded" title="Edit">
    <PencilIcon className="w-4 h-4" />
  </button>
  <button className="p-1.5 text-slate-400 hover:text-red-400 rounded" title="Delete">
    <TrashIcon className="w-4 h-4" />
  </button>
</div>
```

**What goes where:**

| Action Type | Style | Examples |
|-------------|-------|----------|
| Primary/context-specific | Text button (`btn btn-primary`) | Deploy, Backup, Check Updates |
| Secondary context-specific | Text button (`btn btn-ghost`) | Discover, View Services, Reveal/Hide |
| View (detail page) | Icon-only (`EyeIcon`) | View database, View details |
| Edit | Icon-only (`PencilIcon`) | Edit settings, Edit config |
| Delete | Icon-only (`TrashIcon`, red hover) | Delete resource |
| Health Check | Icon-only (`HeartPulseIcon`) | Server/service health check |

**Icon Button Styling:**
```tsx
{/* Standard icon button */}
<button className="p-1.5 text-slate-400 hover:text-white rounded" title="Edit">
  <PencilIcon className="w-4 h-4" />
</button>

{/* Destructive icon button */}
<button className="p-1.5 text-slate-400 hover:text-red-400 rounded" title="Delete">
  <TrashIcon className="w-4 h-4" />
</button>
```

**Important:** Always include `title` attribute on icon-only buttons for accessibility.

#### Status Badges

Use consistent badge styling:
```tsx
// Success/Healthy
<span className="badge bg-green-500/20 text-green-400 text-xs">healthy</span>

// Warning/Pending
<span className="badge bg-yellow-500/20 text-yellow-400 text-xs">pending</span>

// Error/Unhealthy
<span className="badge bg-red-500/20 text-red-400 text-xs">unhealthy</span>

// Neutral/Info
<span className="badge bg-slate-700 text-slate-300 text-xs">type</span>

// Special (e.g., Host, Default)
<span className="badge bg-purple-500/20 text-purple-400 text-xs">Host</span>
```

#### Empty States

Always use the `EmptyState` component with an icon:
```tsx
<EmptyState
  icon={ResourceIcon}
  message="No items configured"
  description="Add an item to get started"
  action={{ label: 'Add Your First Item', onClick: () => setShowCreate(true) }}
/>
```

#### Pagination

- Use `usePagination` hook with `defaultPageSize: 25`
- Place `<Pagination>` component after the list
- Only show pagination when there are items

#### Reference Implementations

- **Card layout**: `Services.tsx`, `Servers.tsx`, `Databases.tsx`, `Registries.tsx`, `Secrets.tsx`
- **Table layout**: Health check logs, audit logs (dense tabular data)
- **Grid layout**: `ConfigFiles.tsx` (special case for compact items)
