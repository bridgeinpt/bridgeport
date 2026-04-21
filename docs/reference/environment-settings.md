# Environment Settings Reference

Every environment in BRIDGEPORT has per-environment settings organized into five modules: General, Monitoring, Operations, Data, and Configuration. Settings are created with defaults when an environment is created and can be adjusted in **Environment Settings** (admin only).

## Table of Contents

- [Overview](#overview)
- [API](#api)
- [General Settings](#general-settings)
- [Monitoring Settings](#monitoring-settings)
- [Operations Settings](#operations-settings)
- [Data Settings](#data-settings)
- [Configuration Settings](#configuration-settings)
- [Related Docs](#related-docs)

---

## Overview

Environment settings allow you to configure each environment independently. For example, you might want:

- More frequent health checks in production than in staging
- Agent-based metrics in production, SSH-based in staging
- Backup downloads enabled only in staging

Settings are managed through the UI at **Environment > Settings** (admin access required) or via the API.

---

## API

All settings endpoints require admin authentication.

**Get settings for a module:**

```bash
GET /api/environments/:envId/settings/:module
```

Where `:module` is one of: `general`, `monitoring`, `operations`, `data`, `configuration`.

**Update settings:**

```bash
PATCH /api/environments/:envId/settings/:module
Content-Type: application/json

{
  "sshUser": "deploy",
  "enabled": true
}
```

Only include the fields you want to change. Unknown fields are rejected. Invalid values return a `400` error with details.

**Reset to defaults:**

```bash
POST /api/environments/:envId/settings/:module/reset
```

---

## General Settings

SSH and connectivity configuration.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sshUser` | `string` | `"root"` | Default SSH username for connecting to servers in this environment |

---

## Monitoring Settings

Health checks, metrics collection, retention, and alert configuration.

### General

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Master toggle for all monitoring in this environment. When disabled, no health checks, metrics, or discovery runs. |

### Health Check Intervals

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `serverHealthIntervalMs` | `integer` | `60000` (1 min) | 10,000 -- 86,400,000 | How often to check server health |
| `serviceHealthIntervalMs` | `integer` | `60000` (1 min) | 10,000 -- 86,400,000 | How often to check service health |

### Other Schedules

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `discoveryIntervalMs` | `integer` | `300000` (5 min) | 10,000 -- 86,400,000 | How often to discover new containers |
| `updateCheckIntervalMs` | `integer` | `1800000` (30 min) | 10,000 -- 86,400,000 | How often to check registries for image updates |
| `backupCheckIntervalMs` | `integer` | `60000` (1 min) | 10,000 -- 86,400,000 | How often to check for scheduled backups |

### Metrics Collection

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `metricsIntervalMs` | `integer` | `300000` (5 min) | 10,000 -- 86,400,000 | How often to collect server and service metrics via SSH |
| `collectCpu` | `boolean` | `true` | -- | Collect CPU usage metrics |
| `collectMemory` | `boolean` | `true` | -- | Collect memory usage metrics |
| `collectSwap` | `boolean` | `true` | -- | Collect swap usage metrics |
| `collectDisk` | `boolean` | `true` | -- | Collect disk usage metrics |
| `collectLoad` | `boolean` | `true` | -- | Collect system load averages |
| `collectFds` | `boolean` | `true` | -- | Collect file descriptor counts |
| `collectTcp` | `boolean` | `true` | -- | Collect TCP connection metrics |
| `collectProcesses` | `boolean` | `true` | -- | Collect running process count |
| `collectTcpChecks` | `boolean` | `true` | -- | Run TCP connectivity checks on services |
| `collectCertChecks` | `boolean` | `true` | -- | Check TLS certificate expiry on services |

> [!NOTE]
> The `collect*` toggles affect both SSH-based collection and agent-based collection. When using the agent, these settings are fetched by the agent every 60 seconds via the `/api/agent/config` endpoint.

### Retention

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `metricsRetentionDays` | `integer` | `7` | 1 -- 365 | Days to retain server and service metrics data |
| `healthLogRetentionDays` | `integer` | `30` | 1 -- 365 | Days to retain health check log entries |

### Alert Configuration

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `bounceThreshold` | `integer` | `3` | 1 -- 10 | Consecutive failures before triggering an alert notification |
| `bounceCooldownMs` | `integer` | `900000` (15 min) | 10,000 -- 86,400,000 | Cooldown period after an alert before re-alerting for the same resource |

> [!TIP]
> Bounce logic prevents alert storms. If a server goes down, BRIDGEPORT sends one alert after `bounceThreshold` consecutive failures, then waits `bounceCooldownMs` before sending another -- even if the server stays down. When the resource recovers, the bounce counter resets.

---

## Operations Settings

Defaults for new servers and environment-wide operational behavior.

| Setting | Type | Default | Options | Description |
|---------|------|---------|---------|-------------|
| `defaultDockerMode` | `string` | `"ssh"` | `ssh`, `socket` | Default Docker daemon connection method for new servers |
| `defaultMetricsMode` | `string` | `"disabled"` | `disabled`, `ssh`, `agent` | Default metrics collection mode for new servers |
| `autoPruneImages` | `boolean` | `false` | -- | Run `docker image prune` automatically after every deploy to the affected server, and weekly on all healthy servers in this environment |
| `pruneImagesMode` | `string` | `"dangling"` | `dangling`, `all` | Which images are pruned. `dangling` removes only untagged layers (safe default). `all` removes any image not used by a running container, including rollback targets -- use with care. |

> [!NOTE]
> The server-type defaults (`defaultDockerMode`, `defaultMetricsMode`) apply when creating new servers. Existing servers are not affected when you change these settings.
>
> The prune settings apply immediately -- the next deploy and the next weekly scheduler tick will honor the new values.

---

## Data Settings

Database backup and monitoring defaults.

### Backup Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `allowBackupDownload` | `boolean` | `false` | Allow users to download database backups from the UI. Enable for development environments; disable in production for security. |

### Database Monitoring Defaults

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `defaultMonitoringEnabled` | `boolean` | `false` | -- | Enable monitoring by default when adding new databases |
| `defaultCollectionIntervalSec` | `integer` | `300` (5 min) | 60 -- 3,600 | Default metrics collection interval for new databases (seconds) |

---

## Configuration Settings

Security and config-scanner settings for this environment.

### Security

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `allowSecretReveal` | `boolean` | `true` | Allow users to reveal secret values in the UI. When disabled, secrets are write-only -- users can set values but never view them. |

> [!TIP]
> For production environments with strict security requirements, set `allowSecretReveal` to `false`. Operators can still update secrets, but the values are never shown in the UI. Secrets marked as `neverReveal` always remain hidden regardless of this setting.

### Config Scanner

Controls sensitivity of the [config file scanner](../guides/secrets.md#config-file-scanner) that detects hardcoded values and suggests promoting them to secrets or vars.

| Setting | Type | Default | Range | Description |
|---------|------|---------|-------|-------------|
| `scanMinLength` | `integer` | `6` | 1 -- 100 | Minimum value length to consider. Shorter values are ignored. |
| `scanEntropyThreshold` | `integer` | `25` | 0 -- 80 | Shannon entropy threshold stored as ×10 (25 = 2.5 bits/char). Values below this are filtered out as low-entropy. |

---

## Related Docs

- [System Settings](system-settings.md) -- Global system-wide settings (admin only)
- [Agent Reference](agent.md) -- How the agent uses monitoring settings
- [Plugin Reference](plugins.md) -- Database type monitoring queries
- [API Reference](api.md) -- Full API endpoint documentation
