# BridgePort Dev Environments Specification

## Overview

This specification defines an on-demand ephemeral development environment feature for BridgePort. The feature enables one-click deployment of service sets with specific image tags, supporting multiple concurrent environments on dedicated servers with automatic lifecycle management.

**Status:** Draft
**Author:** Engineering
**Created:** 2026-02-03

## Goals

1. Enable developers, QA, and CI/CD to spin up isolated development environments on demand
2. Provide one-click deployment of predefined service templates with configurable image tags
3. Support multiple concurrent environments on shared infrastructure
4. Automate environment lifecycle with TTL-based expiration and cleanup
5. Maintain BridgePort's generic design - no external dependencies or provider-specific requirements

## Non-Goals

- Production-grade high availability for dev environments
- Auto-scaling of dev server infrastructure
- Complex RBAC (all authenticated users have equal access)
- Hibernation/pause functionality

---

## Architecture

### Module Design

Dev Environments is implemented as an **optional module** that can be enabled/disabled via configuration. It operates as a separate module with loose coupling to core BridgePort concepts.

```
bridgeport/
├── src/
│   ├── modules/
│   │   └── dev-environments/     # New module
│   │       ├── controllers/
│   │       ├── services/
│   │       ├── entities/
│   │       └── adapters/         # DB restore adapters, proxy adapters
```

### Data Model

```
DevEnvironment
├── id: string (UUID)
├── name: string (user-provided, unique)
├── templateId: string (FK to DevTemplate)
├── serverId: string (FK to Server)
├── status: enum (creating, running, expired, deleting, failed)
├── imageTag: string (applied to all services)
├── createdAt: datetime
├── expiresAt: datetime
├── deletedAt: datetime (null until soft deleted)
├── createdBy: string (user email/id)
└── metadata: jsonb

DevTemplate
├── id: string (UUID)
├── name: string (e.g., "full-stack", "api-only")
├── description: string
├── services: DevTemplateService[]
├── sharedServices: string[] (service names that point to staging)
├── resourceLimits: ResourceLimits
├── defaultTtlDays: number (default: 7)
├── maxTtlDays: number (default: 14)
└── dataSource: enum (staging, production, seed)

DevTemplateService
├── serviceName: string
├── imageRepository: string
├── containerPort: number
├── envTemplate: string (FK to EnvTemplate)
├── isIsolated: boolean (vs shared)
├── cpuLimit: string (e.g., "1.0")
├── memoryLimit: string (e.g., "2g")
└── healthCheckPath: string (optional)

DevServer
├── id: string (UUID)
├── serverId: string (FK to Server)
├── maxEnvironments: number
├── baseDomain: string (e.g., "dev.example.com")
├── urlPattern: enum (see URL Patterns)
└── sslStrategy: enum (letsencrypt, origin-cert, user-provided)
```

### URL Patterns

The system supports multiple URL patterns, configurable per dev server:

| Pattern | Example | Use Case |
|---------|---------|----------|
| `{env}.{domain}/{service}` | `myenv.dev.example.com/api` | Path-based routing |
| `{service}-{env}.{domain}` | `api-myenv.dev.example.com` | Service-prefixed subdomains |
| `{env}-{service}.{domain}` | `myenv-api.dev.example.com` | Env-prefixed subdomains |

---

## Core Features

### 1. Template Management

Templates define service sets that work together. Admins create templates via UI or CLI.

**Template Configuration:**
```yaml
name: full-stack
description: Complete application stack with frontend, APIs, and Keycloak
defaultTtlDays: 7
maxTtlDays: 14
dataSource: staging

services:
  - name: gateway
    image: caddy:2-alpine
    port: 80
    isolated: true
    resources:
      cpu: "0.5"
      memory: "512m"

  - name: app-api
    image: bios-registry/bios-backend
    port: 8000
    isolated: true
    envTemplate: api-env-template
    healthCheck: /health
    resources:
      cpu: "1.0"
      memory: "2g"

  - name: keycloak
    isolated: false  # Points to staging Keycloak
    stagingUrl: https://keycloak-staging.bridgein.com
```

**Shared vs Isolated Services:**
- **Isolated**: Containerized per environment with environment-specific configuration
- **Shared**: Point to existing staging/production services (e.g., Keycloak, third-party APIs)

### 2. Environment Creation

#### Manual Creation (UI/CLI)

**CLI Command:**
```bash
bridgeport env create \
  --name myfeature \
  --template full-stack \
  --tag sha-abc123 \
  --ttl 7
```

**UI Flow (Progressive Disclosure):**
1. **Simple mode**: Name + Template + Tag → Create
2. **Advanced mode** (expandable): TTL override, data source, service-specific tags

#### Automated Creation (Image Tag Detection)

BridgePort monitors the container registry for images matching configured patterns.

**Trigger Pattern:**
- Tag prefix: `dev-*` (e.g., `dev-myfeature-sha123`)
- Required image labels:
  - `bridgeport.env`: Environment name (e.g., `myfeature`)
  - `bridgeport.template`: Template name (e.g., `full-stack`)

**CI/CD Example:**
```yaml
# GitHub Actions
- name: Build and push
  run: |
    docker build \
      --label "bridgeport.env=${{ github.head_ref }}" \
      --label "bridgeport.template=full-stack" \
      -t registry.example.com/app:dev-${{ github.head_ref }}-${{ github.sha }} .
    docker push registry.example.com/app:dev-${{ github.head_ref }}-${{ github.sha }}
```

**Detection Flow:**
1. Registry webhook or polling detects new image with `dev-*` tag
2. Extract environment name and template from labels
3. If environment exists: Update in place (deploy new image, preserve data)
4. If environment doesn't exist: Create new environment
5. TTL is NOT reset on updates

### 3. Database Management

#### Database Strategy

Each dev environment gets its own database within the shared managed Postgres instance.

**Database Naming:** `dev_{env_name}` (e.g., `dev_myfeature`)

**Data Sources:**
- **staging** (default): Restore from latest staging backup
- **production**: Restore from latest production backup (anonymized)
- **seed**: Fresh database with predefined seed data

#### Plugin/Adapter System

Database restoration is handled via adapters to support different backup systems:

```typescript
interface DatabaseRestoreAdapter {
  name: string;
  restore(config: RestoreConfig): Promise<void>;
  listBackups(): Promise<Backup[]>;
  validateConfig(): Promise<boolean>;
}

// Built-in adapters
class S3BackupAdapter implements DatabaseRestoreAdapter { }
class DOSpacesAdapter implements DatabaseRestoreAdapter { }
class PgDumpAdapter implements DatabaseRestoreAdapter { }
```

**Restore Flow:**
1. Create new database `dev_{env_name}`
2. Fetch latest backup from configured source
3. Restore using pg_restore
4. Run any post-restore migrations/scripts

### 4. Networking & Routing

#### Container Networking

Each environment runs in an isolated Docker network:

```
Network: dev_{env_name}
├── gateway (Caddy)
├── app-api
├── os-api
└── static
```

#### Reverse Proxy (Caddy)

BridgePort manages a Caddy instance on the dev server that handles routing for all environments.

**Auto-generated Caddyfile:**
```caddyfile
# Environment: myfeature
myfeature.dev.example.com {
  handle /api/* {
    reverse_proxy dev_myfeature_app-api:8000
  }
  handle /os/* {
    reverse_proxy dev_myfeature_os-api:8000
  }
  handle {
    reverse_proxy dev_myfeature_static:3000
  }
}
```

**Caddy Management:**
- BridgePort generates Caddyfile snippets per environment
- Includes all snippets in main Caddyfile
- Hot-reloads Caddy on environment create/delete

#### SSL/TLS Options

| Strategy | Description | Configuration |
|----------|-------------|---------------|
| Let's Encrypt | Auto-provisioned certificates | Set `sslStrategy: letsencrypt` |
| Origin Certificates | For Cloudflare-proxied domains | Upload cert/key, set `sslStrategy: origin-cert` |
| User-Provided | Custom wildcard certificates | Upload cert/key, set `sslStrategy: user-provided` |

### 5. Configuration & Secrets

#### Environment-Aware Secrets

The secrets system understands environment context and resolves values dynamically:

```yaml
# Template env configuration
DATABASE_URL: "{{secret:database_url}}"  # Resolves to dev_{env_name} database
REDIS_URL: "{{secret:redis_url}}"        # Shared staging Redis
DJANGO_SECRET_KEY: "{{secret:django_secret}}"
ENV_NAME: "{{env:name}}"                 # Injects environment name
BASE_URL: "{{env:url}}"                  # Injects environment URL
```

**Resolution Order:**
1. Environment-specific override (if set)
2. Template default
3. Global secret value

#### Per-Environment Overrides

Users can override template defaults when creating environments:

```bash
bridgeport env create \
  --name myfeature \
  --template full-stack \
  --set DATABASE_URL=postgres://custom/db \
  --set FEATURE_FLAG=true
```

### 6. Lifecycle Management

#### TTL & Expiration

| Setting | Default | Max |
|---------|---------|-----|
| TTL | 7 days | 14 days |
| Grace period after expiration | 24 hours | 24 hours |

**Lifecycle States:**
```
creating → running → expired → deleting → deleted
                ↓
              failed
```

**Expiration Flow:**
1. **T-24h**: Send expiration warning notification
2. **T-0**: Mark as `expired`, stop accepting new deployments
3. **T+24h (grace period)**: Begin soft delete
4. **T+48h**: Hard delete (remove containers, database, config)

#### Cleanup Process

1. Stop all containers gracefully (30s timeout)
2. Remove Docker network
3. Remove Caddy configuration, reload
4. Drop database `dev_{env_name}`
5. Clean up secrets and config files
6. Update environment status to `deleted`

#### Update Behavior

When a new image is pushed for an existing environment:
- Deploy new image to running containers
- Preserve database and configuration
- Do NOT reset TTL (original expiration stands)
- Log deployment event

### 7. Resource Management

#### Container Resource Limits

Each service in a template specifies resource limits enforced via Docker:

```yaml
resources:
  cpu: "1.0"      # Docker --cpus
  memory: "2g"    # Docker --memory
```

**Template-Level Defaults:**
```yaml
resourceLimits:
  defaultCpu: "0.5"
  defaultMemory: "1g"
  maxCpuPerEnv: "4.0"
  maxMemoryPerEnv: "8g"
```

#### Capacity Management

- Dev server has `maxEnvironments` limit
- Creation fails if limit reached
- Dashboard shows current/max environments

### 8. Observability

#### Health Checks

Two levels of health checking:
1. **Container health**: Docker HEALTHCHECK for each container
2. **HTTP health**: Check configured health endpoints return 2xx

**Health Status:**
- `healthy`: All containers running, all health checks passing
- `degraded`: Some containers unhealthy
- `unhealthy`: Critical services down

#### Logs Access

Users can view logs for any service in their environment:

```bash
bridgeport env logs myfeature --service app-api --tail 100
```

UI provides log viewer with:
- Service selector
- Tail/follow mode
- Search/filter
- Download

#### Metrics

Per-environment metrics available in dashboard:
- CPU usage (per service and total)
- Memory usage (per service and total)
- Network I/O
- Container restart count

#### Container Exec

For debugging, users can exec into containers:

```bash
bridgeport env exec myfeature app-api -- /bin/sh
```

### 9. Failure Handling

#### Retry Strategy

Failed operations retry with exponential backoff:
- Max retries: 3
- Backoff: 1s, 2s, 4s
- After exhaustion: Leave in `failed` state for debugging

#### Failed State

When an environment enters `failed` state:
- Partial resources remain for debugging
- User can view logs, exec into containers
- Manual cleanup available via `bridgeport env destroy --force`
- Failed environments still count against capacity

### 10. Notifications

#### Supported Channels

| Event | Email | Webhook | Slack/Discord |
|-------|-------|---------|---------------|
| Environment created | ✓ | ✓ | ✓ |
| Environment updated | - | ✓ | ✓ |
| Expiration warning (24h) | ✓ | ✓ | ✓ |
| Environment expired | ✓ | ✓ | ✓ |
| Environment deleted | - | ✓ | ✓ |
| Creation failed | ✓ | ✓ | ✓ |

#### Webhook Payload

```json
{
  "event": "environment.created",
  "timestamp": "2026-02-03T10:00:00Z",
  "environment": {
    "id": "uuid",
    "name": "myfeature",
    "template": "full-stack",
    "url": "https://myfeature.dev.example.com",
    "expiresAt": "2026-02-10T10:00:00Z"
  },
  "user": "developer@example.com"
}
```

### 11. Audit Logging

Basic event logging for compliance and debugging:

```
| Timestamp | Event | Environment | User | Details |
|-----------|-------|-------------|------|---------|
| 2026-02-03 10:00 | created | myfeature | dev@example.com | template=full-stack |
| 2026-02-03 12:00 | deployed | myfeature | ci-bot | tag=sha-abc123 |
| 2026-02-10 10:00 | expired | myfeature | system | ttl=7d |
| 2026-02-11 10:00 | deleted | myfeature | system | grace_period=24h |
```

---

## User Interface

### Dashboard Views

**List View:**
- Sortable/filterable table
- Columns: Name, Template, Status, Created, Expires, Owner
- Bulk actions: Delete selected

**Dashboard View:**
- Card grid showing environment health at a glance
- Each card shows: Name, status indicator, TTL countdown, service health
- Quick actions: Open, Logs, Delete

### Environment Detail Page

- Status and health overview
- Service list with individual status
- Configuration (env vars, secrets)
- Logs panel (tabbed by service)
- Metrics graphs
- Actions: Redeploy, Delete

### Template Management (Admin)

- List of templates with usage stats
- Template editor with YAML/form view
- Service configuration with resource limits
- Preview of generated Docker/Caddy config

---

## CLI Interface

```bash
# List environments
bridgeport env list
bridgeport env list --template full-stack --status running

# Create environment
bridgeport env create --name myfeature --template full-stack --tag sha-abc123
bridgeport env create --name myfeature --template full-stack --tag sha-abc123 --ttl 14

# Get environment details
bridgeport env get myfeature
bridgeport env get myfeature --json

# View logs
bridgeport env logs myfeature
bridgeport env logs myfeature --service app-api --tail 100 --follow

# Execute command in container
bridgeport env exec myfeature app-api -- /bin/sh

# Redeploy with new tag
bridgeport env deploy myfeature --tag sha-def456

# Delete environment
bridgeport env delete myfeature
bridgeport env delete myfeature --force  # Skip grace period

# Template management
bridgeport template list
bridgeport template create --file template.yaml
bridgeport template update full-stack --file template.yaml
bridgeport template delete full-stack
```

---

## API Endpoints

```
# Environments
GET    /api/v1/environments
POST   /api/v1/environments
GET    /api/v1/environments/:name
PUT    /api/v1/environments/:name
DELETE /api/v1/environments/:name
POST   /api/v1/environments/:name/deploy
GET    /api/v1/environments/:name/logs/:service
POST   /api/v1/environments/:name/exec/:service

# Templates
GET    /api/v1/templates
POST   /api/v1/templates
GET    /api/v1/templates/:name
PUT    /api/v1/templates/:name
DELETE /api/v1/templates/:name

# Dev Servers
GET    /api/v1/dev-servers
POST   /api/v1/dev-servers
GET    /api/v1/dev-servers/:id
PUT    /api/v1/dev-servers/:id
DELETE /api/v1/dev-servers/:id
```

---

## Implementation Phases

### Phase 1: Core Automation (MVP)

**Goal:** Full automation from image push to running environment

1. Data model and database migrations
2. Template management (API, CLI, basic UI)
3. Environment creation service
4. Database adapter system with Spaces/S3 adapter
5. Docker Compose generation and deployment
6. Caddy configuration management
7. Image tag detection and auto-creation
8. TTL expiration and cleanup job
9. Basic CLI commands

### Phase 2: Observability

1. Health check system
2. Log aggregation and viewer
3. Metrics collection
4. Dashboard and list views
5. Container exec capability

### Phase 3: Polish & Integration

1. Notification system (email, webhooks, Slack)
2. Advanced UI (environment detail page, template editor)
3. Resource usage reporting
4. Audit log viewer

---

## Configuration

### Module Configuration

```yaml
# bridgeport.config.yaml
modules:
  devEnvironments:
    enabled: true

    # Default settings
    defaults:
      ttlDays: 7
      maxTtlDays: 14
      gracePeriodHours: 24

    # Registry monitoring
    registry:
      pollIntervalSeconds: 60
      tagPattern: "^dev-"

    # Cleanup job
    cleanup:
      cronSchedule: "0 * * * *"  # Hourly

    # Notifications
    notifications:
      email:
        enabled: true
        expirationWarningHours: 24
      webhooks:
        enabled: true
        url: "https://hooks.example.com/bridgeport"
      slack:
        enabled: false
        webhookUrl: ""
```

### Dev Server Configuration

```yaml
# Via API or CLI
devServer:
  serverId: "server-uuid"
  maxEnvironments: 5
  baseDomain: "dev.example.com"
  urlPattern: "env-service"  # {env}-{service}.{domain}

  ssl:
    strategy: "origin-cert"
    certPath: "/etc/certs/origin.pem"
    keyPath: "/etc/certs/origin-key.pem"

  database:
    adapter: "spaces"
    config:
      endpoint: "fra1.digitaloceanspaces.com"
      bucket: "backups"
      prefix: "postgres/"
```

---

## Risks & Mitigations

### Resource Exhaustion

**Risk:** Dev environments consuming all server resources

**Mitigations:**
- Hard resource limits via Docker (CPU, memory)
- Max environments per server
- Per-template resource budgets
- Monitoring and alerting on resource usage

### Complexity Creep

**Risk:** Feature becoming too complex to maintain

**Mitigations:**
- Progressive disclosure in UI (simple by default)
- Opinionated defaults that work for most cases
- Clear phase boundaries - ship MVP before adding features
- Plugin/adapter system for extensibility without core changes

### Orphaned Environments

**Risk:** Environments not cleaned up properly

**Mitigations:**
- Hard TTL with no extensions
- Automated cleanup job running hourly
- Capacity limits prevent unbounded growth
- Failed state still counts against capacity

---

## Success Metrics

1. **Time to environment**: < 5 minutes from image push to accessible environment
2. **Environment reliability**: > 95% of environment creations succeed
3. **Resource efficiency**: Dev server at < 80% resource utilization
4. **Cleanup rate**: 100% of environments cleaned up within grace period
5. **User adoption**: > 80% of PRs have associated dev environments

---

## Open Questions

1. Should we support environment cloning (create new env from existing)?
2. Should environments support custom domains beyond the pattern?
3. How should we handle database migrations between image versions?
4. Should there be a "promote to staging" workflow?

---

## Appendix

### Example Template: Full Stack

```yaml
name: full-stack
description: Complete BridgeIn application stack
defaultTtlDays: 7
maxTtlDays: 14
dataSource: staging

resourceLimits:
  maxCpuPerEnv: "4.0"
  maxMemoryPerEnv: "8g"

services:
  - name: gateway
    image: caddy:2-alpine
    port: 80
    isolated: true
    resources:
      cpu: "0.25"
      memory: "256m"

  - name: static-app
    image: bios-registry/bios-frontend-app
    port: 3000
    isolated: true
    resources:
      cpu: "0.5"
      memory: "512m"

  - name: static-os
    image: bios-registry/bios-frontend-os
    port: 3000
    isolated: true
    resources:
      cpu: "0.5"
      memory: "512m"

  - name: app-api
    image: bios-registry/bios-backend
    port: 8000
    isolated: true
    envTemplate: api-env-template
    healthCheck: /api/health/
    resources:
      cpu: "1.0"
      memory: "2g"

  - name: os-api
    image: bios-registry/bios-backend
    port: 8000
    isolated: true
    envTemplate: api-env-template
    healthCheck: /api/health/
    resources:
      cpu: "1.0"
      memory: "2g"

sharedServices:
  - name: keycloak
    url: https://keycloak-staging.bridgein.com
  - name: redis
    url: redis://staging-redis.internal:6379
```

### Example: CI/CD Integration

```yaml
# .github/workflows/dev-environment.yml
name: Dev Environment

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  deploy-dev:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build and push with dev labels
        run: |
          # Sanitize branch name for environment name
          ENV_NAME=$(echo "${{ github.head_ref }}" | sed 's/[^a-zA-Z0-9]/-/g' | cut -c1-20)

          docker build \
            --label "bridgeport.env=${ENV_NAME}" \
            --label "bridgeport.template=full-stack" \
            -t ${{ env.REGISTRY }}/app:dev-${ENV_NAME}-${{ github.sha }} \
            .

          docker push ${{ env.REGISTRY }}/app:dev-${ENV_NAME}-${{ github.sha }}

      - name: Comment PR with environment URL
        uses: actions/github-script@v7
        with:
          script: |
            const envName = '${{ github.head_ref }}'.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 20);
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `🚀 Dev environment deploying: https://${envName}.dev.example.com`
            });
```
