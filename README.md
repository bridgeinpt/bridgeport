# BridgePort

**Dock. Run. Ship. Repeat.**

A lightweight, self-hosted deployment management tool for Docker-based infrastructure.

Created by the Engineering Team at [BridgeIn](https://bridgein.pt).

## Features

- **Server Management** - Register servers, health checks, container discovery via SSH
- **Service Management** - Deploy, restart, and monitor Docker containers
- **Registry Connections** - Connect to container registries with configurable refresh intervals and auto-linking
- **Auto-Update** - Automatic update checking and optional auto-deployment for services
- **Config File Management** - Store and sync configuration files to servers with edit history
- **Secret Management** - Encrypted secret storage with env template substitution and reveal controls
- **Database Backups** - PostgreSQL and SQLite backup management with scheduling
- **Server Monitoring** - Real-time metrics via SSH polling or lightweight Go agent
- **User Management** - Role-based access control (Admin, Operator, Viewer)
- **Audit Logging** - Track all deployments and configuration changes
- **Web UI** - Dashboard with metrics, deployment management, and monitoring

## Quick Start

### Using Docker

```bash
mkdir -p /opt/bridgeport && cd /opt/bridgeport
```

Create `.env`:

```bash
DATABASE_URL=file:/data/bridgeport.db
MASTER_KEY=<run: openssl rand -base64 32>
JWT_SECRET=<run: openssl rand -base64 32>
HOST=0.0.0.0
PORT=3000
NODE_ENV=production

# Initial admin user (created on first boot)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-secure-password
```

Create `docker-compose.yml`:

```yaml
version: '3.8'
services:
  bridgeport:
    image: your-registry/bridgeport:latest
    container_name: bridgeport
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - ./data:/data
```

Start (admin user created automatically on first boot):

```bash
docker compose up -d
```

### Development

```bash
# Install dependencies
npm install
cd ui && npm install && cd ..

# Generate Prisma client
npm run db:generate
```

Create `.env`:

```bash
DATABASE_URL=file:./dev.db
MASTER_KEY=<run: openssl rand -base64 32>
JWT_SECRET=<run: openssl rand -base64 32>
```

Run:

```bash
# Run migrations
npm run db:push

# Start backend
npm run dev

# Start frontend (separate terminal)
cd ui && npm run dev
```

## Architecture

```
bridgeport/
├── src/
│   ├── server.ts              # Fastify application
│   ├── lib/
│   │   ├── config.ts          # Environment configuration
│   │   ├── crypto.ts          # XChaCha20-Poly1305 encryption
│   │   ├── db.ts              # Prisma client
│   │   ├── ssh.ts             # SSH client wrapper
│   │   └── scheduler.ts       # Background job scheduler
│   ├── routes/
│   │   ├── auth.ts            # Authentication
│   │   ├── users.ts           # User management (RBAC)
│   │   ├── environments.ts    # Environment management
│   │   ├── servers.ts         # Server management
│   │   ├── services.ts        # Service/container management
│   │   ├── secrets.ts         # Secret management
│   │   ├── config-files.ts    # Config file management with history
│   │   ├── registries.ts      # Registry connection management
│   │   ├── databases.ts       # Database backup management
│   │   ├── metrics.ts         # Server/service metrics
│   │   ├── audit.ts           # Audit logs
│   │   └── webhooks.ts        # CI/CD webhooks
│   ├── services/
│   │   ├── metrics.ts         # Metrics collection logic
│   │   └── database-backup.ts # Backup execution logic
│   └── plugins/
│       ├── authenticate.ts    # JWT authentication
│       └── authorize.ts       # RBAC middleware
├── ui/                        # React frontend (Vite + Tailwind)
├── bridgeport-agent/          # Go monitoring agent
├── prisma/schema.prisma       # Database schema
└── docker/                    # Docker configuration
```

## Core Concepts

### User Roles

BridgePort uses a three-tier role system:

| Role | Permissions |
|------|-------------|
| **Admin** | Full access: user management, environment creation, all operations |
| **Operator** | Deploy, restart, manage secrets/files/databases. No user management |
| **Viewer** | Read-only access to all resources |

### Environments
Logical groupings of servers (e.g., staging, production). Each environment has:
- Its own SSH key for server access
- Isolated secrets with optional reveal restrictions
- Isolated config files and databases
- Optional DO Spaces credentials for backups

### Servers
Physical or virtual machines registered in an environment. BridgePort connects via SSH to:
- Discover running containers
- Execute deployments
- Sync configuration files
- Check health status
- Collect metrics (if SSH polling enabled)

### Services
Docker containers running on servers. For each service you can:
- Deploy new image versions
- Restart containers
- View logs
- Configure health checks
- Attach configuration files
- Enable auto-update from connected registries
- View resource metrics

### Registry Connections
Container registry connections for automatic update checking:
- **DigitalOcean Registry** - API-based tag listing
- **Docker Hub** - Hub API integration
- **Generic** - Standard Docker Registry V2 API (Harbor, GitLab, etc.)

Features:
- Encrypted credential storage
- Per-registry refresh intervals (default: 30 minutes)
- Auto-link patterns for automatic service discovery
- "Update available" notifications in UI
- Optional auto-deployment when updates are found
- Digest-based comparison for "latest" tag updates

### Config Files
Configuration files (docker-compose.yml, nginx.conf, certificates, etc.) stored in the database and synced to servers:
- Create and edit files in the web UI
- **Edit history** with version tracking and restore capability
- Attach files to services with target paths
- One-click sync to push files to servers via SSH

### Secrets
Encrypted key-value pairs for sensitive configuration:
- Encrypted at rest with XChaCha20-Poly1305
- Per-environment isolation
- **Per-environment reveal control** - disable secret viewing for production
- **Write-only secrets** - secrets that can never be revealed after creation
- Audit logging for access

### Env Templates
Templates for generating environment files with secret substitution:
```
DATABASE_URL=${DATABASE_URL}
API_KEY=${API_KEY}
DEBUG=false
```

Templates also support **edit history** with version tracking and restore.

### Database Backups
Manage PostgreSQL and SQLite database backups:
- Register databases with encrypted credentials
- **Manual backups** - trigger on-demand via UI
- **Scheduled backups** - cron-based automatic backups
- **Retention policies** - automatic cleanup of old backups
- Backup storage on server filesystem
- Download and restore capabilities

### Server Monitoring
Two methods for collecting server and container metrics:

| Method | Description | Use Case |
|--------|-------------|----------|
| **SSH Polling** | BridgePort collects metrics via SSH commands | Simple setup, no agent needed |
| **Go Agent** | Lightweight agent pushes metrics to BridgePort | Real-time, lower latency, efficient |

Metrics collected:
- CPU usage, memory usage, disk usage
- Load averages, uptime
- Per-container CPU and memory
- Container restart counts

## Monitoring Agent

The BridgePort Agent is a lightweight Go binary that runs on monitored servers and pushes metrics to BridgePort.

### Installation

1. Enable agent mode for the server in BridgePort UI (Server Settings > Metrics Mode > Agent)
2. Copy the generated agent token
3. Install the agent on the server:

```bash
# Download the agent binary
curl -L https://your-bridgeport/downloads/bridgeport-agent -o /usr/local/bin/bridgeport-agent
chmod +x /usr/local/bin/bridgeport-agent

# Create systemd service
cat > /etc/systemd/system/bridgeport-agent.service << 'EOF'
[Unit]
Description=BridgePort Monitoring Agent
After=network.target docker.service

[Service]
Type=simple
Environment="BRIDGEPORT_SERVER=https://deploy.example.com"
Environment="BRIDGEPORT_TOKEN=your-agent-token-here"
ExecStart=/usr/local/bin/bridgeport-agent
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
systemctl daemon-reload
systemctl enable bridgeport-agent
systemctl start bridgeport-agent
```

### Agent Configuration

| Flag/Env Var | Description | Default |
|--------------|-------------|---------|
| `-server` / `BRIDGEPORT_SERVER` | BridgePort server URL | Required |
| `-token` / `BRIDGEPORT_TOKEN` | Agent authentication token | Required |
| `-interval` | Collection interval | 30s |

### Internal Networking

The agent can use internal/private IPs to communicate with BridgePort. This is **recommended** for security and performance:

```bash
# Instead of public URL:
Environment="BRIDGEPORT_SERVER=https://deploy.example.com"

# Use internal VPC IP (if BridgePort is in the same VPC or peered VPC):
Environment="BRIDGEPORT_SERVER=http://10.30.10.5:3000"
```

Benefits of internal networking:
- **Security**: Traffic stays within private network
- **Performance**: Lower latency, no egress costs
- **Reliability**: No dependency on public DNS/internet

If using internal IPs, ensure:
- BridgePort's `HOST` is bound to `0.0.0.0` (not `127.0.0.1`)
- VPC peering is configured if servers are in different VPCs
- Firewall rules allow traffic on port 3000 from agent servers

### Building the Agent

```bash
cd bridgeport-agent
make build           # Build for current platform
make build-linux     # Cross-compile for Linux amd64
```

### Data Retention

Metrics are automatically cleaned up based on the `METRICS_RETENTION_DAYS` setting (default: 7 days). The cleanup job runs hourly.

For typical deployments:
- 10 servers × 5 services each × 2 metrics/min × 7 days ≈ 1M records
- With SQLite, this is ~100MB of storage

Adjust retention based on your needs:
```bash
METRICS_RETENTION_DAYS=3   # Smaller deployments, less history
METRICS_RETENTION_DAYS=30  # Larger storage, more history
```

## API Reference

### Authentication
```bash
POST /api/auth/login       # Login, returns JWT
GET  /api/auth/me          # Get current user
```

### Users (Admin only)
```bash
GET    /api/users              # List users
POST   /api/users              # Create user
PATCH  /api/users/:id          # Update user
DELETE /api/users/:id          # Delete user
POST   /api/users/:id/password # Change password
```

### Environments
```bash
GET  /api/environments              # List environments
POST /api/environments              # Create environment
PUT  /api/environments/:id/ssh      # Upload SSH key
PUT  /api/environments/:id/settings # Update settings (reveal control, Spaces creds)
```

### Servers
```bash
GET  /api/environments/:envId/servers           # List servers
POST /api/environments/:envId/servers           # Create server
POST /api/servers/:id/health                    # Health check
POST /api/servers/:id/discover                  # Discover containers
GET  /api/servers/:id/metrics                   # Get server metrics
POST /api/environments/:envId/servers/import-terraform  # Import from Terraform
```

### Services
```bash
GET   /api/services/:id               # Get service details
PATCH /api/services/:id               # Update configuration
POST  /api/services/:id/deploy        # Deploy new version
POST  /api/services/:id/restart       # Restart container
POST  /api/services/:id/health        # Health check
GET   /api/services/:id/logs          # Get logs
GET   /api/services/:id/metrics       # Get container metrics
POST  /api/services/:id/check-updates # Check for image updates
```

### Registry Connections
```bash
GET    /api/environments/:envId/registries      # List registries
POST   /api/environments/:envId/registries      # Create registry connection
GET    /api/registries/:id                      # Get registry details
PATCH  /api/registries/:id                      # Update (incl. refresh interval, auto-link)
DELETE /api/registries/:id                      # Delete registry
POST   /api/registries/:id/test                 # Test connection
GET    /api/registries/:id/repositories         # List repositories
GET    /api/registries/:id/repositories/:repo/tags  # List tags
```

### Config Files
```bash
GET    /api/environments/:envId/config-files   # List config files
POST   /api/environments/:envId/config-files   # Create config file
GET    /api/config-files/:id                   # Get with content
PATCH  /api/config-files/:id                   # Update (saves history)
DELETE /api/config-files/:id                   # Delete
GET    /api/config-files/:id/history           # Get edit history
POST   /api/config-files/:id/restore/:historyId # Restore version
GET    /api/services/:id/files                 # List attached files
POST   /api/services/:id/files                 # Attach file
DELETE /api/services/:serviceId/files/:fileId  # Detach file
POST   /api/services/:id/sync-files            # Sync to server
```

### Secrets
```bash
GET    /api/environments/:envId/secrets   # List secrets
POST   /api/environments/:envId/secrets   # Create secret (incl. neverReveal flag)
GET    /api/secrets/:id/value             # Get decrypted value (if allowed)
PATCH  /api/secrets/:id                   # Update
DELETE /api/secrets/:id                   # Delete
```

### Env Templates
```bash
GET    /api/environments/:envId/env-templates        # List templates
POST   /api/environments/:envId/env-templates        # Create template
GET    /api/env-templates/:id                        # Get with content
PATCH  /api/env-templates/:id                        # Update (saves history)
DELETE /api/env-templates/:id                        # Delete
GET    /api/env-templates/:id/history                # Get edit history
POST   /api/env-templates/:id/restore/:historyId    # Restore version
POST   /api/env-templates/:id/generate               # Generate with secrets
```

### Databases
```bash
GET    /api/environments/:envId/databases    # List databases
POST   /api/environments/:envId/databases    # Register database
GET    /api/databases/:id                    # Get database details
PATCH  /api/databases/:id                    # Update database
DELETE /api/databases/:id                    # Delete database
POST   /api/databases/:id/test               # Test connection
POST   /api/databases/:id/backup             # Trigger manual backup
GET    /api/databases/:id/backups            # List backups
PUT    /api/databases/:id/schedule           # Set backup schedule
GET    /api/backups/:id/download             # Download backup file
POST   /api/backups/:id/restore              # Restore from backup
DELETE /api/backups/:id                      # Delete backup
```

### Metrics
```bash
GET  /api/servers/:id/metrics                    # Server metrics history
GET  /api/services/:id/metrics                   # Service metrics history
GET  /api/environments/:envId/metrics/summary    # Environment metrics summary
POST /api/metrics/ingest                         # Agent metrics push endpoint
```

### Webhooks
```bash
POST /api/webhooks/deploy   # Deployment webhook for CI/CD
```

## Configuration

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `DATABASE_URL` | SQLite database path | Yes | - |
| `MASTER_KEY` | 32-byte base64 encryption key | Yes | - |
| `JWT_SECRET` | JWT signing secret | Yes | - |
| `HOST` | Server host | No | 0.0.0.0 |
| `PORT` | Server port | No | 3000 |
| `ADMIN_EMAIL` | Initial admin email | No | - |
| `ADMIN_PASSWORD` | Initial admin password (min 8 chars) | No | - |
| `SCHEDULER_ENABLED` | Enable background jobs | No | true |
| `SCHEDULER_SERVER_HEALTH_INTERVAL` | Server health check (seconds) | No | 60 |
| `SCHEDULER_SERVICE_HEALTH_INTERVAL` | Service health check (seconds) | No | 60 |
| `SCHEDULER_DISCOVERY_INTERVAL` | Container discovery (seconds) | No | 300 |
| `SCHEDULER_UPDATE_CHECK_INTERVAL` | Registry update check (seconds) | No | 1800 |
| `SCHEDULER_METRICS_INTERVAL` | Metrics collection (seconds) | No | 300 |
| `SCHEDULER_BACKUP_CHECK_INTERVAL` | Backup schedule check (seconds) | No | 60 |
| `AGENT_CALLBACK_URL` | Internal URL for agent to reach BridgePort | No* | - |

\* Required for automatic agent deployment. Set to BridgePort's internal/VPC IP (e.g., `http://10.30.10.5:3000`).

## Security

- **Encryption**: Secrets encrypted with XChaCha20-Poly1305
- **Authentication**: JWT tokens with bcrypt password hashing
- **Authorization**: Role-based access control (Admin/Operator/Viewer)
- **SSH**: Per-environment encrypted SSH keys
- **Audit**: All sensitive actions logged
- **Secret Reveal Control**: Per-environment and per-secret visibility restrictions

## Building

```bash
# Build backend
npm run build

# Build frontend
cd ui && npm run build

# Build Docker image
docker build -f docker/Dockerfile -t bridgeport .

# Build monitoring agent
cd bridgeport-agent && make build-linux
```

## License

Copyright 2024-2025 BridgeIn. All rights reserved.
