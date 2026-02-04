# BridgePort

**Dock. Run. Ship. Repeat.**

A lightweight, self-hosted deployment management tool for Docker-based infrastructure.

Created by the Engineering Team at [BridgeIn](https://bridgein.pt).

## Features

- **Server Management** - Register servers, health checks, container discovery via SSH
- **Service Management** - Deploy, restart, and monitor Docker containers
- **Service Types** - Predefined commands for Django, Node.js, and custom service types
- **Registry Connections** - Connect to container registries with configurable refresh intervals and auto-linking
- **Auto-Update** - Automatic update checking and optional auto-deployment for services
- **Config File Management** - Store and sync configuration files to servers with edit history
- **Secret Management** - Encrypted secret storage with env template substitution and reveal controls
- **Database Backups** - PostgreSQL and SQLite backup management with scheduling and Spaces storage
- **Server Monitoring** - Real-time metrics via SSH polling or lightweight Go agent
- **Monitoring Hub** - Health check logs, metrics charts, agent management, SSH testing
- **User Management** - Role-based access control (Admin, Operator, Viewer), session tracking
- **Self-Service Account** - All users can update profile and change password via sidebar
- **Audit Logging** - Track all deployments and configuration changes
- **System Settings** - Configurable timeouts, retry policies, and operational limits
- **CLI Tool** - Command-line interface for SSH, logs, exec, and server management
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
      # Optional: Mount SSH key for host management (set via UI instead if preferred)
      # - ~/.ssh/id_rsa:/root/.ssh/id_rsa:ro
```

> **Note**: SSH keys for server access should be configured via the Settings page in the UI. The key is encrypted and stored in the database. The file mount above is only needed if you prefer to use a file-based key.

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
├── cli/                       # Go command-line interface
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

#### Managing the Docker Host

When BridgePort runs inside a Docker container, it can manage services on its host machine using SSH through the Docker gateway IP. This allows full management capabilities including deployments, config syncing, and metrics collection.

**Prerequisites:**
1. SSH server running on the host
2. SSH connections allowed from Docker network (`172.17.0.0/16`)
3. The same SSH key used for remote servers authorized on the host

**Setup:**
1. Go to **Servers** page - a detection banner appears if the host is reachable
2. Click **Add Host Server** to register it
3. The host is now manageable like any other server

**Alternative: Agent-Only Monitoring**

For monitoring-only (no deployment capabilities), you can extract and run the agent manually:

```bash
# Extract agent from BridgePort container
docker cp bridgeport:/app/agent/bridgeport-agent ./bridgeport-agent
chmod +x ./bridgeport-agent

# Run on host (get token from BridgePort UI after adding server)
./bridgeport-agent --server http://localhost:3000 --token <your-token>
```

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
- **Edit databases** - update connection details, credentials, and backup settings
- **Manual backups** - trigger on-demand via UI
- **Scheduled backups** - cron-based automatic backups
- **Retention policies** - automatic cleanup of old backups
- Backup storage on server filesystem or DO Spaces
- Download and restore capabilities

### Service Types
Predefined configurations for common service patterns:
- **Django** - Shell access, migrations, collectstatic commands
- **Node.js** - Shell access, common npm commands
- **Generic** - Basic shell access
- Custom service types can be created with any commands
- Assign service types to services for quick command execution via UI or CLI

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

### System Settings
Global operational parameters (admin-only):
- **SSH Timeouts** - Command and connection timeouts
- **Webhook Settings** - Max retries, timeout, retry delays
- **Backup Settings** - pg_dump timeout
- **Limits** - Max upload size, active user window, registry max tags, default log lines

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

### Health & Authentication
```bash
GET  /health               # Health check (returns status, timestamp, version)
POST /api/auth/login       # Login, returns JWT
GET  /api/auth/me          # Get current user
```

### Users
```bash
GET    /api/users                    # List users (admin only)
GET    /api/users/active             # List active users - online in last 15 min (admin only)
POST   /api/users                    # Create user (admin only)
PATCH  /api/users/:id                # Update user (admin or self)
DELETE /api/users/:id                # Delete user (admin only)
POST   /api/users/:id/change-password # Change password (admin or self, self requires current password)
```

### Environments
```bash
GET  /api/environments              # List environments
POST /api/environments              # Create environment
PUT  /api/environments/:id/ssh      # Upload SSH key
GET  /api/environments/:id/ssh-key  # Get SSH credentials (for CLI)
PUT  /api/environments/:id/settings # Update settings (reveal control, Spaces creds)
GET  /api/environments/:id/spaces/buckets  # List available Spaces buckets
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
POST  /api/services/:id/run-command   # Run predefined service type command
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

### Monitoring
```bash
GET  /api/monitoring/health-logs              # List health check logs (filterable)
GET  /api/monitoring/health-logs/:id          # Get single health log
GET  /api/monitoring/metrics-history          # Server/service metrics over time
POST /api/monitoring/test-ssh/:serverId       # Test SSH connectivity to server
```

### Settings (Admin)
```bash
# Service Types
GET    /api/settings/service-types            # List service types
POST   /api/settings/service-types            # Create service type
GET    /api/settings/service-types/:id        # Get service type
PATCH  /api/settings/service-types/:id        # Update service type
DELETE /api/settings/service-types/:id        # Delete service type
POST   /api/settings/service-types/:id/commands  # Add command to service type
DELETE /api/settings/service-types/:typeId/commands/:cmdId  # Remove command

# Global Spaces Configuration
GET    /api/settings/spaces                   # Get global Spaces config
PUT    /api/settings/spaces                   # Update global Spaces config
GET    /api/settings/spaces/environments      # List per-environment Spaces settings
PUT    /api/settings/spaces/environments/:id  # Update environment Spaces settings

# System Settings
GET    /api/settings/system                   # Get system settings
PATCH  /api/settings/system                   # Update system settings
POST   /api/settings/system/reset             # Reset to defaults
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

## Backing Up BridgePort

All BridgePort data is stored in a single SQLite database file, including:

- Server, service, and environment configurations
- Config files (text and binary, stored as base64)
- Secrets and SSH keys (encrypted)
- Audit logs and metrics history
- User accounts and backup schedules

### What to Backup

1. **Database file** - Location defined by `DATABASE_URL` (e.g., `/data/bridgeport.db`)
2. **MASTER_KEY** - Store securely and separately (password manager, secrets vault)

> **Warning**: Without the `MASTER_KEY`, encrypted data (secrets, SSH keys, registry credentials) cannot be decrypted. The database alone is not sufficient for a full restore.

### Backup Methods

**Simple file copy** (while BridgePort is stopped):
```bash
docker compose stop
cp /opt/bridgeport/data/bridgeport.db /backups/bridgeport-$(date +%Y%m%d).db
docker compose start
```

**SQLite online backup** (no downtime):
```bash
sqlite3 /opt/bridgeport/data/bridgeport.db ".backup '/backups/bridgeport-$(date +%Y%m%d).db'"
```

**Automated with cron**:
```bash
0 2 * * * sqlite3 /opt/bridgeport/data/bridgeport.db ".backup '/backups/bridgeport-$(date +\%Y\%m\%d).db'"
```

### Restoring

1. Stop BridgePort
2. Replace the database file with your backup
3. Ensure `MASTER_KEY` in `.env` matches the key used when the backup was created
4. Start BridgePort

```bash
docker compose stop
cp /backups/bridgeport-20250101.db /opt/bridgeport/data/bridgeport.db
docker compose start
```

## CLI Tool

BridgePort includes a command-line interface for managing infrastructure from the terminal.

### Installation

```bash
cd cli
make build
sudo mv bridgeport /usr/local/bin/
```

### Quick Start

```bash
# Authenticate
bridgeport login --url https://deploy.example.com

# List servers with metrics
bridgeport list

# SSH into a server
bridgeport ssh staging app-api

# View container logs
bridgeport logs staging app-api app-api -f

# Execute command in container
bridgeport exec staging app-api app-api -- python manage.py shell
```

### Commands

| Command | Description |
|---------|-------------|
| `login` | Authenticate with BridgePort |
| `list` | List all servers with metrics |
| `status <env> <server>` | Show detailed server info |
| `ssh <env> <server>` | SSH into a server |
| `exec <env> <server> <service>` | Execute command in container |
| `logs <env> <server> <service>` | View container logs |
| `run <env> <server> <service> <cmd>` | Run predefined service command |
| `completion` | Generate shell completions |

See [cli/README.md](cli/README.md) for full documentation.

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

# Build CLI (cross-platform)
cd cli && make build-all
```

## License

Copyright 2024-2025 BridgeIn. All rights reserved.
