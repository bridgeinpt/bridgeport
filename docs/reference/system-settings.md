# System Settings Reference

System settings are global, admin-only configuration values that apply across all environments. They control SSH timeouts, webhook behavior, backup limits, agent thresholds, and more.

## Table of Contents

- [Overview](#overview)
- [API](#api)
- [SSH Timeouts](#ssh-timeouts)
- [Webhook Settings](#webhook-settings)
- [Database Backup](#database-backup)
- [Limits](#limits)
- [URLs](#urls)
- [Agent Configuration](#agent-configuration)
- [Retention Policies](#retention-policies)
- [Registry Configuration](#registry-configuration)
- [Related Docs](#related-docs)

---

## Overview

System settings are stored as a singleton row in the database and cached in memory for performance. They are accessible at **Admin > System Settings** in the UI.

Unlike [environment settings](environment-settings.md) which are per-environment, system settings apply globally. Changes take effect immediately (the cache is refreshed on update).

---

## API

All system settings endpoints require admin authentication.

**Get current settings:**

```bash
GET /api/settings/system
```

**Update settings:**

```bash
PATCH /api/settings/system
Content-Type: application/json

{
  "sshCommandTimeoutMs": 120000,
  "webhookMaxRetries": 5
}
```

**Reset all to defaults:**

```bash
POST /api/settings/system/reset
```

---

## SSH Timeouts

Control how long BridgePort waits when executing commands over SSH.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sshCommandTimeoutMs` | `integer` | `60000` (60s) | Maximum time to wait for an SSH command to complete. Applies to health checks, metrics collection, container discovery, and all other SSH operations. Increase for slow networks or long-running commands. |
| `sshReadyTimeoutMs` | `integer` | `10000` (10s) | Maximum time to wait for an SSH connection to be established before timing out. Increase if servers have slow SSH handshakes. |

> [!TIP]
> If health checks frequently show "timeout" status, try increasing `sshCommandTimeoutMs`. If servers appear as "unhealthy" despite being reachable, `sshReadyTimeoutMs` may need to be increased.

---

## Webhook Settings

Control outgoing webhook delivery behavior (for notifications sent to external webhook endpoints).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `webhookMaxRetries` | `integer` | `3` | Maximum number of retry attempts for failed webhook deliveries |
| `webhookTimeoutMs` | `integer` | `30000` (30s) | Timeout for each webhook HTTP request |
| `webhookRetryDelaysMs` | `string` (JSON) | `"[1000,5000,15000]"` | JSON array of delays (in milliseconds) between retry attempts. The array length should match `webhookMaxRetries`. |

**How retries work:**

When a webhook delivery fails, BridgePort retries using the delays specified in `webhookRetryDelaysMs`. With the defaults:

1. First retry after 1 second
2. Second retry after 5 seconds
3. Third (final) retry after 15 seconds

If all retries fail, the delivery is marked as failed and the webhook's `failureCount` is incremented.

---

## Database Backup

Timeout for database backup operations.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `pgDumpTimeoutMs` | `integer` | `300000` (5 min) | Maximum time for a database backup command (e.g., `pg_dump`) to complete. Increase for large databases. |

> [!NOTE]
> Individual databases can also override this timeout via their own `pgDumpTimeoutMs` setting. The system setting acts as the default.

---

## Limits

Resource limits and display defaults.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maxUploadSizeMb` | `integer` | `50` | Maximum file upload size in megabytes (for config files and binary attachments) |
| `activeUserWindowMin` | `integer` | `15` | Minutes of inactivity before a user is considered "inactive" in the active users count (Admin > Users) |
| `registryMaxTags` | `integer` | `50` | Maximum number of tags to fetch when checking a container registry for updates |
| `defaultLogLines` | `integer` | `50` | Default number of log lines to return when viewing container logs through the API |

---

## URLs

External URLs for notifications and agent communication.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `publicUrl` | `string \| null` | `null` | Public URL where BridgePort is accessible (e.g., `https://deploy.example.com`). Used in notification emails and webhook payloads to generate clickable links. |
| `agentCallbackUrl` | `string \| null` | `null` | Internal URL for agents to reach BridgePort (e.g., `http://10.30.10.5:3000`). When set, agents use this URL instead of the public URL. Useful when agents are on a private network. |

> [!TIP]
> If your BridgePort instance is behind a reverse proxy, set `publicUrl` to the external HTTPS URL. Set `agentCallbackUrl` to the internal HTTP address that agents can reach directly, avoiding unnecessary proxy hops.

---

## Agent Configuration

Thresholds for determining agent health status.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `agentStaleThresholdMs` | `integer` | `180000` (3 min) | Time since last metrics push before an agent is marked as "stale". A stale agent may be experiencing temporary issues. |
| `agentOfflineThresholdMs` | `integer` | `300000` (5 min) | Time since last metrics push before an agent is marked as "offline". An offline agent likely needs attention. |

**Agent status flow:**

```
active  -->  stale  -->  offline
  ^            |            |
  |            v            v
  +--- metrics received ----+
```

- **Active**: Agent pushed metrics within the last `agentStaleThresholdMs`
- **Stale**: Last push was between `agentStaleThresholdMs` and `agentOfflineThresholdMs` ago
- **Offline**: Last push was more than `agentOfflineThresholdMs` ago

---

## Retention Policies

Automatic cleanup of old data.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `auditLogRetentionDays` | `integer` | `90` | Days to keep audit log entries. Set to `0` to keep audit logs forever. |
| `databaseMetricsRetentionDays` | `integer` | `30` | Days to keep database monitoring metrics (the time-series data collected by monitoring queries). |

> [!NOTE]
> Server/service metrics retention is controlled per-environment via `metricsRetentionDays` in [Monitoring Settings](environment-settings.md#retention). The system-level `databaseMetricsRetentionDays` specifically controls the retention of database-specific monitoring data collected by plugin monitoring queries.

---

## Registry Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `doRegistryToken` | `string \| null` | `null` | DigitalOcean container registry API token. Used for DigitalOcean-specific registry features like digest-based update detection. |

---

## Related Docs

- [Environment Settings](environment-settings.md) -- Per-environment settings (monitoring intervals, metrics toggles, etc.)
- [Agent Reference](agent.md) -- How agents use callback URLs and thresholds
- [Plugin Reference](plugins.md) -- Database type monitoring queries affected by retention settings
- [API Reference](api.md) -- Full API endpoint documentation
