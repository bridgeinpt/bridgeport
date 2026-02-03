# BridgePort

A lightweight, self-hosted deployment management tool for Docker-based infrastructure.

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
Server         - Physical/virtual machine with metricsMode (ssh/agent/disabled)
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
- **Agents** (`/monitoring/agents`): Agent management, SSH connectivity testing
- Auto-refresh every 30 seconds

### Global Settings (`/settings/*`)
- **System** (`/settings/system`): SSH timeouts, webhook retries, backup timeouts, limits
- **Service Types** (`/settings/service-types`): Manage predefined service types and commands
- **Spaces** (`/settings/spaces`): Global DO Spaces config with per-environment toggles

### About Page
- Dynamic version display fetched from `/health` endpoint

## Important Notes

- BridgePort is designed to be a **generic tool** - avoid BridgeIn-specific code
- All secrets must be encrypted at rest
- SSH keys are stored encrypted per-environment
- Audit logging is required for sensitive operations
- File edits automatically save to history for rollback
- Agent tokens are per-server, generated when enabling agent mode
- System settings use a cached singleton pattern - call `getSystemSettings()` for current values
- Health check logs are stored in `HealthCheckLog` with automatic cleanup based on retention settings
