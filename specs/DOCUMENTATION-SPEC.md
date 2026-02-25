# BridgePort Documentation Spec

> **Goal**: Make BridgePort's documentation so good that anyone landing on the repo thinks *"this is the best-documented repo I've ever seen."*

> **Approach**: Full rewrite of all existing docs. Single comprehensive spec, implemented in whatever order makes sense.

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [Folder Structure](#2-folder-structure)
3. [README.md (The Gateway)](#3-readmemd-the-gateway)
4. [Docs Index](#4-docs-index)
5. [Getting Started](#5-getting-started)
6. [Concepts & Glossary](#6-concepts--glossary)
7. [Installation Guide](#7-installation-guide)
8. [Configuration Reference](#8-configuration-reference)
9. [Feature Guides](#9-feature-guides)
10. [Advanced Guides](#10-advanced-guides)
11. [Reference Documentation](#11-reference-documentation)
12. [Operations & Maintenance](#12-operations--maintenance)
13. [Contributing & Development](#13-contributing--development)
14. [Community & Legal](#14-community--legal)
15. [OpenAPI / Swagger Integration](#15-openapi--swagger-integration)
16. [Quality Standards](#16-quality-standards)

---

## 1. Design Principles

Every doc must follow these principles:

### Tone: Friendly but not fluffy
- Use "you" and "we" naturally
- Every sentence earns its place - no filler
- Assume competence but not familiarity with BridgePort
- Technical precision over vague hand-waving

### Developer empathy: Maximum
- **Copy-paste commands**: Every setup step has a command you can copy and run
- **Expected output**: Show actual terminal output so users know what success looks like
- **Decision trees**: When users face choices (SSH vs socket, agent vs SSH polling), provide clear decision guidance
- **Callout boxes**: Use GitHub-flavored admonitions (`> [!NOTE]`, `> [!WARNING]`, `> [!TIP]`)

### Structure: Scannable
- Lead every page with a one-sentence summary of what it covers
- Use clear headings - someone scanning the ToC should find what they need in seconds
- Code blocks have language tags and are copy-pasteable
- Long pages have a table of contents at the top
- Cross-link aggressively between related docs

### Diagrams: Mermaid-only
- All diagrams use Mermaid syntax (renders natively in GitHub)
- Architecture overviews, deployment flows, decision trees, data flows
- No external images that go stale - everything is text-based and version-controlled

---

## 2. Folder Structure

```
bridgeport/
├── README.md                          # The gateway (medium length)
├── LICENSE                            # AGPL-3.0
├── CONTRIBUTING.md                    # Full contributor guide
├── SECURITY.md                        # Security policy + vulnerability reporting
├── CHANGELOG.md                       # Release history
├── BRANDING.md                        # (keep existing)
├── CLAUDE.md                          # (keep existing, internal dev reference)
├── docs/
│   ├── README.md                      # Docs index / table of contents
│   │
│   ├── getting-started.md             # Quick start (5-minute deploy)
│   ├── concepts.md                    # Architecture overview + glossary
│   ├── installation.md                # Multi-path install guide
│   ├── configuration.md               # Env vars + recipes
│   │
│   ├── guides/                        # Feature guides (user-facing)
│   │   ├── users.md                   # User management + RBAC
│   │   ├── servers.md                 # Server management
│   │   ├── services.md                # Service management + deployment
│   │   ├── environments.md            # Environment setup + settings
│   │   ├── container-images.md        # Image management + registry linking
│   │   ├── registries.md              # Registry connections + auto-linking
│   │   ├── secrets.md                 # Secret management workflow
│   │   ├── config-files.md            # Config file management + sync
│   │   ├── databases.md               # Database management + backups
│   │   ├── storage.md                 # S3/Spaces storage configuration
│   │   ├── monitoring.md              # Monitoring quick start
│   │   ├── monitoring-servers.md      # Server metrics deep dive
│   │   ├── monitoring-services.md     # Service metrics deep dive
│   │   ├── monitoring-databases.md    # Database monitoring deep dive
│   │   ├── health-checks.md          # Health check system
│   │   ├── notifications.md           # Notification quick start + reference
│   │   ├── topology.md               # Service topology diagram
│   │   ├── deployment-plans.md        # Deployment orchestration
│   │   └── webhooks.md               # CI/CD webhook integration
│   │
│   ├── reference/                     # Deep reference material
│   │   ├── api.md                     # API overview + authentication
│   │   ├── cli.md                     # CLI command reference
│   │   ├── agent.md                   # Monitoring agent reference
│   │   ├── events.md                  # Real-time events (SSE) reference
│   │   ├── plugins.md                 # Plugin authoring guide
│   │   ├── environment-settings.md    # All per-environment settings
│   │   └── system-settings.md         # System-wide settings reference
│   │
│   ├── operations/                    # Ops & maintenance
│   │   ├── upgrades.md               # Upgrade guide + auto-migration
│   │   ├── security.md               # Security architecture + hardening
│   │   ├── backup-restore.md         # Backup strategies + restore procedures
│   │   ├── troubleshooting.md        # General debugging guide
│   │   └── patterns.md               # Architecture patterns + examples
│   │
│   └── development/                   # For contributors
│       ├── setup.md                   # Dev environment setup
│       ├── architecture.md            # Codebase architecture deep dive
│       ├── database-migrations.md     # How to make schema changes safely
│       └── building.md               # Building Docker image, agent, CLI
```

**Total: ~45 documents** (including README, CONTRIBUTING, SECURITY, CHANGELOG, LICENSE)

---

## 3. README.md (The Gateway)

The README is the first thing anyone sees. It must be impeccable.

### Structure

```markdown
<!-- Badges row -->
[License] [Docker Pulls] [Latest Release] [Build Status]

# BridgePort

One-line description.

## The Problem

2-3 sentences about why managing Docker deployments across multiple servers
is painful. SSH into each server, remember docker commands, no visibility,
no rollback, no coordination.

## The Solution

2-3 sentences about what BridgePort does. Lightweight web UI, SSH-native,
no Kubernetes required, deploy/monitor/manage from one place.

## Key Features

Icon + feature name + one-line description format. Organized in a clean grid.
Features to highlight:
- Multi-server management (SSH + Docker socket)
- One-click deployments with auto-rollback
- Real-time monitoring (server, service, database)
- Health checks with bounce protection
- Encrypted secret management
- Database backup scheduling
- Multi-channel notifications (in-app, email, Slack, webhooks)
- Container registry integration with auto-update
- Interactive service topology diagram
- CLI tool for terminal workflows
- Plugin system for service/database types
- Role-based access control (admin, operator, viewer)

## Quick Start

docker run command - get BridgePort running in 30 seconds.
Show expected output.
Link to full installation guide.

## Feature Highlights

3-4 paragraphs with Mermaid diagrams showing:
1. Deploy & Monitor flow (server → service → health check → notification)
2. Multi-server architecture (BridgePort managing N servers via SSH)
Brief description under each diagram.

## Documentation

Clean linked list to docs sections:
- Getting Started → docs/getting-started.md
- Installation Guide → docs/installation.md
- Configuration → docs/configuration.md
- Feature Guides → docs/guides/
- CLI Reference → docs/reference/cli.md
- API Reference → docs/reference/api.md
- Contributing → CONTRIBUTING.md

## Quick Links

| I want to... | Go here |
|---|---|
| Deploy BridgePort | Installation Guide |
| Add my first server | Server Guide |
| Set up monitoring | Monitoring Guide |
| Deploy a service | Service Guide |
| Configure backups | Backup Guide |
| Use the CLI | CLI Reference |
| Contribute | Contributing Guide |

## Community & Support

- GitHub Issues for bugs and features
- Discussions for questions
- Contributing guide link

## License

AGPL-3.0 - brief explanation of what this means for users.
```

### README Quality Checklist
- [ ] Badges render correctly
- [ ] Quick start command works copy-paste on a fresh system
- [ ] Every link in the doc is valid
- [ ] Mermaid diagrams render on GitHub
- [ ] No wall of text - visual rhythm with headings, lists, code blocks
- [ ] Under 400 lines (gateway, not encyclopedia — Mermaid diagrams and feature grid need room)

---

## 4. Docs Index

**File**: `docs/README.md`

A beautiful table of contents for the entire documentation. Organized by reader journey:

```
1. Start Here
   - Getting Started (5-minute quickstart)
   - Core Concepts (how BridgePort thinks)
   - Installation (all deployment methods)
   - Configuration (environment variables + recipes)

2. Feature Guides
   - Users & Roles, Servers, Services, Environments
   - Container Images, Registries
   - Secrets, Config Files, Databases, Storage
   - Monitoring (quick start + deep dives)
   - Notifications, Health Checks, Topology
   - Deployment Orchestration, Webhooks

3. Reference
   - API Reference (+ link to Swagger UI)
   - CLI Reference
   - Agent Reference
   - Real-Time Events (SSE)
   - Plugin Authoring
   - Settings Reference

4. Operations
   - Upgrades & Migrations
   - Security & Hardening
   - Backup & Restore
   - Troubleshooting
   - Architecture Patterns

5. Contributing
   - Development Setup
   - Architecture Guide
   - Database Migrations
   - Building & Releasing
```

---

## 5. Getting Started

**File**: `docs/getting-started.md`

The single most important doc. Someone should go from "never heard of BridgePort" to "managing their first server" in 5 minutes.

### Content

1. **What you'll accomplish**: Deploy BridgePort, add a server, see your containers
2. **Prerequisites**: Docker installed, a server with SSH access (or use local Docker socket)
3. **Step 1: Start BridgePort**
   - `docker run` command with minimal env vars
   - Expected output (actual terminal output block)
   - "Open http://localhost:3000 in your browser"
4. **Step 2: Log in**
   - Default credentials (or env var setup)
   - Screenshot description: "You'll see the login page"
5. **Step 3: Create an environment**
   - What environments are (one sentence)
   - Walk through creating one
6. **Step 4: Add your first server**
   - Decision tree: "Is BridgePort running on the same machine as your Docker containers?"
     - Yes → Docker socket mode (simple)
     - No → SSH mode (most common)
   - SSH mode setup: paste SSH key, test connection
   - Expected result: server appears with status "healthy"
7. **Step 5: Discover your containers**
   - Click "Discover" on the server
   - See your running containers as services
8. **Step 6: Deploy an update** (optional wow moment)
   - Show how to deploy a new tag
   - See the deployment log in real-time
9. **What's next?**
   - Links to: monitoring setup, adding more servers, setting up notifications, CLI

### Quality Requirements
- Every step has a copy-paste command OR clear UI instruction
- Expected output shown after every command
- Decision points have clear guidance
- Total reading time: under 5 minutes
- Works on a completely fresh system

---

## 6. Concepts & Glossary

**File**: `docs/concepts.md`

### Content

1. **Architecture Overview**
   - Mermaid diagram: BridgePort at center, connecting to N servers via SSH, optional agent, registry, notification channels
   - Brief paragraph explaining the hub-and-spoke model

2. **Core Concepts** (each gets 2-3 sentences + how they relate)
   - **Environment**: Logical grouping (production, staging). Has its own SSH key, settings, and resources
   - **Server**: A machine BridgePort manages. Connected via SSH or local Docker socket
   - **Service**: A Docker container on a server. Linked to a Container Image
   - **Container Image**: The central image entity. One image can power multiple services across servers
   - **Registry**: Where images live (Docker Hub, GHCR, private). BridgePort checks for updates
   - **Secret**: Encrypted key-value pair. Injected into services as environment variables
   - **Config File**: Configuration files synced to servers (nginx configs, env files, etc.)
   - **Database**: A registered database for backup scheduling and monitoring
   - **Deployment Plan**: An orchestrated multi-service deployment with dependency ordering

3. **How Concepts Relate**
   - Mermaid entity-relationship diagram:
     ```
     Environment → has many → Servers
     Server → has many → Services
     Service → linked to → Container Image
     Container Image → checked against → Registry
     Service → uses → Secrets, Config Files
     Service → depends on → other Services (deployment order)
     Server → monitored by → Agent or SSH
     ```

4. **Glossary**
   - Alphabetical table of every BridgePort-specific term
   - Format: `| Term | Definition | Related docs |`
   - Include: environment, server, service, container image, deployment plan, deployment step, health check, bounce, auto-rollback, agent, discovery, service type, database type, topology connection, notification type

---

## 7. Installation Guide

**File**: `docs/installation.md`

Three paths, clearly separated.

### Path 1: Quick Start (Docker Run)

For trying BridgePort out. Single command, minimal config.

```bash
docker run -d \
  --name bridgeport \
  -p 3000:3000 \
  -v bridgeport-data:/data \
  -e MASTER_KEY=$(openssl rand -base64 32) \
  -e JWT_SECRET=$(openssl rand -base64 32) \
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD=changeme \
  your-registry/bridgeport:latest
```

Show expected output. Mention this is NOT for production.

### Path 2: Production Setup (Docker Compose)

Full docker-compose.yml with:
- Named volumes for data persistence
- All recommended env vars with comments
- Reverse proxy notes (Caddy/Nginx/Traefik)
- HTTPS configuration
- Restart policy
- Resource limits

Include a complete, annotated `docker-compose.yml` that users can download and customize.

**Post-installation checklist:**
- [ ] Change default admin password
- [ ] Set up HTTPS via reverse proxy
- [ ] Configure CORS_ORIGIN for your domain
- [ ] Set up backup volume mounts
- [ ] (Optional) Configure Sentry for error monitoring
- [ ] (Optional) Set up SMTP for email notifications

### Path 3: Development Setup

For contributors. Full setup with hot reload:

```bash
git clone ...
npm install
cd ui && npm install && cd ..
cp .env.example .env  # Edit with your values
npm run db:generate
npx prisma migrate dev
npm run dev           # Backend on :3000
cd ui && npm run dev  # Frontend on :5173
```

Link to CONTRIBUTING.md for more details.

### Docker Socket vs SSH

> [!NOTE]
> **Which mode should I use?**

Decision tree (Mermaid flowchart):
```
Is BridgePort on the same machine as your containers?
├── Yes → Docker Socket mode (simplest, no SSH needed)
└── No → SSH mode (most common, works across any network)
    └── Want real-time metrics push? → Also install the Agent
```

Table comparing modes:
| Feature | Docker Socket | SSH Mode | SSH + Agent |
|---------|--------------|----------|-------------|
| Setup complexity | Minimal | Medium | Medium |
| Network requirement | Same machine | SSH access | SSH access |
| Metrics collection | Basic | SSH polling | Real-time push |
| Container discovery | Yes | Yes | Yes + process list |
| Latency | Instant | SSH round-trip | Push-based |

---

## 8. Configuration Reference

**File**: `docs/configuration.md`

### Content

1. **Essential Configuration**
   - The 4 required env vars with explanations
   - How to generate secure keys (with commands)

2. **Full Environment Variable Reference**
   - Table format: `| Variable | Type | Default | Description |`
   - Grouped by concern:
     - Core (DATABASE_URL, MASTER_KEY, JWT_SECRET)
     - Network (HOST, PORT, CORS_ORIGIN)
     - Auth (ADMIN_EMAIL, ADMIN_PASSWORD)
     - Scheduler (all SCHEDULER_* vars with what each controls)
     - Retention (METRICS_RETENTION_DAYS — default 7 days)
     - Storage (UPLOAD_DIR, PLUGINS_DIR)
     - Sentry (all SENTRY_* vars)

3. **Configuration Recipes**

   > [!TIP]
   > **Common configurations you can copy-paste**

   **Minimal (trying it out):**
   ```env
   MASTER_KEY=...
   JWT_SECRET=...
   ```

   **Production (recommended):**
   ```env
   # Full production config with comments
   ```

   **High-frequency monitoring:**
   ```env
   # Aggressive polling intervals for critical infrastructure
   SCHEDULER_SERVER_HEALTH_INTERVAL=30
   SCHEDULER_SERVICE_HEALTH_INTERVAL=30
   SCHEDULER_METRICS_INTERVAL=60
   ```

   **CI/CD integration:**
   ```env
   # Webhook-focused config for pipeline integration
   ```

4. **Per-Environment Settings**
   - Brief overview: these are configured in the UI, not env vars
   - Link to `reference/environment-settings.md` for full details

5. **System Settings**
   - Brief overview: admin-only settings configured in the UI
   - Link to `reference/system-settings.md` for full details

---

## 9. Feature Guides

Each guide follows this template:

```
# Feature Name

One-sentence summary of what this feature does and why you'd use it.

## Quick Start
How to get this feature working in 2 minutes.

## How It Works
Brief explanation of the mechanics.
Mermaid diagram if the flow is non-trivial.

## Step-by-Step Guide
Detailed walkthrough with commands/UI steps and expected results.

## Configuration Options
What can be customized, with defaults and recommendations.

## Troubleshooting
Common issues specific to this feature, with solutions.

## Related
Links to related features and docs.
```

### 9.1 Users & Roles (`docs/guides/users.md`)

- Three-tier RBAC model: admin, operator, viewer
- Full permissions matrix (what each role can do)
- Managing users: creating, editing, deleting (admin workflows)
- Self-service account: My Account modal, password change (all users)
- **API Tokens**: Creating, managing, and revoking programmatic tokens
  - Token returned once on creation — store securely
  - Optional expiry (days)
  - Use cases: CI/CD pipelines, SSE connections, deployment scripts
- Initial admin setup (first boot via env vars)
- Active user tracking (lastActiveAt, configurable window)
- Authentication flow: JWT login, API token validation, session management

### 9.2 Servers (`docs/guides/servers.md`)

- Adding servers (SSH mode vs socket mode)
- SSH key configuration (per-environment)
- Docker mode setup with connection testing
- Server health monitoring
- Metrics mode selection (decision tree: disabled vs SSH vs agent)
- Container discovery
- Creating services manually vs auto-discovery
- Expected terminal output when testing SSH connection

### 9.3 Services (`docs/guides/services.md`)

- What a service represents (Docker container linked to an image)
- Creating services (manual vs discovery)
- Deploying new image tags
- Deployment logs and history
- Service actions (start, stop, restart, pull)
- Health check configuration (per-service wait, retries, interval)
- TCP and certificate checks (agent-required)
- Linking to container images
- Service dependencies (link to deployment-plans.md for orchestration)
- Config file attachment and sync
- **Docker Compose Templates**:
  - Auto-generated vs custom compose templates
  - Creating a custom template for a service
  - Variable substitution: `${SERVICE_NAME}`, `${CONTAINER_NAME}`, `${IMAGE_NAME}`, `${IMAGE_TAG}`, `${FULL_IMAGE}`, `${CONFIG_FILE_N}`, `${CONFIG_FILE_N_NAME}`
  - Previewing generated artifacts before deploying (`/api/services/:id/compose/preview`)
  - Viewing deployment artifacts after deploy (`/api/deployments/:id/artifacts`)
  - Reverting to auto-generated (deleting custom template)
  - When to use custom templates: complex volume mounts, extra networks, sidecar containers

### 9.4 Environments (`docs/guides/environments.md`)

- What environments are and when to create them
- Creating and configuring environments
- SSH key management (encrypted, per-environment)
- Per-module settings overview (General, Monitoring, Operations, Data, Configuration)
- Switching between environments in the UI
- Best practices: production vs staging vs development environments

### 9.5 Container Images (`docs/guides/container-images.md`)

- Central image entity concept (one image → many services)
- Creating and linking images to services
- Tag management and history (success/failed/rolled_back states)
- Registry integration (checking for updates)
- Auto-update toggle: what it does, when to use it
- "Deploy All" - deploying a tag to all linked services
- Mermaid diagram: image → registry → update detected → auto-deploy flow

### 9.6 Registries (`docs/guides/registries.md`)

- Supported registries (Docker Hub, GHCR, private registries)
- Adding registry connections
- Authentication setup
- Refresh intervals and update checking
- Auto-link patterns (automatic image → registry matching)
- Registry tag browser
- Mermaid diagram: registry update detection flow (fold existing `docs/registry-update-flow.md` content into this guide)

### 9.7 Secrets (`docs/guides/secrets.md`)

Workflow-focused (per interview decision):

- Creating secrets (key-value pairs)
- Encryption at rest (XChaCha20-Poly1305 - brief, builds trust)
- Using secrets in services
- The `neverReveal` flag - what it does and when to use it
- Env templates: generating environment files from secrets
- Best practices: naming conventions, rotation, access control

### 9.8 Config Files (`docs/guides/config-files.md`)

- What config files are (synced configuration)
- Creating config files (text and binary support)
- Attaching config files to services
- Syncing to servers
- Edit history and rollback
- Use cases: nginx configs, .env files, SSL certificates

### 9.9 Databases (`docs/guides/databases.md`)

Backup-first approach (per interview decision):

1. **Protect Your Data First**
   - Registering a database
   - Setting up backup schedules (cron syntax with examples)
   - Manual backups
   - Backup storage: local vs S3-compatible (link to `docs/guides/storage.md` for setup)
   - Restore procedures
   - Recovery steps for common scenarios (inline DR, per interview decision)

2. **Monitor Your Databases**
   - Enabling monitoring
   - Collection intervals
   - Monitoring queries (plugin-driven)
   - Supported database types: PostgreSQL, MySQL, SQLite, MongoDB, Redis
   - Testing connections
   - Viewing metrics and charts

3. **Linking Databases to Services**
   - ServiceDatabase connections
   - Connection environment variables

### 9.10 S3/Spaces Storage (`docs/guides/storage.md`)

- What storage is for: S3-compatible object storage as a backup destination
- **Supported providers**: Any S3-compatible service (DigitalOcean Spaces, AWS S3, MinIO, Backblaze B2, Wasabi, Cloudflare R2)
- Setting up storage: credentials, region, custom endpoint
- Bucket configuration: auto-discovery vs manual entry for scoped keys
- Testing the connection
- Per-environment enable/disable
- Provider-specific examples: endpoint URLs, region codes
- Scoped keys: what they are, how BridgePort handles them, when to use them

### 9.11 Monitoring Quick Start (`docs/guides/monitoring.md`)

This page is a **routing page**, not a condensed version of all three deep dives. It helps readers pick their path quickly and get started.

- Enable monitoring in 2 minutes
- Decision tree: which monitoring mode?
  ```
  Want basic server metrics? → SSH mode → see monitoring-servers.md
  Want real-time metrics + container details? → Deploy the agent → see monitoring-servers.md
  Want database metrics? → Enable per-database monitoring → see monitoring-databases.md
  Want container-level metrics? → see monitoring-services.md
  ```
- Quick setup for each mode (minimal steps, just enough to see first data)
- Clear "Next Steps" links to each deep-dive doc
- Do NOT duplicate deep-dive content — keep this under 150 lines

### 9.12 Monitoring Deep Dives

**Server Monitoring** (`docs/guides/monitoring-servers.md`):
- SSH metric collection: what's collected (CPU, memory, disk, load, swap, TCP, FDs)
- Agent metric collection: additional data (top processes, container snapshots)
- Viewing charts and time ranges
- Setting collection intervals
- Retention settings

**Service Monitoring** (`docs/guides/monitoring-services.md`):
- Container metrics: CPU, memory, network RX/TX, block I/O
- How metrics are collected (Docker stats via SSH or agent)
- Charts and visualization
- Auto-refresh behavior

**Database Monitoring** (`docs/guides/monitoring-databases.md`):
- Plugin-driven monitoring queries
- How monitoring works for each database type
- SQL mode (direct connection) vs SSH mode (command execution)
- Collection intervals and retention
- Custom monitoring queries via plugins

### 9.13 Health Checks (`docs/guides/health-checks.md`)

- Types of health checks: container health, URL health, TCP, certificate expiry
- Manual health checks
- Automated health check scheduling
- Health check configuration per service (wait, retries, interval)
- Health check logs and history
- Bounce logic: how repeated failures are handled to prevent alert storms
- Integration with deployment orchestration

### 9.14 Notifications (`docs/guides/notifications.md`)

Quick start + reference (per interview decision):

**Quick Start (Get Notifications in 5 Minutes):**
- Enable in-app notifications (on by default)
- Set up email: configure SMTP in admin
- Set up Slack: add webhook URL
- Set up outgoing webhooks: add endpoint

**Reference:**
- Notification types and their templates
- Per-user preferences (per-type, per-channel)
- Environment filtering
- Bounce logic deep dive (consecutive failure tracking, thresholds)
- Template placeholders
- Troubleshooting: notifications not being sent

### 9.15 Topology Diagram (`docs/guides/topology.md`)

- What the topology diagram shows
- Creating connections between services/databases
- Connection properties: port, protocol, direction
- Dragging nodes and persisting layout
- Server grouping visualization
- Use cases: understanding service architecture at a glance

### 9.16 Deployment Plans (`docs/guides/deployment-plans.md`)

Positioned as an advanced feature (per interview decision):

- What deployment orchestration solves
- Prerequisites: container images, service dependencies
- Setting up service dependencies (`health_before`, `deploy_after`)
- Creating a deployment plan
- Mermaid diagram: dependency resolution → step ordering → execution
- Step types: deploy, health_check, rollback
- Auto-rollback: how it works and what triggers it
- Parallel execution options
- Real-time progress tracking
- Example: deploying a web app + API + worker with dependencies

### 9.17 Webhooks (`docs/guides/webhooks.md`)

- Incoming webhooks (CI/CD triggers)
- Setting up webhook endpoints
- Payload format and authentication
- Use cases: GitHub Actions → deploy, GitLab CI → deploy
- Example webhook configurations for popular CI tools

---

## 10. Advanced Guides

### 10.1 Architecture Patterns (`docs/operations/patterns.md`)

Architecture patterns + real examples (per interview decision):

**Pattern 1: Single Server**
- Mermaid diagram
- When to use: small projects, personal infrastructure
- Example: BridgePort + your app on one VPS
- Docker compose example

**Pattern 2: Multi-Server**
- Mermaid diagram
- When to use: production workloads, separation of concerns
- Example: Web servers + API servers + database server
- How BridgePort manages them all via SSH

**Pattern 3: Staging + Production**
- Mermaid diagram
- Using environments to separate staging from production
- Promoting deployments from staging to production

**Pattern 4: Real-World Stack**
- Concrete example: Django + Celery + Redis + PostgreSQL across 3 servers
- Full walkthrough: setting up each component in BridgePort
- Dependencies, health checks, deployment orchestration
- Monitoring configuration

---

## 11. Reference Documentation

### 11.1 API Reference (`docs/reference/api.md`)

- **JWT Authentication**: Login flow, token format, 7-day expiry, `Authorization: Bearer` header
- **API Tokens**: Full lifecycle for programmatic access
  - Creating tokens (`POST /api/auth/tokens`): name, optional expiry (days)
  - Token is returned **once** on creation — store it securely
  - Tokens are stored as hashes (never retrievable after creation)
  - Listing tokens (`GET /api/auth/tokens`): shows name, expiry, last used
  - Revoking tokens (`DELETE /api/auth/tokens/:tokenId`)
  - Using tokens: `Authorization: Bearer <token>` header, or `?token=` query param for SSE
  - **CI/CD integration**: Using API tokens in GitHub Actions, GitLab CI, deployment scripts
- Base URL and common headers
- Error format (JSON with `error` field, optional `details` for validation)
- Link to auto-generated Swagger UI (see section 15)
- Brief overview of endpoint categories with links to Swagger

### 11.2 CLI Reference (`docs/reference/cli.md`)

Full command reference (21 commands):

```
# Authentication & Identity
bridgeport login        - Authenticate with a BridgePort instance
bridgeport whoami       - Show current user and server info
bridgeport config       - Manage CLI configuration

# Server Operations
bridgeport list         - List servers in an environment
bridgeport status       - Show server details and container status
bridgeport ssh          - SSH into a server
bridgeport exec         - Execute a command in a container
bridgeport logs         - View container logs
bridgeport run          - Run predefined commands (migrate, shell, etc.)

# Resource Management
bridgeport services     - List and manage services
bridgeport databases    - List and manage databases
bridgeport secrets      - List and manage secrets
bridgeport configs      - List and manage config files
bridgeport images       - List and manage container images
bridgeport registries   - List and manage registry connections

# Monitoring & Operations
bridgeport health       - Run health checks on servers/services
bridgeport backups      - List and manage database backups
bridgeport audit        - View audit logs

# Utilities
bridgeport version      - Show CLI and server version info
bridgeport completion   - Generate shell completions (bash, zsh, fish, powershell)
```

For each command:
- Synopsis
- Flags and options
- Examples with expected output
- Common use cases

### 11.3 Agent Reference (`docs/reference/agent.md`)

- What the agent does (metrics push, container discovery, process snapshots, TCP/cert checks)
- Installation methods:
  - Auto-deploy via BridgePort UI (recommended)
  - Manual installation
  - Building from source
- Configuration (server URL, token)
- How metrics are reported
- Agent upgrade: how to detect and apply updates
- Troubleshooting: agent not reporting, token issues

### 11.4 Plugin Authoring Guide (`docs/reference/plugins.md`)

Full plugin authoring guide (per interview decision):

**Service Type Plugins:**
- JSON schema explanation (every field)
- Example: creating a custom service type
- Commands: shell, migrate, custom commands
- Template placeholders in commands

**Database Type Plugins:**
- JSON schema explanation
- Monitoring queries: how to define them
  - Result types: scalar, row, rows
  - SQL mode vs SSH mode queries
  - Chart configuration
- Example: creating a monitoring query for a custom database
- Commands: shell, vacuum, custom

**Plugin Directory Structure:**
```
plugins/
├── service-types/
│   ├── django.json
│   ├── nodejs.json
│   └── your-custom-type.json
└── database-types/
    ├── postgres.json
    ├── mysql.json
    ├── sqlite.json
    ├── mongodb.json
    ├── redis.json
    └── your-custom-db.json
```

**Plugin Lifecycle:**
- How plugins are loaded on startup (`syncPlugins()`)
- `isCustomized` flag behavior
- Smart merge: what happens when you update a plugin file
- Resetting customizations
- Exporting current config

### 11.5 Real-Time Events Reference (`docs/reference/events.md`)

BridgePort provides a Server-Sent Events (SSE) endpoint for live updates:

- **SSE endpoint**: `GET /api/events`
- **Authentication**: Query parameter `token` (JWT or API token — EventSource cannot send headers)
- **Environment filtering**: Optional `environmentId` query parameter
- **Event types**:
  - `health_status` — Health check status changes for servers and services
  - `deployment_progress` — Live deployment and orchestration updates
  - `notification` — New notification count (filtered to authenticated user only)
  - `metrics_updated` — Fresh metrics available for a server
  - `container_discovery` — Container discovery completed on a server
- **Payload schemas**: Each event type with its data shape and field descriptions
- **Connection behavior**: Keepalive every 30 seconds, nginx buffering considerations (`X-Accel-Buffering: no`)
- **Client integration**: JavaScript EventSource examples with auth token
- **Infrastructure notes**: Max 100 concurrent connections, cleanup on disconnect

### 11.6 Environment Settings Reference (`docs/reference/environment-settings.md`)

Complete reference for all per-environment settings:

**General Settings:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|

**Monitoring Settings:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|

**Operations Settings:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|

**Data Settings:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|

**Configuration Settings:**
| Setting | Type | Default | Description |
|---------|------|---------|-------------|

### 11.7 System Settings Reference (`docs/reference/system-settings.md`)

Complete reference for admin-only system settings:
- SSH timeouts
- Webhook retry configuration
- Backup timeouts and limits
- External URLs
- All settings with types, defaults, and descriptions

---

## 12. Operations & Maintenance

### 12.1 Upgrade Guide (`docs/operations/upgrades.md`)

Prominent upgrade guide (per interview decision):

1. **How Upgrades Work**
   - Pull new image → restart → migrations run automatically
   - Mermaid diagram: container start → entrypoint.sh → prisma migrate deploy → app starts

2. **Upgrade Procedure**
   ```bash
   # Docker run
   docker pull your-registry/bridgeport:latest
   docker stop bridgeport && docker rm bridgeport
   docker run ... (same command as before)
   ```
   ```bash
   # Docker Compose
   docker compose pull
   docker compose up -d
   ```
   Show expected log output showing migrations running.

3. **What to Expect**
   - Downtime: typically < 30 seconds
   - Data: all data preserved (SQLite in volume)
   - Migrations: applied automatically
   - Agent/CLI: check for updates separately

4. **Verifying the Upgrade**
   - Check `/health` endpoint
   - Check version in admin About page
   - Verify agent version compatibility

5. **Rollback**
   - How to rollback to a previous version
   - Important: mention that migrations are forward-only (schema might not be backwards compatible)
   - Recommendation: always backup before upgrading

6. **Agent Upgrades**
   - How to detect agent version mismatch (UI indicators)
   - Re-deploying agent via UI

### 12.2 Security & Hardening (`docs/operations/security.md`)

Security architecture + hardening guide (per interview decision):

**Security Architecture:**
- Authentication: JWT tokens with refresh, API tokens
- Authorization: RBAC (admin, operator, viewer)
- Encryption: XChaCha20-Poly1305 for secrets at rest
- SSH: per-environment encrypted keys
- Agent: per-server tokens
- Mermaid diagram: auth flow (login → JWT → API calls → RBAC check)

**Production Hardening Checklist:**
- [ ] Run behind a reverse proxy with HTTPS
- [ ] Set strong MASTER_KEY and JWT_SECRET
- [ ] Change default admin credentials
- [ ] Configure CORS_ORIGIN to your specific domain
- [ ] Use non-root user in Docker (if supported)
- [ ] Restrict network access to BridgePort port
- [ ] Set up firewall rules for SSH access
- [ ] Enable Sentry for error monitoring
- [ ] Regular backups of the SQLite database
- [ ] Review audit logs periodically

**RBAC Model:**
| Action | Admin | Operator | Viewer |
|--------|-------|----------|--------|
| View resources | Yes | Yes | Yes |
| Deploy services | Yes | Yes | No |
| Manage secrets | Yes | Yes | No |
| Create/delete resources | Yes | No* | No |
| User management | Yes | No | No |
| System settings | Yes | No | No |

*Operators can create some resources - full matrix in the admin guide.

**Audit Logging:**
- What gets audited: deployments, secret access, user management, configuration changes, backup operations, registry updates, Spaces config changes
- Resource types tracked: `server`, `service`, `secret`, `config_file`, `database`, `user`, `environment`, `registry`, `spaces_config`, `spaces_environment`, `system_settings`, and more
- Actions tracked: `create`, `update`, `delete`, `deploy`, `restart`, `backup`, `restore`
- How to read audit logs: Admin UI (`/admin/audit`) with filtering by environment, resource type, action
- API access: `GET /api/audit-logs` with query filters
- Each log entry includes: action, resourceType, resourceId, resourceName, details (JSON), success/error, userId, environmentId, timestamp
- Retention: configurable via `cleanupOldAuditLogs(retentionDays)` — set to 0 to keep forever

**Vulnerability Reporting:**
Link to SECURITY.md.

### 12.3 Backup & Restore (`docs/operations/backup-restore.md`)

- BridgePort's own data: backing up the SQLite database
- Managed database backups: scheduling and strategies
- Storage options: local vs Spaces (S3-compatible)
- Restore procedures for each scenario
- Recovery steps for:
  - Corrupted BridgePort database
  - Lost SSH key (re-encrypt with new environment key)
  - Failed migration (check logs, fix SQL, redeploy)

### 12.4 Troubleshooting (`docs/operations/troubleshooting.md`)

Both per-feature + general debug guide (per interview decision):

**General Debugging Guide:**
1. How to read BridgePort logs (`docker logs bridgeport`)
2. Health endpoint: what each field means
3. Common log messages and what they indicate
4. Database state inspection (safely)
5. SSH connectivity debugging

**Quick Troubleshooting Table:**

| Symptom | Likely Cause | Solution |
|---------|-------------|----------|
| Can't connect to server | SSH key issue | Check key, test manually |
| Container not found | Discovery not run | Run discovery |
| Migration failed on start | Bad SQL | Check logs, fix migration |
| Agent not reporting | Token mismatch | Regenerate token, redeploy |
| Notifications not sent | SMTP not configured | Check admin SMTP settings |
| Health check always fails | Wrong health endpoint | Verify URL in service config |

**Per-Feature Troubleshooting:**
Each feature guide (section 9) also includes its own troubleshooting section at the bottom. This central guide covers cross-cutting and general issues.

---

## 13. Contributing & Development

### 13.1 CONTRIBUTING.md

Full developer experience (per interview decision):

1. **Welcome**
   - Encourage contributions, explain the project's goals
   - Types of contributions welcome: bugs, features, docs, plugins

2. **Development Setup**
   - Prerequisites: Node.js (version), Go (version for agent/CLI)
   - Clone, install, configure
   - Hot reload: backend (`npm run dev`) + frontend (`cd ui && npm run dev`)
   - Database setup and seeding
   - Expected output at each step

3. **Development Workflow**
   - Branch naming: `feature/...`, `fix/...`, `docs/...`
   - Making changes
   - Running checks before committing
   - Testing your changes

4. **Database Migration Guide** (brief, links to `docs/development/database-migrations.md`)

5. **Code Style & Conventions**
   - TypeScript conventions
   - React component patterns
   - API route patterns
   - Prisma usage patterns

6. **Pull Request Process**
   - PR template (auto-applied)
   - Review expectations
   - CI checks that must pass

7. **Common Pitfalls**
   - Prisma type issues when checking files in isolation
   - `CommandClient.exec()` not `execute()`
   - SSH key decryption patterns
   - ContainerImage is required for every Service

8. **Getting Help**
   - Where to ask questions
   - How to report issues

### 13.2 Development Architecture (`docs/development/architecture.md`)

Codebase deep dive for contributors:

- Directory structure with purpose of each directory
- Backend architecture: Fastify plugins, route registration, service layer
- Frontend architecture: React + Vite, Zustand stores, component patterns
- Database: Prisma + SQLite, migration strategy
- Scheduler system: how background jobs work
- Authentication flow: JWT + API tokens
- Key design decisions and tradeoffs

### 13.3 Database Migrations (`docs/development/database-migrations.md`)

Extract and expand the migration guide from CLAUDE.md:

- The golden rule (container updates must always work)
- Step-by-step migration workflow
- Handling breaking changes with examples
- Testing migrations against production data
- What to never do (with explanations of why)
- Emergency recovery procedures

### 13.4 Building (`docs/development/building.md`)

- Building the Docker image
- Building the Go agent (all platforms)
- Building the CLI (all platforms)
- Version derivation system (git-based)
- CI/CD pipeline overview (if applicable)

---

## 14. Community & Legal

### 14.1 LICENSE

AGPL-3.0 full text.

**Rationale for AGPL-3.0** (brief note in README):
- Free to use, modify, and deploy for any purpose
- If you modify BridgePort and offer it as a service, you must share your modifications
- This ensures improvements flow back to the community
- If you just use BridgePort internally (even commercially), no obligations beyond the license

### 14.2 SECURITY.md

Standard security policy:
- How to report vulnerabilities (email, not public issues)
- What constitutes a security issue
- Response timeline expectations
- Supported versions
- Security-related configuration recommendations

### 14.3 CHANGELOG.md

Follows [Keep a Changelog](https://keepachangelog.com/) format:
- Unreleased section at top
- Versions with dates
- Categories: Added, Changed, Fixed, Removed, Security
- Each entry links to relevant PR/commit

---

## 15. OpenAPI / Swagger Integration

### Implementation Plan

1. **Install packages:**
   ```bash
   npm install @fastify/swagger @fastify/swagger-ui
   ```

2. **Register plugin in `src/server.ts`:**
   - Configure with project metadata (title, description, version, license)
   - Serve Swagger UI at `/api/docs`
   - Generate OpenAPI spec at `/api/docs/json`

3. **Enrich route schemas:**
   - BridgePort already uses Zod for validation
   - Use `zod-to-json-schema` or `fastify-type-provider-zod` to auto-convert
   - Verify package compatibility with the current Fastify version before adding
   - Add `description` fields to schemas where missing
   - Add `tags` to group endpoints by feature
   - Add example values for request/response bodies

4. **Tag groups** (map to feature areas):
   - Authentication
   - Users
   - Environments
   - Servers
   - Services
   - Container Images
   - Registries
   - Secrets
   - Config Files
   - Databases
   - Deployment Plans
   - Monitoring
   - Health Checks
   - Notifications
   - Topology
   - Webhooks
   - System Settings
   - Admin

5. **Documentation integration:**
   - `docs/reference/api.md` explains auth and links to Swagger UI
   - Swagger UI is self-hosted alongside BridgePort at `/api/docs`

---

## 16. Quality Standards

Every document must meet these standards before being considered complete.

### Content Standards
- [ ] Opens with a one-sentence summary
- [ ] Has a table of contents (if > 3 sections)
- [ ] Every command is copy-pasteable
- [ ] Expected output is shown after commands where non-obvious
- [ ] Decision points have clear guidance (flowchart or comparison table)
- [ ] Cross-links to related docs
- [ ] Troubleshooting section for feature guides
- [ ] No broken links
- [ ] No assumptions about reader's BridgePort knowledge

### Formatting Standards
- [ ] Uses GitHub-flavored markdown
- [ ] Admonitions used for important callouts (`> [!NOTE]`, `> [!WARNING]`, `> [!TIP]`)
- [ ] Code blocks have language tags
- [ ] Mermaid diagrams render correctly on GitHub
- [ ] Tables are properly aligned
- [ ] Consistent heading hierarchy (no skipping levels)
- [ ] Line length reasonable for readability

### Accuracy Standards
- [ ] All commands tested and verified
- [ ] Environment variable names match actual code
- [ ] Default values match actual defaults
- [ ] API endpoint paths match actual routes
- [ ] UI descriptions match current UI behavior

### Maintenance Plan
- Major features changes must include doc updates
- CHANGELOG.md updated with every release
- Quarterly review of docs for accuracy
- Community feedback incorporated via GitHub issues labeled `documentation`

---

## Appendix: File Inventory

| File | Status | Priority | Description |
|------|--------|----------|-------------|
| `README.md` | Rewrite | Critical | The gateway - first impression |
| `LICENSE` | Create | Critical | AGPL-3.0 |
| `CONTRIBUTING.md` | Create | Critical | Full contributor guide |
| `SECURITY.md` | Create | High | Security policy |
| `CHANGELOG.md` | Create | High | Release history |
| `docs/README.md` | Rewrite | Critical | Docs index |
| `docs/getting-started.md` | Rewrite | Critical | 5-minute quickstart |
| `docs/concepts.md` | Create | Critical | Architecture + glossary |
| `docs/installation.md` | Create | Critical | Multi-path install |
| `docs/configuration.md` | Rewrite | Critical | Env vars + recipes |
| `docs/guides/servers.md` | Rewrite | High | Server management |
| `docs/guides/services.md` | Rewrite | High | Service management |
| `docs/guides/environments.md` | Rewrite | High | Environment setup |
| `docs/guides/container-images.md` | Rewrite | High | Image management |
| `docs/guides/registries.md` | Rewrite | High | Registry connections |
| `docs/guides/secrets.md` | Rewrite | High | Secret workflow |
| `docs/guides/config-files.md` | Rewrite | High | Config file management |
| `docs/guides/databases.md` | Rewrite | High | Database management |
| `docs/guides/storage.md` | Create | Medium | S3/Spaces storage configuration |
| `docs/guides/monitoring.md` | Rewrite | High | Monitoring quick start |
| `docs/guides/monitoring-servers.md` | Create | Medium | Server monitoring deep dive |
| `docs/guides/monitoring-services.md` | Create | Medium | Service monitoring deep dive |
| `docs/guides/monitoring-databases.md` | Create | Medium | Database monitoring deep dive |
| `docs/guides/health-checks.md` | Create | Medium | Health check system |
| `docs/guides/notifications.md` | Create | Medium | Notification system |
| `docs/guides/topology.md` | Create | Medium | Topology diagram |
| `docs/guides/deployment-plans.md` | Create | Medium | Deployment orchestration |
| `docs/guides/webhooks.md` | Rewrite | Medium | Webhook integration |
| `docs/guides/users.md` | Create | High | User management + RBAC guide |
| `docs/reference/api.md` | Rewrite | High | API overview + Swagger link |
| `docs/reference/cli.md` | Rewrite | High | CLI command reference |
| `docs/reference/agent.md` | Create | High | Agent reference |
| `docs/reference/events.md` | Create | High | SSE real-time events reference |
| `docs/reference/plugins.md` | Create | High | Plugin authoring guide |
| `docs/reference/environment-settings.md` | Create | Medium | Settings reference |
| `docs/reference/system-settings.md` | Create | Medium | System settings reference |
| `docs/operations/upgrades.md` | Create | High | Upgrade guide |
| `docs/operations/security.md` | Create | High | Security + hardening |
| `docs/operations/backup-restore.md` | Rewrite | High | Backup strategies |
| `docs/operations/troubleshooting.md` | Rewrite | High | Debug guide |
| `docs/operations/patterns.md` | Create | Medium | Architecture patterns |
| `docs/development/setup.md` | Create | High | Dev environment |
| `docs/development/architecture.md` | Create | Medium | Codebase architecture |
| `docs/development/database-migrations.md` | Create | Medium | Migration guide |
| `docs/development/building.md` | Create | Medium | Build instructions |

**Total: 45 documents**
- Critical: 7 files
- High: 19 files
- Medium: 19 files

---

*This spec was created through an in-depth interview process. All decisions reflect the project owner's explicit preferences for audience, tone, structure, and content depth.*
