# Environments

Environments are logical groupings (like staging and production) that isolate servers, services, secrets, and settings from each other -- each with its own SSH key, monitoring configuration, and operational defaults.

## Table of Contents

1. [Quick Start](#quick-start)
2. [How It Works](#how-it-works)
3. [Step-by-Step Guide](#step-by-step-guide)
   - [Creating an Environment](#creating-an-environment)
   - [SSH Key Management](#ssh-key-management)
   - [Per-Module Settings](#per-module-settings)
   - [Switching Environments in the UI](#switching-environments-in-the-ui)
4. [Configuration Options](#configuration-options)
5. [Best Practices](#best-practices)
6. [Troubleshooting](#troubleshooting)
7. [Related](#related)

---

## Quick Start

Set up your first environment in under a minute:

1. Navigate to any page and look for the **environment selector** in the left sidebar.
2. Click it and select **Create Environment**.
3. Enter a name (e.g., `staging`) and click **Create**.
4. Upload your SSH private key in **Configuration > Environment Settings > General**.

You are ready to add servers to this environment.

---

## How It Works

An environment is a top-level container in BRIDGEPORT. Everything lives inside an environment: servers, services, container images, secrets, config files, databases, and registries.

```mermaid
flowchart TD
    BP[BRIDGEPORT] --> E1[Environment: staging]
    BP --> E2[Environment: production]

    E1 --> SK1[SSH Key<br>encrypted]
    E1 --> S1[Servers]
    E1 --> SEC1[Secrets]
    E1 --> CF1[Config Files]
    E1 --> DB1[Databases]
    E1 --> REG1[Registries]
    E1 --> SET1[Settings<br>5 modules]

    E2 --> SK2[SSH Key<br>encrypted]
    E2 --> S2[Servers]
    E2 --> SEC2[Secrets]
    E2 --> CF2[Config Files]
    E2 --> DB2[Databases]
    E2 --> REG2[Registries]
    E2 --> SET2[Settings<br>5 modules]

    style BP fill:#4f46e5,color:#fff
    style E1 fill:#1e293b,color:#fff
    style E2 fill:#1e293b,color:#fff
```

**Key isolation rules:**
- Servers belong to exactly one environment.
- Secrets, config files, and container images are scoped to an environment.
- SSH keys are encrypted per environment -- a staging key cannot access production servers.
- Per-module settings are configured independently for each environment.
- Users and system settings are global (not environment-scoped).

When creating an environment, BRIDGEPORT automatically creates default settings for all five modules (General, Monitoring, Operations, Data, Configuration).

---

## Step-by-Step Guide

### Creating an Environment

**UI:**

1. Click the environment selector in the left sidebar.
2. Click **Create Environment** (admin only).
3. Enter a name (1-50 characters, must be unique).
4. Click **Create**.

**API:**
```http
POST /api/environments
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "name": "staging"
}
```

**Response (200):**
```json
{
  "environment": {
    "id": "clenv...",
    "name": "staging",
    "createdAt": "2026-02-25T10:00:00.000Z",
    "updatedAt": "2026-02-25T10:00:00.000Z"
  }
}
```

Returns `409 Conflict` if the name already exists. Only admins can create environments.

**List all environments:**
```http
GET /api/environments
Authorization: Bearer <token>
```

Returns all environments with server and secret counts. Available to all authenticated users.

**Delete an environment:**
```http
DELETE /api/environments/:id
Authorization: Bearer <admin-token>
```

> [!WARNING]
> Deleting an environment cascade-deletes **all** servers, services, secrets, config files, databases, registries, container images, and settings within it. This action is irreversible.

### SSH Key Management

Each environment has one SSH private key shared by all servers in that environment. The key is encrypted at rest using AES-256-GCM and stored as `nonce:ciphertext` in the database.

#### Uploading an SSH Key

**UI:** Navigate to **Configuration > Environment Settings > General** and paste the private key.

**API:**
```http
PUT /api/environments/:envId/ssh
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "sshPrivateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA...\n-----END OPENSSH PRIVATE KEY-----",
  "sshUser": "deploy"
}
```

The `sshUser` field (default: `root`) is stored in the General Settings module and used for all SSH connections to servers in this environment.

#### Checking SSH Configuration

```http
GET /api/environments/:envId/ssh
Authorization: Bearer <token>
```

**Response:**
```json
{
  "configured": true,
  "sshUser": "deploy"
}
```

This endpoint tells you whether a key is uploaded and what SSH user is set, but does not return the private key itself.

#### Retrieving the Private Key (Admin Only)

For CLI tools and automation, admins can retrieve the actual private key:

```http
GET /api/environments/:envId/ssh-key
Authorization: Bearer <admin-token>
```

**Response:**
```json
{
  "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----",
  "username": "deploy"
}
```

This access is logged in the audit trail.

#### Removing an SSH Key

```http
DELETE /api/environments/:envId/ssh
Authorization: Bearer <admin-token>
```

> [!WARNING]
> Removing the SSH key breaks connectivity to **all** servers in this environment. Health checks, deployments, discovery, and metrics collection will fail until a new key is uploaded.

### Per-Module Settings

Each environment has five settings modules, created automatically when the environment is created. All settings are admin-only.

```mermaid
flowchart LR
    ENV[Environment] --> G[General]
    ENV --> M[Monitoring]
    ENV --> O[Operations]
    ENV --> D[Data]
    ENV --> C[Configuration]

    G -.->|sshUser| G1[SSH username]
    M -.->|intervals, retention,<br>metric toggles| M1[Health / Discovery /<br>Metrics intervals]
    O -.->|defaults for new servers| O1[Docker mode /<br>Metrics mode]
    D -.->|backup & monitoring defaults| D1[Backup downloads /<br>DB monitoring]
    C -.->|access controls| C1[Secret reveal<br>permissions]

    style ENV fill:#4f46e5,color:#fff
```

#### General Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sshUser` | string | `root` | SSH username for all servers in this environment |

#### Monitoring Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `false` | Master toggle for all automated monitoring |
| `serverHealthIntervalMs` | int | `60000` | Server health check interval |
| `serviceHealthIntervalMs` | int | `60000` | Service health check interval |
| `discoveryIntervalMs` | int | `300000` | Container discovery interval |
| `metricsIntervalMs` | int | `300000` | SSH metrics collection interval |
| `updateCheckIntervalMs` | int | `1800000` | Registry update check interval |
| `backupCheckIntervalMs` | int | `60000` | Backup schedule check interval |
| `metricsRetentionDays` | int | `7` | Days to keep server/service metrics |
| `healthLogRetentionDays` | int | `30` | Days to keep health check logs |
| `bounceThreshold` | int | `3` | Consecutive failures before bounce alert |
| `bounceCooldownMs` | int | `900000` | Cooldown between bounce alerts |
| `collectCpu` | boolean | `true` | Collect CPU metrics |
| `collectMemory` | boolean | `true` | Collect memory metrics |
| `collectSwap` | boolean | `true` | Collect swap metrics |
| `collectDisk` | boolean | `true` | Collect disk metrics |
| `collectLoad` | boolean | `true` | Collect load average metrics |
| `collectFds` | boolean | `true` | Collect file descriptor metrics |
| `collectTcp` | boolean | `true` | Collect TCP connection metrics |
| `collectProcesses` | boolean | `true` | Collect top processes (agent only) |
| `collectTcpChecks` | boolean | `true` | Run TCP port checks (agent only) |
| `collectCertChecks` | boolean | `true` | Run TLS certificate checks (agent only) |

#### Operations Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultDockerMode` | string | `ssh` | Docker mode for new servers (`ssh` or `socket`) |
| `defaultMetricsMode` | string | `disabled` | Metrics mode for new servers (`disabled`, `ssh`, or `agent`) |

#### Data Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `allowBackupDownload` | boolean | `false` | Allow downloading database backups |
| `defaultMonitoringEnabled` | boolean | `false` | Enable monitoring by default for new databases |
| `defaultCollectionIntervalSec` | int | `300` | Default monitoring collection interval for new databases |

#### Configuration Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `allowSecretReveal` | boolean | `true` | Whether users can reveal secret values in the UI |

#### Managing Settings

**Read settings for a module:**
```http
GET /api/environments/:envId/settings/monitoring
Authorization: Bearer <admin-token>
```

**Update settings:**
```http
PATCH /api/environments/:envId/settings/monitoring
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "enabled": true,
  "serverHealthIntervalMs": 30000,
  "metricsRetentionDays": 14
}
```

**Reset a module to defaults:**
```http
POST /api/environments/:envId/settings/monitoring/reset
Authorization: Bearer <admin-token>
```

**Get the settings registry (field definitions with types and defaults):**
```http
GET /api/environments/:envId/settings/registry
Authorization: Bearer <admin-token>
```

### Switching Environments in the UI

The environment selector is in the top of the left sidebar. Click it to switch between environments. Your selection is persisted to localStorage so it survives page reloads and navigation.

All pages that show environment-scoped data (servers, services, secrets, config files, databases, container images, deployment plans, registries) automatically filter to the selected environment.

> [!TIP]
> The sidebar shows the current environment name. If you have only one environment, the selector still appears but with a single option.

---

## Configuration Options

### Environment-Level

| Setting | Where | Default | Description |
|---------|-------|---------|-------------|
| Name | Creation time | -- | Unique identifier, 1-50 characters |
| SSH Private Key | General Settings | `null` | Encrypted per-environment SSH key |
| SSH User | General Settings | `root` | Username for SSH connections |

### Per-Module Settings

See the [Per-Module Settings](#per-module-settings) section above for the complete reference of all five modules and their fields.

### Global Settings That Affect Environments

These are system-wide settings (configured in **Admin > System**) that affect environment behavior:

| Setting | Default | Description |
|---------|---------|-------------|
| `sshCommandTimeoutMs` | `60000` | SSH command timeout for all environments |
| `sshReadyTimeoutMs` | `10000` | SSH connection ready timeout |
| `activeUserWindowMin` | `15` | Active user tracking window |

---

## Best Practices

### Naming Conventions

Use clear, lowercase names that map to your deployment stages:

| Environment Name | Purpose |
|-----------------|---------|
| `production` | Live customer-facing infrastructure |
| `staging` | Pre-production testing, mirrors production |
| `development` | Development servers, more permissive settings |
| `qa` | Quality assurance and integration testing |

### Production vs Staging Configuration

| Setting | Staging | Production | Why |
|---------|---------|------------|-----|
| `monitoringEnabled` | `true` | `true` | Monitor both, but staging catches issues first |
| `serverHealthIntervalMs` | `60000` | `30000` | Tighter checks in production |
| `metricsRetentionDays` | `3` | `14` | Keep production data longer |
| `allowSecretReveal` | `true` | `false` | Lock down production secrets |
| `allowBackupDownload` | `true` | `false` | Restrict production backup access |
| `defaultMetricsMode` | `disabled` | `agent` | Full monitoring in production |
| `bounceThreshold` | `5` | `3` | Alert faster in production |

### SSH Key Rotation

1. Generate a new key pair.
2. Add the new public key to all servers in the environment.
3. Upload the new private key to BRIDGEPORT via `PUT /api/environments/:envId/ssh`.
4. Verify connectivity by running a health check on each server.
5. Remove the old public key from servers.

> [!TIP]
> Use different SSH keys for each environment. If a staging key is compromised, production remains unaffected.

---

## Troubleshooting

**"Environment already exists" (409)**
Environment names must be unique. Choose a different name.

**Cannot create environment (403)**
Only admins can create and delete environments. Check your user role.

**Settings not loading for a new environment**
Settings are created eagerly on environment creation via `createDefaultSettings()`. If settings are missing, it may indicate the environment was created before this feature was added. The settings are created on first access in that case.

**SSH key not working after upload**
- Verify the private key format (must include `-----BEGIN OPENSSH PRIVATE KEY-----` header).
- Confirm the corresponding public key is in `~/.ssh/authorized_keys` on the target servers.
- Check the SSH user matches what is configured in General Settings.
- Test manually: `ssh -i /path/to/key deploy@server-hostname`

**Deleting an environment hangs or fails**
Cascade deletion removes all related records. For environments with many servers and services, this may take a moment. If it fails, check the database logs for constraint errors.

**Environment selector not showing all environments**
All authenticated users can see all environments. If an environment is missing, it may have been deleted by another admin.

---

## Related

- [Servers](servers.md) -- adding and managing servers within environments
- [Services](services.md) -- managing Docker containers
- [Secrets](secrets.md) -- environment-scoped encrypted secrets
- [Config Files](config-files.md) -- environment-scoped configuration files
- [Environment Settings Reference](../reference/environment-settings.md) -- complete settings reference
- [System Settings Reference](../reference/system-settings.md) -- global settings that affect environments
