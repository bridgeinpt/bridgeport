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
- **Encryption**: XChaCha20-Poly1305 for secrets
- **Monitoring Agent**: Go
- **CLI**: Go (Cobra framework)

## Project Structure

```
bridgeport/
├── src/                      # Backend
│   ├── server.ts             # Fastify entry point
│   ├── lib/                  # Core utilities
│   │   ├── config.ts         # Environment configuration
│   │   ├── crypto.ts         # Encryption utilities
│   │   ├── db.ts             # Prisma client
│   │   ├── docker.ts         # Docker client abstraction (socket + SSH)
│   │   ├── ssh.ts            # SSH client wrapper
│   │   └── scheduler.ts      # Background job scheduler
│   ├── routes/               # API routes
│   │   ├── auth.ts           # Authentication
│   │   ├── users.ts          # User management (RBAC)
│   │   ├── environments.ts   # Environment settings
│   │   ├── servers.ts        # Server management
│   │   ├── services.ts       # Container management
│   │   ├── secrets.ts        # Secret management + env templates
│   │   ├── config-files.ts   # Config files with history
│   │   ├── registries.ts     # Registry connections
│   │   ├── databases.ts      # Database backup management
│   │   ├── metrics.ts        # Server/service metrics
│   │   ├── monitoring.ts     # Health logs, metrics history, SSH testing
│   │   ├── settings.ts       # Service types CRUD
│   │   ├── spaces.ts         # Global Spaces configuration
│   │   ├── system-settings.ts # System-wide operational settings
│   │   ├── audit.ts          # Audit logs
│   │   └── webhooks.ts       # CI/CD webhooks
│   ├── services/             # Business logic
│   │   ├── metrics.ts        # SSH metrics collection
│   │   ├── database-backup.ts # Backup execution
│   │   ├── host-detection.ts # Docker host detection + bootstrap
│   │   ├── service-types.ts  # Service type utilities
│   │   ├── system-settings.ts # Cached system settings singleton
│   │   └── outgoing-webhooks.ts # Webhook delivery with retries
│   └── plugins/              # Fastify plugins
│       ├── authenticate.ts   # JWT authentication
│       └── authorize.ts      # RBAC middleware
├── ui/                       # Frontend (React + Vite)
│   ├── src/
│   │   ├── components/       # Reusable components
│   │   │   └── Layout.tsx    # Navigation sidebar with env selector
│   │   ├── pages/            # Page components
│   │   │   ├── Dashboard.tsx # Overview with server metrics
│   │   │   ├── Monitoring.tsx # Metrics overview with charts
│   │   │   ├── MonitoringHealth.tsx # Health check logs
│   │   │   ├── MonitoringAgents.tsx # Agent management, SSH testing
│   │   │   ├── Servers.tsx   # Server list
│   │   │   ├── ServerDetail.tsx # Server config + monitoring
│   │   │   ├── Services.tsx  # Service list
│   │   │   ├── ServiceDetail.tsx # Service deploy + health checks
│   │   │   ├── Databases.tsx # Database list
│   │   │   ├── DatabaseDetail.tsx # Database config + backups
│   │   │   ├── Settings.tsx  # Environment settings + scheduler config
│   │   │   ├── settings/
│   │   │   │   ├── ServiceTypes.tsx # Service type management
│   │   │   │   ├── GlobalSpaces.tsx # Global Spaces configuration
│   │   │   │   └── SystemSettings.tsx # System-wide settings
│   │   │   └── ...           # Other pages
│   │   └── lib/              # API client, store
│   └── public/               # Static assets
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
├── prisma/schema.prisma      # Database schema
└── docker/                   # Docker configuration
```

## Development Commands

```bash
# Install dependencies
npm install
cd ui && npm install && cd ..

# Generate Prisma client (required after schema changes)
npm run db:generate

# Run migrations
npm run db:push

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

## Versioning

BridgePort uses git-based versioning derived at build time:

- **App version**: `YYYYMMDD-{7-char SHA}` from current commit (passed as `APP_VERSION` build arg)
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
Secrets are encrypted with XChaCha20-Poly1305. Use `src/lib/crypto.ts`:

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

## Environment Variables

Required for development:

```bash
DATABASE_URL=file:./dev.db
MASTER_KEY=<openssl rand -base64 32>
JWT_SECRET=<openssl rand -base64 32>
```

Optional scheduler settings:

```bash
SCHEDULER_ENABLED=true
SCHEDULER_METRICS_INTERVAL=300      # SSH metrics collection (seconds)
SCHEDULER_BACKUP_CHECK_INTERVAL=60  # Backup schedule check (seconds)
```

## Key Models

```
User           - Authentication with role (admin/operator/viewer), lastActiveAt for session tracking
Environment    - Logical grouping with SSH key, allowSecretReveal, schedulerConfig (per-env scheduler)
Server         - Physical/virtual machine with metricsMode, dockerMode (ssh/socket)
Service        - Docker container with optional serviceTypeId
Secret         - Encrypted key-value with neverReveal flag
ConfigFile     - Synced configuration files (including .env files with secret placeholders)
FileHistory    - Edit history for config files
Database       - Registered database for backups (editable after creation)
DatabaseBackup - Backup record with status
BackupSchedule - Cron-based backup scheduling
ServerMetrics  - Time-series server metrics
ServiceMetrics - Time-series container metrics
RegistryConnection - Container registry with refreshIntervalMinutes, autoLinkPattern
HealthCheckLog - Health check results with duration, status, response details

# Global Settings
ServiceType        - Predefined service types (Django, Node.js, etc.) with commands
ServiceTypeCommand - Commands for a service type (shell, migrate, etc.)
SpacesConfig       - Global DO Spaces credentials
SpacesEnvironment  - Per-environment Spaces enable/disable
SystemSettings     - System-wide operational settings (timeouts, limits, retries)
```

## UI Features

### Navigation
- **Clickable Logo**: Click sidebar logo to navigate to dashboard
- **My Account Modal**: Click user icon in sidebar to access profile and password change (all users)

### Server Management
- **Monitoring Card**: Configure metrics mode (disabled/SSH/agent), view real-time metrics
- **Create Service**: Manually create services before containers exist
- **Discover Containers**: Auto-discover running Docker containers

### Service Management
- **Deploy**: Deploy new image tags with pull
- **Health Checks**: Manual health checks with detailed results (container + URL)
- **Health Check History**: View past health check results from audit log
- **Deployment History**: View past deployments with expandable logs
- **Config Files**: Attach and sync config files to servers

### Database Management
- **Edit Databases**: Edit existing database configurations (name, connection, backup settings)
- **Backup Management**: View, create, and delete backups with schedule configuration

### User Management (Admin)
- **Active Users**: Shows which users are currently online (active in last 15 minutes)
- **Session Tracking**: lastActiveAt updated on each authenticated request

### Monitoring Hub (`/monitoring/*`)
- **Overview** (`/monitoring`): Environment-wide metrics with time-series charts (Recharts)
- **Health Checks** (`/monitoring/health`): Filterable health check logs with pagination
- **Agents** (`/monitoring/agents`): Agent management, SSH connectivity testing, upgrade indicators
- Auto-refresh every 30 seconds

### Agent Upgrade Indicators
- Server detail page shows "Update available" badge when deployed agent differs from bundled version
- Monitoring Agents page shows upgrade status column for all agents
- Bundled agent version exposed via `/health` and agent status API

### Global Settings (`/settings/*`)
- **System** (`/settings/system`): SSH timeouts, webhook retries, backup timeouts, limits
- **Service Types** (`/settings/service-types`): Manage predefined service types and commands
- **Spaces** (`/settings/spaces`): Global DO Spaces config with per-environment toggles

### About Page
- App version displayed (baked in at build time via Vite)
- CLI tool downloads with version info and file sizes
- Links to all supported platforms (macOS Intel/Silicon, Linux x64/ARM64)

## Important Notes

- BridgePort is designed to be a **generic tool** - avoid BridgeIn-specific code
- All secrets must be encrypted at rest
- SSH keys are stored encrypted per-environment
- Audit logging is required for sensitive operations
- File edits automatically save to history for rollback
- Agent tokens are per-server, generated when enabling agent mode
- System settings use a cached singleton pattern - call `getSystemSettings()` for current values
- Health check logs are stored in `HealthCheckLog` with automatic cleanup based on retention settings

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
