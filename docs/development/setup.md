# Development Setup

Get BRIDGEPORT running locally for development in under 10 minutes.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Clone and Install](#clone-and-install)
- [Configure Environment](#configure-environment)
- [Set Up the Database](#set-up-the-database)
- [Start the Development Servers](#start-the-development-servers)
- [Verify Everything Works](#verify-everything-works)
- [Optional: Build the Agent and CLI](#optional-build-the-agent-and-cli)

---

## Prerequisites

| Tool | Version | Purpose | Install |
|------|---------|---------|---------|
| **Node.js** | 20+ | Backend and frontend | [nodejs.org](https://nodejs.org) |
| **npm** | 10+ | Package management | Comes with Node.js |
| **Go** | 1.22+ | Agent and CLI (optional) | [go.dev](https://go.dev/dl/) |
| **SQLite3** | 3.x | Database (dev/prod) | Usually pre-installed on macOS/Linux |

> [!NOTE]
> Go is only needed if you plan to work on the monitoring agent or CLI. For backend and frontend development, Node.js is sufficient.

---

## Clone and Install

```bash
# Clone the repository
git clone https://github.com/bridgeinpt/bridgeport.git
cd bridgeport

# Install backend dependencies
npm install

# Install frontend dependencies
cd ui && npm install && cd ..
```

Expected output (last few lines of `npm install`):

```
added 312 packages in 8s
```

---

## Configure Environment

Create a `.env` file in the project root with the required environment variables:

```bash
# Generate secure keys
echo "DATABASE_URL=file:./data/bridgeport.db" > .env
echo "MASTER_KEY=$(openssl rand -base64 32)" >> .env
echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env
```

Or create it manually:

```bash
cat > .env << 'EOF'
DATABASE_URL=file:./data/bridgeport.db
MASTER_KEY=your-32-byte-base64-key-here
JWT_SECRET=your-32-byte-base64-key-here

# Optional: Create an admin user on first boot
ADMIN_EMAIL=admin@localhost
ADMIN_PASSWORD=changeme123

# Optional: Scheduler (disable if you don't need background jobs)
# SCHEDULER_ENABLED=false
EOF
```

> [!TIP]
> Setting `ADMIN_EMAIL` and `ADMIN_PASSWORD` creates an admin user automatically when the database is first created. This saves you from having to use the API directly.

---

## Set Up the Database

Generate the Prisma client (TypeScript types for database access) and create the database with initial migrations:

```bash
# Generate Prisma client types
npm run db:generate

# Create the database and apply all migrations
npx prisma migrate dev
```

Expected output from `prisma migrate dev`:

```
Environment variables loaded from .env
Prisma schema loaded from prisma/schema.prisma
Datasource "db": SQLite database "bridgeport.db" at "file:./data/bridgeport.db"

Applying migration `20260203215738_init`

The following migration(s) have been applied:

migrations/
  └─ 20260203215738_init/
    └─ migration.sql

Your database is now in sync with your schema.

✔ Generated Prisma Client
```

This creates the SQLite database file at `./data/bridgeport.db` with all tables defined in `prisma/schema.prisma`.

---

## Start the Development Servers

BRIDGEPORT has two development servers that run simultaneously: the backend (Fastify) and the frontend (Vite).

### Terminal 1: Backend

```bash
npm run dev
```

Expected output:

```
[12:00:00] INFO: BRIDGEPORT running at http://0.0.0.0:3000
[12:00:00] INFO: [Scheduler] Starting with intervals:
  - Server health: 60s
  - Service health: 60s
  - Discovery: 300s
  ...
```

The backend runs on **port 3000** with hot reload via `tsx watch`.

### Terminal 2: Frontend

```bash
cd ui && npm run dev
```

Expected output:

```
  VITE v5.x.x  ready in 500 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
  ➜  press h + enter to show help
```

The frontend runs on **port 5173** with Vite's hot module replacement (HMR).

### Access the Application

Open **http://localhost:5173** in your browser. If you configured `ADMIN_EMAIL` and `ADMIN_PASSWORD`, log in with those credentials.

> [!NOTE]
> In development, the Vite dev server proxies API requests to the backend on port 3000. You do not need to access port 3000 directly for the UI.

---

## Verify Everything Works

### Health Check

```bash
curl -s http://localhost:3000/health | jq .
```

Expected output:

```json
{
  "status": "ok",
  "timestamp": "2026-02-25T12:00:00.000Z",
  "version": "1.0.0",
  "bundledAgentVersion": "unknown",
  "cliVersion": "unknown"
}
```

> [!NOTE]
> `bundledAgentVersion` and `cliVersion` show "unknown" in development mode because the version files are generated during Docker image builds. This is expected.

### Log In

If you set `ADMIN_EMAIL` and `ADMIN_PASSWORD`:

```bash
curl -s http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@localhost","password":"changeme123"}' | jq .
```

Expected output:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "...",
    "email": "admin@localhost",
    "name": null,
    "role": "admin"
  }
}
```

---

## Optional: Build the Agent and CLI

If you are working on the monitoring agent or CLI, you need Go 1.22+ installed.

### Build the Agent

```bash
cd bridgeport-agent
make build
```

This builds the agent binary for your current platform. To build for Linux (for deployment):

```bash
make build-linux
```

### Build the CLI

```bash
cd cli
make build
```

This builds the CLI for your current platform. To build for all platforms:

```bash
make build-all
```

See [Building](building.md) for full build instructions including the Docker image.

---

## Common Development Tasks

| Task | Command |
|------|---------|
| Start backend | `npm run dev` |
| Start frontend | `cd ui && npm run dev` |
| Generate Prisma client | `npm run db:generate` |
| Create a migration | `npx prisma migrate dev --name descriptive_name` |
| Run integration tests | `npx vitest run --config config/vitest.config.ts` |
| Run unit tests | `npx vitest run --config config/vitest.unit.config.ts` |
| Build backend | `npm run build` |
| Build frontend | `cd ui && npm run build` |

---

## Related Documentation

- [Architecture](architecture.md) -- how the codebase is organized
- [Database Migrations](database-migrations.md) -- working with schema changes
- [Building](building.md) -- building Docker images and binaries
- [Configuration Reference](../configuration.md) -- all environment variables
