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

Background job intervals. Interval values are in **seconds**. These set the global cadence for all environments — monitoring cadence is global, not per-environment.

| Variable | Type | Default | Description |
|---|---|---|---|
| `SCHEDULER_ENABLED` | boolean | `true` | Master toggle for all background jobs. Set to `false` to disable. |
| `SCHEDULER_SERVER_HEALTH_INTERVAL` | number | `60` | How often to check server health (seconds). |
| `SCHEDULER_SERVICE_HEALTH_INTERVAL` | number | `60` | How often to check service health (seconds). |
| `SCHEDULER_DISCOVERY_INTERVAL` | number | `300` | How often to scan for new containers (seconds). |
| `SCHEDULER_UPDATE_CHECK_INTERVAL` | number | `1800` | How often to check registries for new image tags (seconds). |
| `SCHEDULER_METRICS_INTERVAL` | number | `300` | How often to collect server/service metrics via SSH (seconds). |
| `SCHEDULER_BACKUP_CHECK_INTERVAL` | number | `60` | How often to check for scheduled backups that are due (seconds). |
| `SCHEDULER_DATABASE_METRICS_INTERVAL` | number | `60` | How often to collect database monitoring metrics (seconds). |
| `SCHEDULER_CONCURRENCY` | number | `5` | Maximum parallel SSH health/metrics fan-out (`p-limit`). Raise it for fleets of 100+ servers; lower it on tiny/constrained hosts. |

### Security

| Variable | Type | Default | Description |
|---|---|---|---|
| `RATE_LIMIT_MAX` | number | `100` | Maximum API requests per IP per window. |
| `RATE_LIMIT_WINDOW` | string | `1 minute` | Rate-limit window as a duration string (e.g., `1 minute`, `30 seconds`). Must be non-empty — a blank value is rejected at startup rather than silently falling back to the default. |
| `BCRYPT_ROUNDS` | number | `12` | Password hashing cost factor. Clamped to the range `4`–`15`. Higher is slower but stronger. |
| `SESSION_TTL` | string | `7d` | JWT / session lifetime as a duration string (e.g., `7d`, `24h`, `30m`). Must be non-empty — a blank value is rejected at startup. |

### Performance / SQLite

| Variable | Type | Default | Description |
|---|---|---|---|
| `SQLITE_BUSY_TIMEOUT_MS` | number | `1000` | How long SQLite waits for a lock under WAL contention (milliseconds). Kept short because better-sqlite3's busy-wait is synchronous and blocks the event loop; longer contention is handled by the `DB_RETRY_*` async backoff below. |
| `SQLITE_CACHE_SIZE_KB` | number | `64000` | SQLite page cache size in KiB. Lower it on memory-constrained / ARM hosts. |
| `DB_RETRY_MAX_ATTEMPTS` | number | `5` | Total attempts (1 + retries) for a DB operation hitting transient write-lock contention (`SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT`). After the last attempt the request returns a retryable `503`. Set `1` to disable retrying. |
| `DB_RETRY_BASE_DELAY_MS` | number | `25` | Base backoff (with full jitter) between contention retries; doubles each attempt up to `DB_RETRY_MAX_DELAY_MS`. |
| `DB_RETRY_MAX_DELAY_MS` | number | `500` | Cap on the per-retry backoff delay (milliseconds). |
| `RESPONSE_CACHE_MAX_ENTRIES` | number | `500` | Max entries in the per-process short-TTL response cache before the oldest half is evicted. Minimum `1`. |
| `SSH_EXEC_MAX_BUFFER_BYTES` | number | `10485760` | Max stdout/stderr buffer for local command execution, in bytes (default 10MB). Raise it if local exec output is being truncated. Minimum `1024`. |

### Webhook Subscription Delivery

Tunes the delivery sweep for **webhook subscriptions** (the `WebhookSubscription` / `WebhookDelivery` path). These do **not** affect legacy outgoing webhooks (`WebhookConfig`), which are tuned via [System Settings](reference/system-settings.md#webhook-settings) in the UI. See [Two webhook delivery paths](#two-webhook-delivery-paths) below.

| Variable | Type | Default | Description |
|---|---|---|---|
| `WEBHOOK_DELIVERY_INTERVAL_MS` | number | `3000` | How often the delivery sweep runs (milliseconds). |
| `WEBHOOK_DELIVERY_CONCURRENCY` | number | `10` | Number of parallel deliveries per sweep. |
| `WEBHOOK_DELIVERY_BATCH_SIZE` | number | `50` | Number of pending deliveries fetched per sweep. |
| `WEBHOOK_DELIVERY_TIMEOUT_MS` | number | `10000` | Per-request HTTP timeout for an outbound delivery POST (milliseconds). Minimum `500`. |
| `WEBHOOK_DELIVERY_MAX_ATTEMPTS` | number | `5` | Max delivery attempts before a delivery is marked failed (terminal). Minimum `1`, maximum `100`. |

> Retention of delivered records is controlled by the `webhookDeliveryRetentionDays` [system setting](reference/system-settings.md#retention-policies), not an env var.

### Database Query Executor (Postgres)

Timeouts for the main Postgres query path (used by the database query executor).

| Variable | Type | Default | Description |
|---|---|---|---|
| `POSTGRES_CONNECTION_TIMEOUT_MS` | number | `10000` | Postgres connection timeout (milliseconds). Minimum `1` — `0` ("wait forever") is rejected so a stalled host can't wedge the metrics scheduler. |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | number | `30000` | Postgres statement timeout (milliseconds). Minimum `1`. |

### Database Query Executor (MySQL)

Timeouts for the MySQL query path (used by the database query executor).

| Variable | Type | Default | Description |
|---|---|---|---|
| `MYSQL_CONNECTION_TIMEOUT_MS` | number | `10000` | MySQL connection timeout (milliseconds). Minimum `1`. |
| `MYSQL_STATEMENT_TIMEOUT_MS` | number | `30000` | MySQL per-statement query timeout (milliseconds). Minimum `1`. |

### Idempotency

Controls retention of `Idempotency-Key` records used for safe request retries.

| Variable | Type | Default | Description |
|---|---|---|---|
| `IDEMPOTENCY_RETENTION_MS` | number | `86400000` | How long idempotency records are retained (milliseconds; default 24h). Minimum `1000`. |
| `IDEMPOTENCY_STALE_INPROGRESS_MS` | number | `300000` | When an in-progress idempotency record is considered stale (milliseconds; default 5m). Minimum `1000` — `0` would make every in-flight record instantly stale and defeat the idempotency guarantee. |

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
| `SENTRY_FRONTEND_DSN` | string | _(none)_ | Sentry DSN for frontend (React) error tracking. Served to the UI at runtime via `GET /api/client-config`, so rotating it only needs a backend restart. |
| `SENTRY_ENVIRONMENT` | string | _(none)_ | Environment tag sent to Sentry (e.g., `production`, `staging`). |
| `SENTRY_TRACES_SAMPLE_RATE` | number | `0` | Performance tracing sample rate, from `0.0` (off) to `1.0` (100%). |
| `SENTRY_ENABLED` | boolean | `true` | Kill switch. Set to `false` to disable Sentry even when DSNs are configured. |

After setting either DSN and restarting the container, admins can verify delivery from **Admin → Notifications → Sentry**: each side (Backend / Frontend) shows a "Configured" badge and a **Send test error** button. The button captures a synthetic exception via the SDK; the issue should appear in your Sentry project's Issues tab within ~30 seconds. If neither DSN is set, the tab inlines the env-var setup instructions.

### MCP (Model Context Protocol) Server

Optional. Exposes a curated subset of the API as agent tools at `POST /mcp`. Disabled by default.

| Variable | Type | Default | Description |
|---|---|---|---|
| `MCP_ENABLED` | boolean | `false` | Master switch. **Strict parse:** only `true` or `1` (case-insensitive) enable it; anything else — including `false`, `0`, an empty string, or leaving it unset — keeps it off. (Unlike the other boolean flags, this network-exposed security toggle must fail closed, so a literal `MCP_ENABLED=false` disables it.) When `false` the `/mcp` route is not registered (returns `404`). When `true`, MCP clients can connect with a bearer token and call read tools (any role) plus write tools (operator/admin). |
| `MCP_ALLOWED_HOSTS` | string (CSV) | _(unset)_ | Comma-separated PUBLIC `Host` header value(s) MCP clients use to reach `/mcp` (e.g. `mcp.example.com`). When set, the transport's DNS-rebinding protection is enabled and limited to these hosts; when unset/empty it's off (the endpoint is bearer-authenticated). This is the public hostname, **not** the bind address (`HOST`). Recommended to set it and terminate TLS when exposing MCP to remote clients. |

> See the [MCP Server Reference](reference/mcp.md) for client setup, the full tool list, the scope→tool mapping, and the data-egress note (tool outputs may be sent to the operator's model; secret/var values are never returned).

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
| **Monitoring** | Per-metric collection toggles (`collect*`) |
| **Operations** | Default Docker mode, default metrics mode for new servers |
| **Data** | Backup download permissions, default database monitoring settings |
| **Configuration** | Secret reveal permissions (disable for production environments) |

> [!IMPORTANT]
> Monitoring cadence is **global**, not per-environment — it is driven by the `SCHEDULER_*` env vars (see [Scheduler](#scheduler)). Health-log retention is global via the System Settings [Retention](#retention-system-settings) knobs, server/service metrics retention is the `METRICS_RETENTION_DAYS` env var, and alert bounce thresholds live on **Notification Types** (Admin → Notifications). The per-environment Monitoring tab now only exposes the metric-collection toggles. The earlier per-environment interval/retention/bounce fields were silently ignored by the scheduler and have been removed.

For the full reference of every setting, see [Environment Settings Reference](reference/environment-settings.md).

---

## System Settings (UI)

Global operational parameters configured by admins at **Admin > System**. These apply across all environments:

| Category | Settings |
|---|---|
| **SSH** | Command execution timeout, connection timeout |
| **Webhooks** | Max retries, timeout, retry delay (legacy outgoing webhooks) |
| **Backups** | pg_dump/mysqldump timeout, global default [GFS retention policy](reference/system-settings.md#database-backup--retention), rotation confirm threshold, failed-backup retention (all global defaults; per-database settings override the policy) |
| **General** | Instance timezone (used for backup-rotation period bucketing) |
| **Limits** | Max upload size, active user tracking window, max registry tags to fetch, default log lines |
| **URLs** | Agent callback URL, public URL for notification links |
| **Retention** | Audit log, database metrics, notification, health check log, webhook delivery, and image digest retention |

### Retention (System Settings)

The **Retention** section of System Settings holds the global, hot-reloaded cleanup knobs read by the scheduler on each cleanup tick (no restart needed):

| Setting | Default | Controls |
|---|---|---|
| `auditLogRetentionDays` | `90` | How long audit log entries are kept (`0` = forever). |
| `databaseMetricsRetentionDays` | `30` | How long database monitoring metrics are kept. |
| `notificationRetentionDays` | `30` | How long `Notification` rows are kept. |
| `healthLogRetentionDays` | `30` | How long `HealthCheckLog` entries are kept. |
| `webhookDeliveryRetentionDays` | `30` | How long `WebhookDelivery` records (webhook subscriptions) are kept. |
| `imageDigestRetentionDays` | `90` | Pruning age for unreferenced image digests. |

> [!NOTE]
> Server/service metrics retention is controlled by the `METRICS_RETENTION_DAYS` env var (see [Retention](#retention) under the env-var reference). The System Settings retention knobs above cover audit logs, database metrics, notifications, health check logs, webhook deliveries, and image digests.

### Two webhook delivery paths

BRIDGEPORT has two independent webhook delivery subsystems. Make sure you tune the one that applies:

- **Legacy outgoing webhooks** (`WebhookConfig`) — fire-and-retry notifications to a configured endpoint. Tuned via System Settings: `webhookMaxRetries`, `webhookTimeoutMs`, `webhookRetryDelaysMs`.
- **Webhook subscriptions** (`WebhookSubscription` / `WebhookDelivery`) — the newer event-subscription delivery path. Tuned via the `WEBHOOK_DELIVERY_INTERVAL_MS` / `_CONCURRENCY` / `_BATCH_SIZE` env vars, with record retention via the `webhookDeliveryRetentionDays` system setting.

For the full reference, see [System Settings Reference](reference/system-settings.md).
