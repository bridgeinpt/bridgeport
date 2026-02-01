# BridgePort

**Dock. Run. Ship. Repeat.**

A lightweight, self-hosted deployment management tool for Docker-based infrastructure.

Created by the Engineering Team at [BridgeIn](https://bridgein.pt).

## Features

- **Server Management** - Register servers, health checks, container discovery via SSH
- **Service Management** - Deploy, restart, and monitor Docker containers
- **Registry Connections** - Connect to container registries (DigitalOcean, Docker Hub, generic)
- **Auto-Update** - Automatic update checking and optional auto-deployment for services
- **Config File Management** - Store and sync configuration files to servers
- **Secret Management** - Encrypted secret storage with env template substitution
- **Audit Logging** - Track all deployments and configuration changes
- **Web UI** - Dashboard for managing deployments, viewing logs, and monitoring

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
│   │   └── ssh.ts             # SSH client wrapper
│   ├── routes/                # API routes
│   │   ├── auth.ts            # Authentication
│   │   ├── environments.ts    # Environment management
│   │   ├── servers.ts         # Server management
│   │   ├── services.ts        # Service/container management
│   │   ├── secrets.ts         # Secret management
│   │   ├── config-files.ts    # Config file management
│   │   ├── registries.ts      # Registry connection management
│   │   ├── audit.ts           # Audit logs
│   │   └── webhooks.ts        # CI/CD webhooks
│   └── services/              # Business logic
├── ui/                        # React frontend (Vite + Tailwind)
├── prisma/schema.prisma       # Database schema
└── docker/                    # Docker configuration
```

## Core Concepts

### Environments
Logical groupings of servers (e.g., staging, production). Each environment has:
- Its own SSH key for server access
- Isolated secrets
- Isolated config files

### Servers
Physical or virtual machines registered in an environment. BridgePort connects via SSH to:
- Discover running containers
- Execute deployments
- Sync configuration files
- Check health status

### Services
Docker containers running on servers. For each service you can:
- Deploy new image versions
- Restart containers
- View logs
- Configure health checks
- Attach configuration files
- Enable auto-update from connected registries

### Registry Connections
Container registry connections for automatic update checking:
- **DigitalOcean Registry** - API-based tag listing
- **Docker Hub** - Hub API integration
- **Generic** - Standard Docker Registry V2 API (Harbor, GitLab, etc.)

Features:
- Encrypted credential storage
- Periodic update checking (configurable interval)
- "Update available" notifications in UI
- Optional auto-deployment when updates are found
- Digest-based comparison for "latest" tag updates

### Config Files
Configuration files (docker-compose.yml, nginx.conf, certificates, etc.) stored in the database and synced to servers:
- Create and edit files in the web UI
- Attach files to services with target paths
- One-click sync to push files to servers via SSH

### Secrets
Encrypted key-value pairs for sensitive configuration:
- Encrypted at rest with XChaCha20-Poly1305
- Per-environment isolation
- Audit logging for access

### Env Templates
Templates for generating environment files with secret substitution:
```
DATABASE_URL=${DATABASE_URL}
API_KEY=${API_KEY}
DEBUG=false
```

## API Reference

### Authentication
```bash
POST /api/auth/login       # Login, returns JWT
GET  /api/auth/me          # Get current user
```

Note: Initial admin user is created from `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars on first boot.

### Environments
```bash
GET  /api/environments              # List environments
POST /api/environments              # Create environment
PUT  /api/environments/:id/ssh      # Upload SSH key
```

### Servers
```bash
GET  /api/environments/:envId/servers           # List servers
POST /api/environments/:envId/servers           # Create server
POST /api/servers/:id/health                    # Health check
POST /api/servers/:id/discover                  # Discover containers
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
POST  /api/services/:id/check-updates # Check for image updates
```

### Registry Connections
```bash
GET    /api/environments/:envId/registries      # List registries
POST   /api/environments/:envId/registries      # Create registry connection
GET    /api/registries/:id                      # Get registry details
PATCH  /api/registries/:id                      # Update registry
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
PATCH  /api/config-files/:id                   # Update
DELETE /api/config-files/:id                   # Delete
GET    /api/services/:id/files                 # List attached files
POST   /api/services/:id/files                 # Attach file
DELETE /api/services/:serviceId/files/:fileId  # Detach file
POST   /api/services/:id/sync-files            # Sync to server
```

### Secrets
```bash
GET    /api/environments/:envId/secrets   # List secrets
POST   /api/environments/:envId/secrets   # Create secret
GET    /api/secrets/:id/value             # Get decrypted value
PATCH  /api/secrets/:id                   # Update
DELETE /api/secrets/:id                   # Delete
```

### Webhooks
```bash
POST /api/webhooks/deploy   # Deployment webhook for CI/CD
```

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | SQLite database path | Yes |
| `MASTER_KEY` | 32-byte base64 encryption key | Yes |
| `JWT_SECRET` | JWT signing secret | Yes |
| `HOST` | Server host (default: 0.0.0.0) | No |
| `PORT` | Server port (default: 3000) | No |
| `ADMIN_EMAIL` | Initial admin email (created on first boot) | No |
| `ADMIN_PASSWORD` | Initial admin password (min 8 chars) | No |
| `SCHEDULER_ENABLED` | Enable periodic health checks (default: true) | No |
| `SCHEDULER_SERVER_HEALTH_INTERVAL` | Server health check interval in seconds (default: 60) | No |
| `SCHEDULER_SERVICE_HEALTH_INTERVAL` | Service health check interval in seconds (default: 60) | No |
| `SCHEDULER_DISCOVERY_INTERVAL` | Container discovery interval in seconds (default: 300) | No |
| `SCHEDULER_UPDATE_CHECK_INTERVAL` | Registry update check interval in seconds (default: 1800) | No |

## Security

- **Encryption**: Secrets encrypted with XChaCha20-Poly1305
- **Authentication**: JWT tokens with bcrypt password hashing
- **SSH**: Per-environment encrypted SSH keys
- **Audit**: All sensitive actions logged

## Building

```bash
# Build backend
npm run build

# Build frontend
cd ui && npm run build

# Build Docker image
docker build -f docker/Dockerfile -t bridgeport .
```

## License

Copyright 2024-2025 BridgeIn. All rights reserved.
