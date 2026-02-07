# Configuration Reference

BridgePort is configured through environment variables set in your `.env` file and through the web UI for per-environment settings.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | SQLite database path. Use `file:/data/bridgeport.db` for Docker deployments. |
| `MASTER_KEY` | 32-byte base64-encoded encryption key. Used to encrypt secrets and SSH keys. Generate with `openssl rand -base64 32`. |
| `JWT_SECRET` | Secret for signing JWT authentication tokens. Generate with `openssl rand -base64 32`. |

### Server Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Network interface to bind to. |
| `PORT` | `3000` | HTTP port. |
| `NODE_ENV` | `development` | Set to `production` for Docker deployments. |

### Initial Admin User

These are only used on first boot when no users exist in the database.

| Variable | Description |
|----------|-------------|
| `ADMIN_EMAIL` | Email for the initial admin account. |
| `ADMIN_PASSWORD` | Password for the initial admin account (minimum 8 characters). |

### Scheduler Settings

The scheduler runs background jobs for health checks, metrics collection, container discovery, and more. Global intervals set the base cadence; per-environment settings (configured in the UI) can override these.

| Variable | Default | Description |
|----------|---------|-------------|
| `SCHEDULER_ENABLED` | `true` | Enable/disable all background jobs. |
| `SCHEDULER_SERVER_HEALTH_INTERVAL` | `60` | Server health check interval (seconds). |
| `SCHEDULER_SERVICE_HEALTH_INTERVAL` | `60` | Service health check interval (seconds). |
| `SCHEDULER_DISCOVERY_INTERVAL` | `300` | Container discovery interval (seconds). |
| `SCHEDULER_UPDATE_CHECK_INTERVAL` | `1800` | Registry update check interval (seconds). |
| `SCHEDULER_METRICS_INTERVAL` | `300` | SSH metrics collection interval (seconds). |
| `SCHEDULER_BACKUP_CHECK_INTERVAL` | `60` | Backup schedule check interval (seconds). |

### Agent Configuration

| Variable | Description |
|----------|-------------|
| `AGENT_CALLBACK_URL` | Internal/VPC URL that monitored servers use to reach BridgePort (e.g., `http://10.30.10.5:3000`). Required for automatic agent deployment. |

### Webhook Configuration

| Variable | Description |
|----------|-------------|
| `WEBHOOK_SECRET` | HMAC secret for verifying deployment webhook signatures. Generate with `openssl rand -base64 32`. |
| `GITHUB_WEBHOOK_SECRET` | Separate secret for GitHub webhook signature verification. |

### Sentry Error Monitoring (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `SENTRY_BACKEND_DSN` | — | Sentry DSN for backend (Node.js) error tracking. |
| `SENTRY_FRONTEND_DSN` | — | Sentry DSN for frontend (React) error tracking. |
| `SENTRY_ENVIRONMENT` | `NODE_ENV` | Environment tag sent to Sentry. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Performance tracing sample rate (0.0 to 1.0). |
| `SENTRY_ENABLED` | `true` | Kill switch to disable Sentry even when DSNs are configured. |

## Per-Environment Settings (UI)

Each environment has its own settings, managed through the **Settings** page in the web UI (admin only). Settings are organized into modules:

### General
- **SSH User** — Default SSH username for connecting to servers (default: `root`)

### Monitoring
- **Enable Monitoring** — Master toggle for all monitoring in the environment
- **Health Check Intervals** — How often to check server and service health
- **Discovery Interval** — How often to discover new containers
- **Metrics Collection Interval** — How often to collect server/service metrics
- **Update Check Interval** — How often to check for container image updates
- **Backup Check Interval** — How often to check for scheduled backups
- **Metrics Retention** — How many days to keep metrics data (default: 7)
- **Health Log Retention** — How many days to keep health check logs (default: 30)
- **Alert Configuration** — Bounce threshold and cooldown for failure alerts
- **Metrics Toggles** — Enable/disable collection of specific metric types (CPU, memory, swap, disk, load, file descriptors, TCP, processes)

### Operations
- Settings related to deployment and operational workflows

### Data
- **Allow Backup Download** — Whether backup files can be downloaded through the UI

### Configuration
- **Allow Secret Reveal** — Whether secrets can be viewed in the UI for this environment (disable for production)

## System Settings (UI)

Global operational parameters configurable by admins at **Settings > System**:

- **SSH Timeouts** — Command execution and connection timeouts
- **Webhook Settings** — Max retries, timeout, and retry delays
- **Backup Settings** — pg_dump timeout
- **Limits** — Max upload size, active user window, registry max tags, default log lines
