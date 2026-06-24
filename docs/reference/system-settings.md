# System Settings Reference

System settings are global, admin-only configuration values that apply across all environments. They control SSH timeouts, webhook behavior, backup retention and timeouts, the instance timezone, agent thresholds, and more.

## Table of Contents

- [Overview](#overview)
- [API](#api)
- [SSH Timeouts](#ssh-timeouts)
- [Webhook Settings](#webhook-settings)
- [Database Backup & Retention](#database-backup--retention)
- [Instance Timezone](#instance-timezone)
- [Limits](#limits)
- [URLs](#urls)
- [Agent Configuration](#agent-configuration)
- [Retention Policies](#retention-policies)
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

Control how long BRIDGEPORT waits when executing commands over SSH.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sshCommandTimeoutMs` | `integer` | `60000` (60s) | Maximum time to wait for an SSH command to complete. Applies to health checks, metrics collection, container discovery, and all other SSH operations. Increase for slow networks or long-running commands. |
| `sshReadyTimeoutMs` | `integer` | `10000` (10s) | Maximum time to wait for an SSH connection to be established before timing out. Increase if servers have slow SSH handshakes. |

> [!TIP]
> If health checks frequently show "timeout" status, try increasing `sshCommandTimeoutMs`. If servers appear as "unhealthy" despite being reachable, `sshReadyTimeoutMs` may need to be increased.

---

## Webhook Settings

Control **legacy outgoing webhook** delivery behavior (the `WebhookConfig` path — notifications sent to external webhook endpoints).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `webhookMaxRetries` | `integer` | `3` | Maximum number of retry attempts for failed webhook deliveries |
| `webhookTimeoutMs` | `integer` | `30000` (30s) | Timeout for each webhook HTTP request |
| `webhookRetryDelaysMs` | `string` (JSON) | `"[1000,5000,15000]"` | JSON array of delays (in milliseconds) between retry attempts. The array length should match `webhookMaxRetries`. |

> [!IMPORTANT]
> **Two webhook delivery paths.** These three settings tune only **legacy outgoing webhooks** (`WebhookConfig`). The newer **webhook subscriptions** path (`WebhookSubscription` / `WebhookDelivery`) is a separate subsystem tuned by the `WEBHOOK_DELIVERY_INTERVAL_MS` / `WEBHOOK_DELIVERY_CONCURRENCY` / `WEBHOOK_DELIVERY_BATCH_SIZE` environment variables, with delivery-record retention controlled by [`webhookDeliveryRetentionDays`](#retention-policies). See the [Configuration Reference](../configuration.md#two-webhook-delivery-paths).

**How retries work:**

When a webhook delivery fails, BRIDGEPORT retries using the delays specified in `webhookRetryDelaysMs`. With the defaults:

1. First retry after 1 second
2. Second retry after 5 seconds
3. Third (final) retry after 15 seconds

If all retries fail, the delivery is marked as failed and the webhook's `failureCount` is incremented.

---

## Database Backup & Retention

Timeout for database backup operations.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `pgDumpTimeoutMs` | `integer` | `300000` (5 min) | Maximum time for a database backup command (e.g., `pg_dump`) to complete. Increase for large databases. |

> [!NOTE]
> `pgDumpTimeoutMs` is the **global default**, editable on the System Settings page. Individual databases can override it via their own per-database `pgDumpTimeoutMs` setting; when a database has no override, this system value applies.

### Global Backup Retention Policy

These settings define the **global default** [GFS retention policy](../guides/databases.md#retention) that every database inherits unless it has a per-database override. Admins edit them here; operators set per-database overrides on the database detail page.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `backupRetentionPreset` | `string` | `"balanced"` | Active preset: `lean`, `balanced`, `long_term`, or `custom`. Selecting a non-custom preset fills the tier fields below. |
| `backupRetentionKeepLast` | `integer` | `24` | Most-recent successful backups kept regardless of period (0–100). |
| `backupRetentionDaily` | `integer` | `7` | Daily restore points — newest backup per calendar day (0–366). |
| `backupRetentionWeekly` | `integer` | `4` | Weekly restore points — newest per ISO week, weeks start Monday (0–520). |
| `backupRetentionMonthly` | `integer` | `6` | Monthly restore points — newest per calendar month (0–240). |
| `backupRetentionYearly` | `integer` | `0` | Yearly restore points — newest per calendar year (0–50). |
| `backupRetentionMinFloor` | `integer` | `2` | Hard floor: always keep at least this many most-recent successful backups (1–10). |
| `backupRetentionMaxTotalBytes` | `bigint \| null` | `null` | Optional default storage cap per database (`null` = off). |
| `backupRotationConfirmThreshold` | `integer` | `5` | When an operator saves a policy that would prune **more** backups than this in one go, the API rejects the save with `confirmationRequired` and the UI prompts for explicit confirmation. Automatic rotation never prompts. |
| `failedBackupRetentionDays` | `integer` | `3` | Days to keep `failed` backups before they (and any partial artifact) are deleted. Stuck `in_progress` backups are marked failed first. Separate from GFS rotation. |

> [!IMPORTANT]
> A backup survives if **any** tier selects it — the tiers are a **union, not a sum**. See the [retention model](../guides/databases.md#the-tiers) for the full explanation, presets, and inheritance rules.

> [!NOTE]
> Changing the global default policy here only affects databases that inherit it. Databases with their own override are unaffected until the override is removed ("Use global default"). The new tiers take effect on the next rotation pass (after the next backup, or the daily sweep) — and the **first** real prune after a change raises a one-time [`backup.policy_first_prune`](../guides/notifications.md) notification.

---

## Instance Timezone

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `timezone` | `string` (IANA) | `"UTC"` | Instance timezone used for backup-rotation period bucketing and display. Examples: `Europe/Lisbon`, `America/New_York`. |

The timezone determines which calendar day, ISO week, month, and year a backup belongs to during [GFS rotation](../guides/databases.md#timezone-and-period-buckets). A backup taken at 02:00 buckets to the local calendar day rather than possibly the previous or next UTC day. ISO weeks start on **Monday**. Buckets are calendar-based, so a one-hour DST shift never splits a day across two buckets.

> [!TIP]
> Set this to your operations team's local timezone so "daily" and "weekly" restore points line up with how you actually think about the calendar.

---

## Limits

Resource limits and display defaults.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maxUploadSizeMb` | `integer` | `50` | Maximum file upload size in megabytes (for config files and binary attachments) |
| `activeUserWindowMin` | `integer` | `15` | Minutes of inactivity before a user is considered "inactive" in the active users count (Admin > Users) |
| `registryMaxTags` | `integer` | `50` | Maximum number of tags to fetch when checking a container registry for updates |
| `defaultLogLines` | `integer` | `50` | Default number of log lines to return when no explicit `tail` is requested. Used by the snapshot logs endpoint, the SSE log stream, the service detail logs viewer (initial fetch and "Load older" page size), and the per-deployment container log capture appended to deployment plan output. |

---

## URLs

External URLs for notifications and agent communication.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `publicUrl` | `string \| null` | `null` | Public URL where BRIDGEPORT is accessible (e.g., `https://deploy.example.com`). Used in notification emails and webhook payloads to generate clickable links. |
| `agentCallbackUrl` | `string \| null` | `null` | Internal URL for agents to reach BRIDGEPORT (e.g., `http://10.30.10.5:3000`). When set, agents use this URL instead of the public URL. Useful when agents are on a private network. |

> [!TIP]
> If your BRIDGEPORT instance is behind a reverse proxy, set `publicUrl` to the external HTTPS URL. Set `agentCallbackUrl` to the internal HTTP address that agents can reach directly, avoiding unnecessary proxy hops.

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

Automatic cleanup of old data. These are the global, admin-editable retention knobs (in the **Retention** section of the System Settings page).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `auditLogRetentionDays` | `integer` | `90` | Days to keep audit log entries. Set to `0` to keep audit logs forever. |
| `databaseMetricsRetentionDays` | `integer` | `30` | Days to keep database monitoring metrics (the time-series data collected by monitoring queries). |
| `notificationRetentionDays` | `integer` | `30` | Days to keep `Notification` rows. |
| `healthLogRetentionDays` | `integer` | `30` | Days to keep `HealthCheckLog` entries. |
| `webhookDeliveryRetentionDays` | `integer` | `30` | Days to keep `WebhookDelivery` records (the webhook-subscription delivery path). |
| `imageDigestRetentionDays` | `integer` | `90` | Pruning age (in days) for unreferenced image digests. |

> [!NOTE]
> **Validation:** `notificationRetentionDays`, `healthLogRetentionDays`, and `webhookDeliveryRetentionDays` accept `1`–`365`; `imageDigestRetentionDays` accepts `1`–`3650`. Unlike `auditLogRetentionDays`, these cannot be set to `0` — there is no "keep forever" option for these record types.

> [!NOTE]
> These retention settings are **hot-reloaded** — the scheduler reads them on each cleanup tick, so changes take effect without restarting the container.

> [!NOTE]
> Server/service metrics retention is **not** here — it is controlled globally by the `METRICS_RETENTION_DAYS` environment variable (see [Configuration Reference → Retention](../configuration.md#retention)). The system-level `databaseMetricsRetentionDays` specifically controls the retention of database-specific monitoring data collected by plugin monitoring queries.

---

## Related Docs

- [Configuration Reference](../configuration.md) -- Environment variables, including the `SCHEDULER_*`, rate-limit, SQLite, webhook-delivery, Postgres, and idempotency knobs
- [Environment Settings](environment-settings.md) -- Per-environment settings (metrics-collection toggles)
- [Agent Reference](agent.md) -- How agents use callback URLs and thresholds
- [Plugin Reference](plugins.md) -- Database type monitoring queries affected by retention settings
- [API Reference](api.md) -- Full API endpoint documentation
