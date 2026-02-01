# BridgePort

A lightweight, self-hosted deployment management tool for Docker-based infrastructure.

## Tech Stack

- **Backend**: Node.js, Fastify, TypeScript
- **Frontend**: React, Vite, Tailwind CSS
- **Database**: SQLite with Prisma ORM
- **Encryption**: XChaCha20-Poly1305 for secrets
- **Monitoring Agent**: Go

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
│   │   ├── audit.ts          # Audit logs
│   │   └── webhooks.ts       # CI/CD webhooks
│   ├── services/             # Business logic
│   │   ├── metrics.ts        # SSH metrics collection
│   │   └── database-backup.ts # Backup execution
│   └── plugins/              # Fastify plugins
│       ├── authenticate.ts   # JWT authentication
│       └── authorize.ts      # RBAC middleware
├── ui/                       # Frontend (React + Vite)
│   ├── src/
│   │   ├── components/       # Reusable components
│   │   │   └── Layout.tsx    # Navigation sidebar with env selector
│   │   ├── pages/            # Page components
│   │   │   ├── Dashboard.tsx # Overview with server metrics
│   │   │   ├── Monitoring.tsx # Dedicated monitoring dashboard
│   │   │   ├── Servers.tsx   # Server list
│   │   │   ├── ServerDetail.tsx # Server config + monitoring
│   │   │   ├── Services.tsx  # Service list
│   │   │   ├── ServiceDetail.tsx # Service deploy + health checks
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
User          - Authentication with role (admin/operator/viewer)
Environment   - Logical grouping with SSH key, allowSecretReveal setting
Server        - Physical/virtual machine with metricsMode (ssh/agent/disabled)
Service       - Docker container
Secret        - Encrypted key-value with neverReveal flag
EnvTemplate   - Template for .env generation
ConfigFile    - Synced configuration files
FileHistory   - Edit history for config files and env templates
Database      - Registered database for backups
DatabaseBackup - Backup record with status
BackupSchedule - Cron-based backup scheduling
ServerMetrics  - Time-series server metrics
ServiceMetrics - Time-series container metrics
RegistryConnection - Container registry with refreshIntervalMinutes, autoLinkPattern
```

## UI Features

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

### Monitoring Dashboard (`/monitoring`)
- Environment-wide server metrics overview
- Service resource usage table sorted by CPU
- Auto-refresh every 30 seconds

## Important Notes

- BridgePort is designed to be a **generic tool** - avoid BridgeIn-specific code
- All secrets must be encrypted at rest
- SSH keys are stored encrypted per-environment
- Audit logging is required for sensitive operations
- File edits automatically save to history for rollback
- Agent tokens are per-server, generated when enabling agent mode
