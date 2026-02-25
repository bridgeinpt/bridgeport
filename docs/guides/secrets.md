# Secrets

BridgePort stores your sensitive configuration values -- API keys, database passwords, tokens -- encrypted at rest and makes them available to services through config file templates with automatic placeholder substitution.

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Creating Secrets](#creating-secrets)
- [Using Secrets in Config Files](#using-secrets-in-config-files)
- [Reveal Controls](#reveal-controls)
- [Secret Usage Tracking](#secret-usage-tracking)
- [Updating and Rotating Secrets](#updating-and-rotating-secrets)
- [Best Practices](#best-practices)
- [Configuration Options](#configuration-options)
- [Troubleshooting](#troubleshooting)
- [Related](#related)

---

## Quick Start

Store a secret and use it in a config file in under a minute:

1. Go to **Configuration > Secrets** in the sidebar.
2. Click **Add Secret**.
3. Enter key `DATABASE_URL`, value `postgres://user:pass@db:5432/app`, and click **Create**.
4. Go to **Configuration > Config Files**, create or edit a `.env` file.
5. Add `DATABASE_URL=${DATABASE_URL}` to the file content.
6. Attach the config file to a service, then **Sync Files** -- BridgePort writes the resolved value to the server.

---

## How It Works

Secrets in BridgePort follow a simple flow: store encrypted, reference by name, resolve at sync time.

```mermaid
flowchart LR
    U[User creates secret<br/>key: DATABASE_URL<br/>value: postgres://...] --> E[Encrypted with<br/>AES-256-GCM]
    E --> DB[(Database<br/>encrypted value + nonce)]

    CF[Config file template<br/>with secret placeholders] --> Sync[Sync to server]
    DB --> Sync
    Sync --> Server[Server file<br/>DATABASE_URL=postgres://...]
```

**Key concepts:**

- **Environment-scoped.** Secrets belong to an environment. A secret named `DATABASE_URL` in staging is completely independent from `DATABASE_URL` in production.
- **Encrypted at rest.** Every secret value is encrypted using AES-256-GCM with the `MASTER_KEY` before being stored. The encryption nonce is stored alongside the ciphertext. The plaintext value never touches the database.
- **Audit-logged.** Every access to a secret value (reveal, sync, update) is recorded in the [audit log](../audit.md) with the user who performed the action.
- **Template-based usage.** Secrets are not injected at runtime. They are substituted into config file templates at sync time and written as static files to the server.

---

## Creating Secrets

### Via the UI

1. Navigate to **Configuration > Secrets**.
2. Click **Add Secret**.
3. Fill in the form:

| Field | Required | Description |
|-------|----------|-------------|
| **Key** | Yes | Uppercase name with underscores (e.g., `DATABASE_URL`). Must match `^[A-Z][A-Z0-9_]*$`. |
| **Value** | Yes | The secret value. Can be any string. |
| **Description** | No | Optional description for documentation. |
| **Write-Only** | No | When enabled, the value can never be revealed after creation. See [Reveal Controls](#reveal-controls). |

4. Click **Create**.

### Via the API

```http
POST /api/environments/:envId/secrets
Authorization: Bearer <token>
Content-Type: application/json

{
  "key": "DATABASE_URL",
  "value": "postgres://user:pass@db-host:5432/appdb",
  "description": "Primary database connection string",
  "neverReveal": false
}
```

**Response (200):**
```json
{
  "secret": {
    "id": "clxyz...",
    "key": "DATABASE_URL",
    "description": "Primary database connection string",
    "neverReveal": false,
    "createdAt": "2026-02-25T10:00:00.000Z",
    "updatedAt": "2026-02-25T10:00:00.000Z"
  }
}
```

> [!NOTE]
> Secret keys must be unique within an environment. Creating a secret with a key that already exists returns `409 Conflict`. The key format is enforced: must start with an uppercase letter and contain only uppercase letters, digits, and underscores.

---

## Using Secrets in Config Files

Secrets come to life when you reference them in [config files](config-files.md). The standard placeholder syntax is `${SECRET_KEY}`.

### Example: .env File

Create a config file with this content:

```env
# Application configuration
DATABASE_URL=${DATABASE_URL}
REDIS_URL=${REDIS_URL}
API_KEY=${API_KEY}
DEBUG=false
LOG_LEVEL=info
```

When you sync this file to a server, BridgePort resolves each `${KEY}` placeholder with the corresponding secret value from the environment. The file written to the server contains the actual values:

```env
# Application configuration
DATABASE_URL=postgres://user:pass@db-host:5432/appdb
REDIS_URL=redis://redis-host:6379/0
API_KEY=sk-live-abc123def456
DEBUG=false
LOG_LEVEL=info
```

### Placeholder Syntax

BridgePort recognizes the following placeholder formats when listing secret usage:

| Format | Example | Used For |
|--------|---------|----------|
| `${KEY}` | `${DATABASE_URL}` | Standard format, resolved during sync |
| `$KEY` | `$DATABASE_URL` | Detected for usage tracking |
| `{{KEY}}` | `{{DATABASE_URL}}` | Detected for usage tracking |

> [!WARNING]
> Only the `${KEY}` format is resolved during config file sync. The `$KEY` and `{{KEY}}` formats are used for usage tracking only -- they will *not* be substituted with secret values when syncing files to servers.

### Missing Secrets

If a config file references a secret that does not exist in the environment, the sync fails with an error listing the missing keys:

```
Missing secrets: STRIPE_API_KEY, SENDGRID_KEY
```

This is a safety measure -- BridgePort will not write a file with unresolved placeholders to your server. Create the missing secrets first, then retry the sync.

### Template Flow

```mermaid
flowchart TD
    A[Config file template<br/>stored in BridgePort] --> B[Sync triggered<br/>per-service or per-server]
    B --> C[Fetch all secrets<br/>for the environment]
    C --> D[Replace each placeholder<br/>with decrypted value]
    D --> E{Any unresolved<br/>placeholders?}
    E -->|Yes| F[Sync fails<br/>lists missing secrets]
    E -->|No| G[Write resolved file<br/>to target path via SSH]
    G --> H[Update lastSyncedAt<br/>timestamp]
```

---

## Reveal Controls

BridgePort has two independent layers of reveal control to protect sensitive values.

### Environment-Level Control

Admins can disable secret reveal for an entire environment:

**Location:** Settings > Configuration > "Allow Secret Reveal"

When disabled:
- No secret values in that environment can be revealed through the UI or API.
- API calls to `GET /api/secrets/:id/value` return `403 Forbidden` with the message "Secret reveal is disabled for this environment".
- Secrets can still be updated and used in config file syncs -- only revealing is blocked.
- The audit log records blocked reveal attempts.

> [!TIP]
> Disable secret reveal for production environments. Operators can still update secret values and sync config files without ever seeing the current value.

### Secret-Level Control (Write-Only)

Individual secrets can be marked as **write-only** using the `neverReveal` flag:

When enabled:
- The secret value can never be revealed through the UI or API, regardless of environment settings.
- API calls to `GET /api/secrets/:id/value` return `403 Forbidden` with "This secret is write-only and cannot be revealed".
- The value can still be updated (you can set a new value without seeing the old one).
- The value is still resolved during config file syncs.

**When to use write-only:**
- Production database root passwords
- Third-party API keys that should never be displayed
- Signing keys and certificates that are set once and never read back

```http
POST /api/environments/:envId/secrets
Authorization: Bearer <token>
Content-Type: application/json

{
  "key": "STRIPE_SECRET_KEY",
  "value": "sk_live_abc123...",
  "neverReveal": true
}
```

> [!WARNING]
> The `neverReveal` flag cannot be reversed through the API. Once a secret is write-only, the only way to change this is to delete the secret and recreate it. Treat this as a one-way operation.

---

## Secret Usage Tracking

The secrets list page shows where each secret is referenced, so you can understand the impact of changing or deleting a secret before you do it.

For each secret, BridgePort scans all config files in the environment and reports:

- **Config files** that reference the secret key (by detecting `${KEY}`, `$KEY`, or `{{KEY}}` patterns)
- **Services** that those config files are attached to
- **Usage count** -- the number of unique services using the secret

This is computed at list time by scanning config file content, not stored separately.

```http
GET /api/environments/:envId/secrets
Authorization: Bearer <token>
```

Each secret in the response includes:
```json
{
  "key": "DATABASE_URL",
  "usageCount": 3,
  "usedByConfigFiles": [
    {
      "id": "cf1",
      "name": "App API .env",
      "filename": ".env",
      "services": [
        { "id": "svc1", "name": "app-api", "serverName": "server-1" },
        { "id": "svc2", "name": "app-api", "serverName": "server-2" }
      ]
    }
  ],
  "usedByServices": [
    { "id": "svc1", "name": "app-api", "serverName": "server-1" },
    { "id": "svc2", "name": "app-api", "serverName": "server-2" }
  ]
}
```

---

## Updating and Rotating Secrets

### Updating a Value

**UI:** Click the edit icon on a secret in the list, enter the new value, click **Save**.

**API:**
```http
PATCH /api/secrets/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "value": "postgres://newuser:newpass@db-host:5432/appdb"
}
```

Updating a secret re-encrypts the value with the current `MASTER_KEY`. After updating, config files that reference the secret will show a "pending" sync status until re-synced.

### Rotation Workflow

When rotating a secret (e.g., a database password):

1. Update the secret value in BridgePort.
2. Check which services use the secret (via usage tracking).
3. Sync config files to all affected services.
4. Restart the services to pick up the new configuration.

> [!TIP]
> Use the per-file "Sync to All" feature to push updated config files to every attached service in one action. See [Config Files > Syncing](config-files.md#syncing-files-to-servers) for details.

---

## Best Practices

### Naming Conventions

Use consistent, descriptive key names:

| Pattern | Examples | Use For |
|---------|----------|---------|
| `SERVICE_SETTING` | `DATABASE_URL`, `REDIS_URL` | Connection strings |
| `PROVIDER_KEY` | `STRIPE_API_KEY`, `SENDGRID_KEY` | Third-party API keys |
| `APP_SECRET` | `DJANGO_SECRET_KEY`, `JWT_SECRET` | Application secrets |

### Access Control

- **Disable reveal for production.** Set "Allow Secret Reveal" to false in production environment settings.
- **Use write-only for critical secrets.** Mark database root passwords, signing keys, and master API keys as `neverReveal`.
- **Audit regularly.** Review the audit log for secret access patterns. Unexpected reveals may indicate a security concern.

### Operational Hygiene

- **One secret per value.** Do not pack multiple values into a single secret. Use `DB_HOST`, `DB_PORT`, `DB_PASSWORD` instead of a JSON blob.
- **Document with descriptions.** Use the description field to note what the secret is for, who owns it, and when it was last rotated.
- **Check usage before deleting.** The usage tracking feature shows all config files and services that depend on a secret. Deleting a secret that is still referenced will cause sync failures.
- **Keep secrets environment-specific.** Even if staging and production use the same API key, store it separately in each environment for isolation.

---

## Configuration Options

### Secret Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `key` | string | -- | Uppercase key name (unique per environment) |
| `encryptedValue` | string | -- | AES-256-GCM encrypted value |
| `nonce` | string | -- | Encryption nonce (base64) |
| `description` | string | null | Optional documentation |
| `neverReveal` | boolean | false | Write-only flag |

### Related Environment Settings

| Setting | Location | Default | Description |
|---------|----------|---------|-------------|
| `allowSecretReveal` | Settings > Configuration | true | Environment-level reveal toggle (admin only) |

### Related Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MASTER_KEY` | -- (required) | 32-byte base64 key used for all encryption/decryption |

---

## Troubleshooting

**"Secret already exists"**
Secret keys must be unique within an environment. Check the existing secrets list for the key. If you need to change the value, update the existing secret instead of creating a new one.

**"Key must be uppercase with underscores"**
Secret keys must match the pattern `^[A-Z][A-Z0-9_]*$`. Examples of valid keys: `DATABASE_URL`, `API_KEY`, `STRIPE_SECRET_KEY`. Examples of invalid keys: `database_url`, `api-key`, `123_KEY`.

**"Secret reveal is disabled for this environment"**
An admin has disabled secret reveal for this environment. Secrets can still be updated and used in syncs. If you need to reveal a value, ask an admin to temporarily enable the setting at Settings > Configuration.

**"This secret is write-only and cannot be revealed"**
The secret has `neverReveal: true`. This cannot be reversed. If you need to see the value, delete the secret and recreate it without the write-only flag.

**"Missing secrets: KEY1, KEY2" during config file sync**
The config file references secrets that do not exist in this environment. Create the missing secrets, then retry the sync.

**Secret value not updating on the server after change**
Updating a secret in BridgePort does not automatically sync config files. After updating a secret, re-sync the config files attached to the affected services. The sync status will show "pending" for files that need re-syncing.

---

## Related

- [Config Files](config-files.md) -- Using `${KEY}` placeholders in config file templates
- [Environment Settings](environments.md) -- The `allowSecretReveal` toggle
- [Audit Logs](../audit.md) -- Tracking secret access
- [Configuration Reference](../configuration.md) -- `MASTER_KEY` environment variable
