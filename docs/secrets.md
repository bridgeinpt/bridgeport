# Secrets

BridgePort provides encrypted secret storage for sensitive configuration values like API keys, database passwords, and tokens.

## How Secrets Work

- Secrets are scoped to an environment (isolated between environments)
- Values are encrypted at rest using XChaCha20-Poly1305 with your `MASTER_KEY`
- All access to secret values is audit-logged
- Secrets are stored as key-value pairs with uppercase key naming (`DATABASE_URL`, `API_KEY`)

## Creating a Secret

1. Navigate to **Secrets** in the sidebar
2. Click **Add Secret**
3. Enter:
   - **Key** — Must be uppercase with underscores (e.g., `DATABASE_URL`)
   - **Value** — The secret value
   - **Description** — Optional description
   - **Write-Only** — If enabled, the secret value can never be revealed after creation

## Reveal Controls

BridgePort has two levels of reveal control:

### Environment-Level

In **Settings > Configuration**, admins can disable secret reveal for the entire environment. When disabled, no secrets in that environment can be viewed — they can only be updated or used in config file syncs.

This is recommended for production environments.

### Secret-Level (Write-Only)

Individual secrets can be marked as **write-only** (`neverReveal`). Once set, the secret value can never be revealed through the UI or API, regardless of environment settings. The value can still be updated.

Use this for highly sensitive credentials that should only be set once.

## Updating a Secret

1. Go to **Secrets** in the sidebar
2. Click the edit icon on the secret
3. Update the value, description, or write-only flag

Updating a secret's value re-encrypts it with the current `MASTER_KEY`.

## Secret Usage Tracking

The secrets list shows where each secret is used:
- Which config files reference the secret key
- Which services those config files are attached to

This helps you understand the impact of changing or deleting a secret.

## Using Secrets in Config Files

Secrets are automatically substituted when config files are synced to servers. Use the `${SECRET_KEY}` syntax in your config file content:

```env
DATABASE_URL=${DATABASE_URL}
API_KEY=${API_KEY}
DEBUG=false
REDIS_URL=${REDIS_URL}
```

When you sync this file to a server, BridgePort replaces each `${KEY}` with the decrypted secret value. If a referenced secret is missing, the sync will fail with an error listing the missing keys.

Supported placeholder formats:
- `${SECRET_KEY}` — Standard format
- `$SECRET_KEY` — Without braces
- `{{SECRET_KEY}}` — Double-brace format

## Deleting a Secret

Delete a secret from the secrets list. Before deleting, check the usage tracking to ensure no config files depend on it.
