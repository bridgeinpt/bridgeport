# Configuration Reference

Everything you can configure in BRIDGEPORT -- environment variables for the container, plus an overview of UI-based settings.

---

## Table of Contents

- [Essential Configuration](#essential-configuration)
- [Environment Variable Reference](#environment-variable-reference)
- [Configuration Recipes](#configuration-recipes)
- [Per-Environment Settings (UI)](#per-environment-settings-ui)
- [System Settings (UI)](#system-settings-ui)

---

## Essential Configuration

BRIDGEPORT requires three environment variables. Everything else has sensible defaults.

### MASTER_KEY

The encryption key for all secrets and SSH keys stored in BRIDGEPORT. Generate it once and keep it safe.

```bash
openssl rand -base64 32
```

> [!WARNING]
> **Back up your MASTER_KEY.** It encrypts every secret and SSH key in the database. If you lose it, encrypted data cannot be recovered. Store it in a password manager or secure vault.

### JWT_SECRET

The signing key for authentication tokens. Generate a separate value from your MASTER_KEY.

```bash
openssl rand -base64 32
```

### DATABASE_URL

The path to BRIDGEPORT's SQLite database. For Docker deployments, this should point to a file inside your mounted data volume.

```
DATABASE_URL=file:/data/bridgeport.db
```

> [!TIP]
> The default value inside the Docker image is `file:/app/data/bridgeport.db`. When you mount a volume at `/data`, set `DATABASE_URL=file:/data/bridgeport.db` to store the database in the volume.

---

## Environment Variable Reference

All environment variables BRIDGEPORT accepts, grouped by concern.

### Core

| Variable | Type | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | string | `file:./data/bridgeport.db` | SQLite database path. Use `file:/data/bridgeport.db` for Docker. |
| `MASTER_KEY` | string | **required** | 32-byte base64 encryption key for secrets and SSH keys. |
| `JWT_SECRET` | string | **required** | Signing key for JWT authentication tokens. |
| `NODE_ENV` | string | `development` | Set to `production` for Docker deployments. |

### Network

| Variable | Type | Default | Description |
|---|---|---|---|
| `HOST` | string | `0.0.0.0` | Network interface to bind to. |
| `PORT` | number | `3000` | HTTP port for the web UI and API. |
| `CORS_ORIGIN` | string | _(none)_ | Allowed CORS origins. Comma-separated for multiple (e.g., `https://deploy.example.com,https://deploy2.example.com`). |

### Auth

| Variable | Type | Default | Description |
|---|---|---|---|
| `ADMIN_EMAIL` | string | _(none)_ | Email for the initial admin account. Only used on first boot when no users exist. |
| `ADMIN_PASSWORD` | string | _(none)_ | Password for the initial admin account. Minimum 8 characters. Only used on first boot. |

> [!NOTE]
> `ADMIN_EMAIL` and `ADMIN_PASSWORD` are only used once -- when BRIDGEPORT starts for the first time with an empty database. After the initial admin account is created, these variables are ignored. You can remove them from your `.env` file after first boot.

### Scheduler

Background job intervals. All values are in **seconds**. These set the global cadence; per-environment settings in the UI can further customize intervals.

| Variable | Type | Default | Description |
|---|---|---|---|
| `SCHEDULER_ENABLED` | boolean | `true` | Master toggle for all background jobs. Set to `false` to disable. |
| `SCHEDULER_SERVER_HEALTH_INTERVAL` | number | `60` | How often to check server health (seconds). |
| `SCHEDULER_SERVICE_HEALTH_INTERVAL` | number | `60` | How often to check service health (seconds). |
| `SCHEDULER_DISCOVERY_INTERVAL` | number | `300` | How often to scan for new containers (seconds). |
| `SCHEDULER_UPDATE_CHECK_INTERVAL` | number | `1800` | How often to check registries for new image tags (seconds). |
| `SCHEDULER_METRICS_INTERVAL` | number | `300` | How often to collect server/service metrics via SSH (seconds). |
| `SCHEDULER_BACKUP_CHECK_INTERVAL` | number | `60` | How often to check for scheduled backups that are due (seconds). |

### Retention

| Variable | Type | Default | Description |
|---|---|---|---|
| `METRICS_RETENTION_DAYS` | number | `7` | How many days to keep metrics data before automatic cleanup. |

### Storage

| Variable | Type | Default | Description |
|---|---|---|---|
| `UPLOAD_DIR` | string | `./uploads` | Directory for file uploads. Use `/data/uploads` in Docker with a mounted volume. |
| `PLUGINS_DIR` | string | `./plugins` | Directory containing service type and database type plugin JSON files. |

### Legacy SSH

| Variable | Type | Default | Description |
|---|---|---|---|
| `SSH_KEY_PATH` | string | _(none)_ | Path to a default SSH private key file. **Deprecated** -- use per-environment SSH keys configured in the UI instead. |
| `SSH_USER` | string | `root` | Default SSH username. **Deprecated** -- use per-environment settings instead. |

> [!NOTE]
> `SSH_KEY_PATH` and `SSH_USER` are legacy fallbacks from before BRIDGEPORT had per-environment SSH configuration. New deployments should configure SSH keys in the UI under **Configuration > Environment Settings**.

### Webhooks

| Variable | Type | Default | Description |
|---|---|---|---|
| `WEBHOOK_SECRET` | string | _(none)_ | HMAC secret for verifying incoming deployment webhook signatures. |
| `GITHUB_WEBHOOK_SECRET` | string | _(none)_ | Separate HMAC secret for GitHub webhook signature verification. |

### Sentry (Error Monitoring)

All Sentry configuration is optional. BRIDGEPORT works fine without it.

| Variable | Type | Default | Description |
|---|---|---|---|
| `SENTRY_BACKEND_DSN` | string | _(none)_ | Sentry DSN for backend (Node.js) error tracking. |
| `SENTRY_FRONTEND_DSN` | string | _(none)_ | Sentry DSN for frontend (React) error tracking. Baked into the UI at build time. |
| `SENTRY_ENVIRONMENT` | string | _(none)_ | Environment tag sent to Sentry (e.g., `production`, `staging`). |
| `SENTRY_TRACES_SAMPLE_RATE` | number | `0` | Performance tracing sample rate, from `0.0` (off) to `1.0` (100%). |
| `SENTRY_ENABLED` | boolean | `true` | Kill switch. Set to `false` to disable Sentry even when DSNs are configured. |

---

## Configuration Recipes

> [!TIP]
> Copy-paste these into your `.env` file and adjust as needed.

### Minimal (Trying It Out)

The bare minimum to get BRIDGEPORT running:

```env
MASTER_KEY=your-generated-key-here
JWT_SECRET=your-generated-secret-here
```

BRIDGEPORT will use defaults for everything else: SQLite at `./data/bridgeport.db`, port 3000, all schedulers enabled.

### Production (Recommended)

A complete production configuration with all the important settings:

```env
# Required secrets (generate with: openssl rand -base64 32)
MASTER_KEY=your-generated-key-here
JWT_SECRET=your-generated-secret-here

# Initial admin (only used on first boot)
ADMIN_EMAIL=admin@yourcompany.com
ADMIN_PASSWORD=a-strong-password-here

# Database and storage (use paths inside your mounted volume)
DATABASE_URL=file:/data/bridgeport.db
UPLOAD_DIR=/data/uploads
NODE_ENV=production

# CORS (set to your domain when using a reverse proxy)
CORS_ORIGIN=https://deploy.yourcompany.com

# Webhooks (for CI/CD integration)
# WEBHOOK_SECRET=your-webhook-secret-here
# GITHUB_WEBHOOK_SECRET=your-github-webhook-secret-here
```

### High-Frequency Monitoring

For critical infrastructure where you need faster detection of issues:

```env
# Check health every 30 seconds instead of 60
SCHEDULER_SERVER_HEALTH_INTERVAL=30
SCHEDULER_SERVICE_HEALTH_INTERVAL=30

# Collect metrics every minute instead of 5 minutes
SCHEDULER_METRICS_INTERVAL=60

# Check for new containers every 2 minutes instead of 5
SCHEDULER_DISCOVERY_INTERVAL=120

# Check registries every 10 minutes instead of 30
SCHEDULER_UPDATE_CHECK_INTERVAL=600

# Keep metrics longer (30 days instead of 7)
METRICS_RETENTION_DAYS=30
```

> [!NOTE]
> Higher frequency means more SSH connections to your servers. If you're managing many servers, consider deploying the [monitoring agent](reference/agent.md) instead -- it pushes metrics without BRIDGEPORT needing to poll.

### CI/CD Integration

For pipeline-triggered deployments via webhooks:

```env
# Webhook signature verification
WEBHOOK_SECRET=your-webhook-secret-here
GITHUB_WEBHOOK_SECRET=your-github-webhook-secret-here

# Faster update checks to catch new images quickly
SCHEDULER_UPDATE_CHECK_INTERVAL=300
```

See the [Webhooks Guide](guides/webhooks.md) for setting up webhook endpoints in your CI/CD pipelines.

---

## Per-Environment Settings (UI)

Beyond environment variables, each environment has its own settings configured through the web UI at **Configuration > Environment Settings** (admin only). These are organized into modules:

| Module | What It Controls |
|---|---|
| **General** | SSH user for server connections |
| **Monitoring** | Health check intervals, metrics collection, retention, alert bounce thresholds, per-metric toggles |
| **Operations** | Default Docker mode, default metrics mode for new servers |
| **Data** | Backup download permissions, default database monitoring settings |
| **Configuration** | Secret reveal permissions (disable for production environments) |

Per-environment settings override the global scheduler intervals for that specific environment. For example, you might run health checks every 30 seconds in production but every 5 minutes in staging.

For the full reference of every setting, see [Environment Settings Reference](reference/environment-settings.md).

---

## System Settings (UI)

Global operational parameters configured by admins at **Admin > System**. These apply across all environments:

| Category | Settings |
|---|---|
| **SSH** | Command execution timeout, connection timeout |
| **Webhooks** | Max retries, timeout, retry delay |
| **Backups** | pg_dump/mysqldump timeout |
| **Limits** | Max upload size, active user tracking window, max registry tags to fetch, default log lines |
| **URLs** | Agent callback URL, public URL for notification links |

For the full reference, see [System Settings Reference](reference/system-settings.md).
