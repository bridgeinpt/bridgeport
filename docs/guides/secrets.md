# Secrets and Variables

BRIDGEPORT stores your configuration values -- encrypted secrets (API keys, passwords, tokens) or plaintext variables (hostnames, ports, feature flags) -- and makes them available to services through config file templates with automatic `${KEY}` placeholder substitution.

Two entities, one resolution pipeline:

- **Secrets** -- encrypted at rest (AES-256-GCM), access-controlled, audit-logged. For sensitive values.
- **Variables (Vars)** -- stored as plaintext, no reveal restrictions. For non-sensitive values you still want to centralize and reuse across files.

Both are environment-scoped and resolve the same `${KEY}` placeholder syntax. If the same key exists as both a var and a secret, the **secret wins**.

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Creating Secrets](#creating-secrets)
- [Creating Variables](#creating-variables)
- [Using Placeholders in Config Files](#using-placeholders-in-config-files)
- [Config File Scanner](#config-file-scanner)
- [Reveal Controls](#reveal-controls)
- [Usage Tracking](#usage-tracking)
- [Updating and Rotating](#updating-and-rotating)
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
6. Attach the config file to a service, then **Sync Files** -- BRIDGEPORT writes the resolved value to the server.

---

## How It Works

Secrets and vars in BRIDGEPORT follow a simple flow: store (encrypted for secrets, plaintext for vars), reference by name, resolve at sync time.

```mermaid
flowchart LR
    S[Secret<br/>key: DATABASE_URL] --> E[Encrypted with<br/>AES-256-GCM]
    V[Var<br/>key: LOG_LEVEL] --> P[Plaintext]
    E --> DB[(Database)]
    P --> DB

    CF[Config file template<br/>with ${KEY} placeholders] --> Sync[Sync to server]
    DB --> Sync
    Sync --> Server[Server file<br/>resolved values]
```

**Key concepts:**

- **Environment-scoped.** Both secrets and vars belong to an environment. A `DATABASE_URL` in staging is independent from one in production. Keys must be unique within `(environment, entity)` -- you can have `FOO` as both a secret and a var in the same environment, but not two secrets named `FOO`.
- **Encryption only for secrets.** Secret values are encrypted using AES-256-GCM with the `MASTER_KEY` before being stored; the nonce is stored alongside the ciphertext. Vars are stored as plaintext.
- **Audit-logged.** Secret access (reveal, sync, update) is recorded in the audit log. Var create/update/delete are also audited.
- **Template-based usage.** Neither secrets nor vars are injected at runtime. They are substituted into config file templates at sync time and written as static files to the server.
- **Resolution order.** Vars are substituted first, then secrets. If the same key exists in both, the secret value wins.

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

## Creating Variables

Variables live on the **Vars** tab of the Secrets and Variables page. Use them for non-sensitive values you still want to centralize -- log levels, feature flags, hostnames, ports -- so the same value doesn't get duplicated across config files.

### Via the UI

1. Navigate to **Configuration > Secrets and Variables**.
2. Switch to the **Vars** tab.
3. Click **Add Variable**.
4. Fill in the form:

| Field | Required | Description |
|-------|----------|-------------|
| **Key** | Yes | Uppercase name with underscores (e.g., `LOG_LEVEL`). Must match `^[A-Z][A-Z0-9_]*$`. |
| **Value** | Yes | The variable value. Any string. |
| **Description** | No | Optional description for documentation. |

5. Click **Create**.

### Via the API

```http
POST /api/environments/:envId/vars
Authorization: Bearer <token>
Content-Type: application/json

{
  "key": "LOG_LEVEL",
  "value": "info",
  "description": "Application log level"
}
```

```http
PATCH /api/vars/:id
DELETE /api/vars/:id
```

> [!NOTE]
> Var values are stored as plaintext and are always visible in the UI and API. Do not use vars for passwords, tokens, or any value you wouldn't want in a shared document. Use secrets instead.

### When to Use a Var Instead of a Secret

| Use a **Var** for | Use a **Secret** for |
|-------------------|----------------------|
| Log levels, feature flags | API keys, tokens |
| Public hostnames, URLs | Passwords, private keys |
| Ports, timeouts | Certificates, signing keys |
| Docker image tags | Database connection strings with credentials |

If in doubt, prefer a secret -- it costs nothing extra and preserves future flexibility.

---

## Using Placeholders in Config Files

Secrets and vars come to life when you reference them in [config files](config-files.md). The standard placeholder syntax is `${KEY}` -- the same for both.

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

When you sync this file to a server, BRIDGEPORT resolves each `${KEY}` placeholder with the corresponding secret value from the environment. The file written to the server contains the actual values:

```env
# Application configuration
DATABASE_URL=postgres://user:pass@db-host:5432/appdb
REDIS_URL=redis://redis-host:6379/0
API_KEY=sk-live-abc123def456
DEBUG=false
LOG_LEVEL=info
```

### Placeholder Syntax

BRIDGEPORT recognizes the following placeholder formats when listing secret usage:

| Format | Example | Used For |
|--------|---------|----------|
| `${KEY}` | `${DATABASE_URL}` | Standard format, resolved during sync |
| `$KEY` | `$DATABASE_URL` | Detected for usage tracking |
| `{{KEY}}` | `{{DATABASE_URL}}` | Detected for usage tracking |

> [!WARNING]
> Only the `${KEY}` format is resolved during config file sync. The `$KEY` and `{{KEY}}` formats are used for usage tracking only -- they will *not* be substituted with secret values when syncing files to servers.

### Missing Keys

If a config file references a key that does not exist as either a secret or a var in the environment, the sync fails with an error listing the missing keys. This is a safety measure -- BRIDGEPORT will not write a file with unresolved placeholders to your server. Create the missing secret or var first, then retry the sync.

### Template Flow

```mermaid
flowchart TD
    A[Config file template<br/>stored in BRIDGEPORT] --> B[Sync triggered<br/>per-service or per-server]
    B --> C[Fetch vars + decrypted secrets<br/>for the environment]
    C --> D[Substitute vars first,<br/>then secrets over them]
    D --> E{Any unresolved<br/>placeholders?}
    E -->|Yes| F[Sync fails<br/>lists missing keys]
    E -->|No| G[Write resolved file<br/>to target path via SSH]
    G --> H[Update lastSyncedAt<br/>timestamp]
```

---

## Config File Scanner

The **Config File Scanner** inspects every non-binary config file in the environment and flags hardcoded values that should probably be promoted to a secret or a var. It catches three kinds of issues:

- **Cross-file repetition** -- the same literal value appears in two or more files (classic duplication -- rotate one, forget the other).
- **Cross-key repetition** -- the same literal value appears under two or more different keys (often a sign the value has drifted from its canonical name).
- **Plaintext leaks** -- the literal value matches an existing secret or var, meaning the plaintext is sitting in a config file it shouldn't be.

Binary files are skipped. The scan runs on demand; nothing is scanned or stored automatically.

### Running a Scan

1. Navigate to **Configuration > Secrets and Variables**.
2. Expand the **Scan Suggestions** panel (or click **Run Scan**).
3. BRIDGEPORT reports all suggestions sorted by occurrence count (highest first), with secret-looking values ranked above var-looking ones on ties.

Each suggestion includes:

- A **masked preview** of the value (first 3 + `...` + last 3 chars, or dots for short values) so the raw value never appears on screen.
- A **proposed key** derived from the most common key name seen, normalized to `UPPER_SNAKE_CASE`.
- A **proposed type** (`secret` or `var`). Keys containing `password`, `secret`, `key`, `token`, `api`, `auth`, `credential`, `cert`, or `private` are classified as secrets; everything else as vars.
- The **affected files** and per-file occurrence counts.
- If the value matches an existing secret/var, a pointer to it so you can reuse the existing key rather than creating a duplicate.

### Review and Apply

Applying a suggestion walks through a 3-step modal:

1. **Confirm** -- review the proposed key, type, and affected files. Edit the key or type before proceeding.
2. **Preview** -- see a diff for every affected file showing `literal-value` → `${KEY}` with a replacement count. Nothing is written yet.
3. **Apply** -- BRIDGEPORT creates the secret or var (if not already present), substitutes the value in every selected file, saves the previous content to [file history](config-files.md#file-history) for rollback, and writes an audit log entry per mutation with `source: config_scan`.

The scan itself is read-only and always safe to run. Only the apply step mutates data.

### Tuning the Scanner

Two per-environment settings control sensitivity (both are in **Settings > Configuration**, group "Config Scanner"):

| Setting | Default | Description |
|---------|---------|-------------|
| `scanMinLength` | 6 | Minimum value length to consider. Shorter values are ignored. Valid range 1--100. |
| `scanEntropyThreshold` | 25 | Shannon entropy threshold, stored as `×10` (25 = 2.5 bits/char). Values below this are filtered out. Valid range 0--80. |

Raise `scanEntropyThreshold` if you're getting too many suggestions for low-entropy strings (short words, common defaults). Lower it if real secrets are being missed.

Values that already look like placeholders (start with `${`, `$`, or `{{`) are never suggested.

### API

```http
POST /api/environments/:envId/config-scan
Authorization: Bearer <token>
```

Returns `{ suggestions, scannedFileCount, skippedBinaryCount }`. Values in `suggestions[].value` are masked, not raw.

```http
POST /api/environments/:envId/config-scan/preview
POST /api/environments/:envId/config-scan/apply
Authorization: Bearer <token>
Content-Type: application/json

{
  "value": "the-literal-value-to-replace",
  "key": "MY_KEY",
  "type": "secret",
  "fileIds": ["cf1", "cf2"],
  "existingSecretId": null
}
```

Set `existingSecretId` to reuse an existing secret or var instead of creating a new one.

---

## Reveal Controls

BRIDGEPORT has two independent layers of reveal control to protect sensitive values.

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

## Usage Tracking

The Secrets and Vars tabs both show where each key is referenced, so you can understand the impact of changing or deleting an entry before you do it.

For every secret and var, BRIDGEPORT scans all config files in the environment and reports:

- **Config files** that reference the key (by detecting `${KEY}`, `$KEY`, or `{{KEY}}` patterns; vars also match leading `KEY=` lines).
- **Services** that those config files are attached to.
- **Usage count** -- the number of unique services using the key.

This is computed at list time by scanning config file content, not stored separately.

```http
GET /api/environments/:envId/secrets
GET /api/environments/:envId/vars
Authorization: Bearer <token>
```

Each entry in the response includes:
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

## Updating and Rotating

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

Updating a secret re-encrypts the value with the current `MASTER_KEY`. Vars use `PATCH /api/vars/:id` with the same `{ value?, description? }` shape and are updated in place. After updating either, config files that reference the key will show a "pending" sync status until re-synced.

### Rotation Workflow

When rotating a secret (e.g., a database password):

1. Update the secret value in BRIDGEPORT.
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

### Var Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `key` | string | -- | Uppercase key name (unique per environment) |
| `value` | string | -- | Plaintext value |
| `description` | string | null | Optional documentation |

### Related Environment Settings

| Setting | Location | Default | Description |
|---------|----------|---------|-------------|
| `allowSecretReveal` | Settings > Configuration > Security | true | Environment-level reveal toggle (admin only) |
| `scanMinLength` | Settings > Configuration > Config Scanner | 6 | Minimum value length considered by the scanner |
| `scanEntropyThreshold` | Settings > Configuration > Config Scanner | 25 | Shannon entropy threshold ×10 (25 = 2.5 bits/char) |

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
The config file references keys that exist as neither a secret nor a var in this environment. Create the missing entry (as a secret if sensitive, as a var otherwise), then retry the sync.

**Secret value not updating on the server after change**
Updating a secret or var in BRIDGEPORT does not automatically sync config files. After updating, re-sync the config files attached to the affected services. The sync status will show "pending" for files that need re-syncing.

**"Var already exists"**
Var keys must be unique within an environment (same rule as secrets, but tracked on a separate table). The same key *can* exist as both a secret and a var in one environment -- the secret takes precedence at resolution time.

**Config scanner returns no suggestions**
The scanner only surfaces values that (a) meet `scanMinLength`, (b) exceed `scanEntropyThreshold`, and (c) appear in multiple files, under multiple keys, or match an existing secret/var. If nothing qualifies, the panel stays empty. Lower the entropy threshold in Settings > Configuration to catch more candidates.

---

## Related

- [Config Files](config-files.md) -- Using `${KEY}` placeholders in config file templates
- [Environment Settings](environments.md) -- The `allowSecretReveal` toggle
- [Audit Logs](../audit.md) -- Tracking secret access
- [Configuration Reference](../configuration.md) -- `MASTER_KEY` environment variable
