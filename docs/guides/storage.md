Configure S3-compatible object storage so BridgePort can upload database backups to a remote bucket instead of (or in addition to) the local filesystem.

## Table of Contents

- [Overview](#overview)
- [Supported Providers](#supported-providers)
- [Setup Guide](#setup-guide)
  - [Step 1: Navigate to Admin → Storage](#step-1-navigate-to-admin--storage)
  - [Step 2: Enter Credentials](#step-2-enter-credentials)
  - [Step 3: Configure Buckets](#step-3-configure-buckets)
  - [Step 4: Test the Connection](#step-4-test-the-connection)
  - [Step 5: Enable Per Environment](#step-5-enable-per-environment)
- [Provider-Specific Configuration](#provider-specific-configuration)
  - [DigitalOcean Spaces](#digitalocean-spaces)
  - [AWS S3](#aws-s3)
  - [MinIO](#minio)
  - [Backblaze B2](#backblaze-b2)
  - [Wasabi](#wasabi)
  - [Cloudflare R2](#cloudflare-r2)
- [Scoped Keys](#scoped-keys)
- [Per-Environment Control](#per-environment-control)
- [Troubleshooting](#troubleshooting)
- [Related](#related)

---

## Overview

BridgePort's storage feature (labeled **Storage** in the admin UI, backed by the internal name "Spaces") provides a single, globally configured S3-compatible endpoint that any environment can opt into. Once configured and enabled for an environment, you can point individual databases at a specific bucket when setting up backups.

**What storage is for:**

- Offsite storage for database backup files (PostgreSQL dumps, SQLite exports)
- Download via presigned URL instead of streaming through the BridgePort server

**What storage is not for:**

- General file hosting
- Config file syncing (that goes through SSH directly to servers)
- BridgePort's own database — see [Backup & Restore](../backup-restore.md) for that

There is one storage configuration per BridgePort installation. Each environment can independently be enabled or disabled against that configuration.

---

## Supported Providers

BridgePort uses the AWS S3 SDK internally, so any provider that speaks the S3 API works. Tested providers:

| Provider | Notes |
|----------|-------|
| **DigitalOcean Spaces** | Default region dropdown values target Spaces. Endpoint auto-derived from region. |
| **AWS S3** | No custom endpoint needed. Use `us-east-1` (or your bucket's region). |
| **MinIO** | Set a custom endpoint pointing to your MinIO host. |
| **Backblaze B2** | Requires custom endpoint. S3-compatible API available on B2. |
| **Wasabi** | Requires custom endpoint. Region must match your bucket's region. |
| **Cloudflare R2** | Requires custom endpoint. R2 doesn't support `ListBuckets`; use scoped keys with manual bucket names. |

---

## Setup Guide

### Step 1: Navigate to Admin → Storage

Go to **Admin** in the sidebar, then click **Storage**. This page is only visible to admin users.

### Step 2: Enter Credentials

Click **Configure Spaces** (if no configuration exists) or **Edit** (to update an existing one).

Fill in the following fields:

| Field | Required | Description |
|-------|----------|-------------|
| **Access Key** | Yes | The access key ID for your S3-compatible storage. |
| **Secret Key** | Yes (new config only) | The secret access key. On updates, leave blank to keep the existing value. |
| **Region** | Yes | The region your bucket lives in. Defaults to `fra1`. |
| **Endpoint** | Derived | For DigitalOcean Spaces, this is auto-derived from the region (`{region}.digitaloceanspaces.com`). For other providers, enter the custom endpoint directly in the Region field (see [Provider-Specific Configuration](#provider-specific-configuration)). |
| **Buckets** | No | Manual bucket list for scoped keys. Leave empty if your key has full API access. |

The secret key is encrypted at rest using XChaCha20-Poly1305 and is never returned to the client after saving.

Click **Save Configuration** when done.

### Step 3: Configure Buckets

BridgePort needs to know which buckets are available for backup storage. There are two modes:

**Auto-discovery (full-access keys):** If your key has permission to call `ListBuckets`, BridgePort discovers available buckets automatically. Leave the Buckets field empty.

**Manual list (scoped keys):** If your key is restricted to specific buckets, `ListBuckets` will return a 403 and auto-discovery won't work. Add the bucket names manually in the **Buckets** field. BridgePort will test access to each bucket individually using `HeadBucket`.

See [Scoped Keys](#scoped-keys) for more on when and why to use this.

### Step 4: Test the Connection

After saving, click **Test Connection**. BridgePort will:

1. Attempt `ListBuckets` if no buckets are manually configured.
2. If `ListBuckets` returns 403, report that the key appears to be scoped and prompt you to add bucket names.
3. If buckets are manually configured, run `HeadBucket` on each and report accessible vs. failed.

A successful test confirms credentials are valid and at least one bucket is reachable.

> [!NOTE]
> The connection test uses the saved credentials, not the form fields. Save first, then test.

### Step 5: Enable Per Environment

After the global configuration is saved, scroll down to the **Environment Access** section. Each environment has a toggle. Only environments where storage is enabled can use cloud backup storage.

You can enable storage for production while leaving staging pointed at local storage — see [Per-Environment Control](#per-environment-control).

---

## Provider-Specific Configuration

The **Region** field accepts either a short region code (for DigitalOcean Spaces, where the endpoint is auto-derived) or a custom hostname. For non-DigitalOcean providers, enter the full endpoint hostname in the Region field, since the endpoint will otherwise be constructed as `{region}.digitaloceanspaces.com`.

> [!TIP]
> For non-DigitalOcean providers, set the Region field to the provider's expected region string and supply the full endpoint manually via the API or ensure the derived endpoint is overridden. In the current UI, the endpoint is auto-derived; use the API (`PUT /api/settings/spaces`) to set a custom `endpoint` value separate from `region`.

### DigitalOcean Spaces

No custom endpoint needed. Select a region from the dropdown:

| Region Code | Location |
|-------------|----------|
| `fra1` | Frankfurt (default) |
| `nyc3` | New York |
| `sfo3` | San Francisco |
| `ams3` | Amsterdam |
| `sgp1` | Singapore |
| `syd1` | Sydney |

The endpoint is automatically set to `{region}.digitaloceanspaces.com`.

### AWS S3

```
Region:   us-east-1          (or your bucket's region)
Endpoint: s3.amazonaws.com   (no custom endpoint needed for standard S3)
```

For AWS, the SDK resolves the correct endpoint from the region. Leave the Buckets field empty if your key has `s3:ListAllMyBuckets` permission.

### MinIO

```
Region:   us-east-1          (or whatever your MinIO instance is configured with)
Endpoint: minio.example.com  (your MinIO hostname, without https://)
```

BridgePort prepends `https://` to the endpoint automatically. Ensure your MinIO instance has a valid TLS certificate, or use a reverse proxy that terminates TLS.

### Backblaze B2

```
Region:   us-west-004
Endpoint: s3.us-west-004.backblazeb2.com
```

Replace `us-west-004` with your bucket's actual region. Backblaze B2's S3-compatible API requires the region to match the bucket location.

### Wasabi

```
Region:   us-east-1
Endpoint: s3.us-east-1.wasabisys.com
```

Wasabi endpoint format: `s3.{region}.wasabisys.com`. Use the region where your bucket was created.

### Cloudflare R2

```
Region:   auto
Endpoint: {account-id}.r2.cloudflarestorage.com
```

R2 does not support `ListBuckets`. You must add bucket names manually in the Buckets field — the connection test will use `HeadBucket` to verify access.

---

## Scoped Keys

A scoped (bucket-scoped) key is a set of credentials that has been granted access only to specific buckets, rather than full API access to the storage account. This is a common security practice: the key BridgePort holds can only read and write to the backup bucket, not enumerate or access other buckets.

**Why use a scoped key:**

- Limits the blast radius if credentials are compromised
- Required by some organizational policies
- R2 and some other providers effectively issue scoped keys by default

**How BridgePort handles scoped keys:**

1. You enter the key credentials and save.
2. You add the bucket names manually in the Buckets field (since `ListBuckets` will return 403).
3. BridgePort tests each configured bucket with `HeadBucket` and reports which are accessible.
4. During backup upload, BridgePort writes to the configured bucket for that database.

If you run the connection test with a scoped key but no buckets configured, you'll see:

```
This appears to be a bucket-scoped key. Please add the bucket names manually.
```

Add the bucket names and save, then test again.

> [!WARNING]
> If you configure a scoped key with no bucket names, backups will fail at the upload step. Always add bucket names when using scoped keys.

---

## Per-Environment Control

Storage is configured globally (one set of credentials for the whole installation) but activated per environment. This means:

- A single set of S3 credentials can serve multiple environments
- Each environment can use a different bucket, or the same bucket with different key prefixes
- Environments where storage is disabled will not attempt cloud uploads even if a database is configured for Spaces storage

**Common pattern:** Enable storage for production (where offsite backup durability matters) and leave staging pointed at local storage (to avoid unnecessary cloud costs).

When a backup runs for a database configured with `storage type: spaces`:

1. BridgePort checks whether storage is enabled for that environment.
2. If enabled, it reads the global credentials, constructs an S3 client, and uploads to the configured bucket.
3. If storage is not enabled for the environment, the backup fails with: `Spaces not configured for this environment. Go to Settings > Spaces to configure.`

The default object key prefix is `{environment-name}/{database-name}/`, set automatically when you create a database with Spaces storage. You can override this in the database settings.

---

## Troubleshooting

**`AccessDenied` on ListBuckets**

Your key does not have permission to list buckets. This is expected for scoped keys. Add bucket names manually and the test will switch to `HeadBucket` mode.

**`AccessDenied` on HeadBucket**

The key does not have access to that specific bucket. Verify:
- The bucket name is spelled correctly (case-sensitive)
- The key's policy includes `s3:GetBucketLocation` or equivalent for that bucket
- For AWS, the bucket is in the region you specified

**Wrong endpoint / connection refused**

The endpoint is constructed as `https://{endpoint}`. Verify:
- No `https://` prefix in the endpoint field
- No trailing slash
- The hostname resolves and is reachable from the BridgePort server

For DigitalOcean Spaces, the endpoint is auto-derived as `{region}.digitaloceanspaces.com`. If you see a connection error, check that the region code is valid.

**Backup fails at upload step**

Check that:
1. Storage is enabled for the environment (Admin → Storage → Environment Access)
2. The database has a bucket configured
3. The configured bucket name matches one the key can access

**Presigned download URL doesn't work**

Presigned URLs generated for Spaces backups are valid for 1 hour. If the link is expired, trigger a new download from the BridgePort UI.

> [!NOTE]
> Backup downloads via presigned URL are subject to the **Allow Backup Download** environment setting (found in Settings → Data). This is disabled by default.

---

## Related

- [Databases](../databases.md) — Configure a database to use Spaces for backup storage
- [Backup & Restore](../backup-restore.md) — Full backup workflow, formats, scheduling, and restore procedures
- [Environments](../environments.md) — Overview of environment-level settings
