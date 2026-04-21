# Backup & Restore

Protect your BRIDGEPORT instance and managed databases with regular backups, and know exactly how to restore when things go wrong.

---

## Table of Contents

- [BRIDGEPORT's Own Data](#bridgeports-own-data)
- [Backup Methods](#backup-methods)
- [Automating Backups with Cron](#automating-backups-with-cron)
- [The MASTER_KEY](#the-master_key)
- [Restoring BRIDGEPORT](#restoring-bridgeport)
- [Managed Database Backups](#managed-database-backups)
- [Storage Options](#storage-options)
- [Recovery Scenarios](#recovery-scenarios)

---

## BRIDGEPORT's Own Data

All BRIDGEPORT data lives in a single SQLite database file. This includes:

- Server, service, and environment configurations
- Config files (text and binary, stored as base64)
- Secrets and SSH keys (encrypted with AES-256-GCM)
- Registry credentials (encrypted)
- User accounts and API tokens
- Audit logs, health check logs, and metrics history
- Deployment history and orchestration plans
- Notification types, preferences, and bounce trackers
- Topology diagrams and service connections

### What to Back Up

| Item | Location | Required? |
|------|----------|-----------|
| **Database file** | Path from `DATABASE_URL` (default: `/data/bridgeport.db`) | Yes |
| **MASTER_KEY** | Your `.env` file or environment variables | Yes |
| **Upload directory** | Path from `UPLOAD_DIR` (default: `/data/uploads`) | Yes, if you use binary config files |

> [!WARNING]
> Without the `MASTER_KEY`, encrypted data (secrets, SSH keys, registry credentials, SMTP passwords) cannot be decrypted. The database alone is not sufficient for a full restore. Store your `MASTER_KEY` separately in a password manager or secrets vault.

---

## Backup Methods

### Simple File Copy (requires brief stop)

Stop BRIDGEPORT to ensure the database is not being written to:

```bash
docker compose stop
cp ./data/bridgeport.db ./backups/bridgeport-$(date +%Y%m%d).db
docker compose start
```

Downtime: under 10 seconds for the copy itself.

### SQLite Online Backup (no downtime)

SQLite's built-in `.backup` command creates a consistent snapshot while the database is in use:

```bash
sqlite3 ./data/bridgeport.db ".backup './backups/bridgeport-$(date +%Y%m%d).db'"
```

This is the recommended method for production. It uses SQLite's backup API, which handles concurrent writes safely.

> [!TIP]
> If `sqlite3` is not installed on your host, you can run it from inside the BRIDGEPORT container:
> ```bash
> docker exec bridgeport sqlite3 /data/bridgeport.db ".backup '/data/backups/bridgeport-$(date +%Y%m%d).db'"
> ```

---

## Automating Backups with Cron

Add a cron job on the host machine to back up daily:

```bash
# Edit the crontab
crontab -e

# Add this line (daily at 2:00 AM, keeps backups in /opt/bridgeport/backups)
0 2 * * * sqlite3 /opt/bridgeport/data/bridgeport.db ".backup '/opt/bridgeport/backups/bridgeport-$(date +\%Y\%m\%d).db'"
```

To clean up old backups automatically, add a second cron entry:

```bash
# Delete backups older than 30 days (daily at 3:00 AM)
0 3 * * * find /opt/bridgeport/backups -name "bridgeport-*.db" -mtime +30 -delete
```

---

## The MASTER_KEY

The `MASTER_KEY` is a 32-byte (base64-encoded) value used to encrypt and decrypt all sensitive data in BRIDGEPORT. It is the single most important secret in your deployment.

### What It Protects

- All secrets stored in the Secrets page
- SSH private keys for each environment
- Registry connection tokens and passwords
- SMTP email passwords
- Slack webhook URLs
- Spaces (S3) secret keys

### Best Practices

1. **Generate a strong key**: `openssl rand -base64 32`
2. **Store it in a password manager or secrets vault** -- not just in the `.env` file
3. **Back it up separately from the database** -- a database backup without the key is incomplete
4. **Never change it in place** -- if you need to rotate, you must decrypt all values with the old key and re-encrypt with the new one
5. **Keep the same key across upgrades** -- the key must match what was used to encrypt existing data

---

## Restoring BRIDGEPORT

### Standard Restore

1. Stop BRIDGEPORT:
   ```bash
   docker compose stop
   ```

2. Replace the database with your backup:
   ```bash
   cp ./backups/bridgeport-20260225.db ./data/bridgeport.db
   ```

3. Verify your `MASTER_KEY` in `.env` matches the key used when the backup was created.

4. Start BRIDGEPORT:
   ```bash
   docker compose up -d
   ```

5. Verify the restore:
   ```bash
   curl -s http://localhost:3000/health | jq .
   ```

> [!NOTE]
> If you are restoring a backup made with an older version of BRIDGEPORT onto a newer version, the entrypoint script will automatically apply any pending migrations. This is safe and expected.

### Restoring to a Different Server

1. Copy the database backup and your `.env` file to the new server
2. Ensure the `MASTER_KEY` and `JWT_SECRET` in `.env` match the original deployment
3. Set up the same volume mount structure (or adjust `DATABASE_URL` and `UPLOAD_DIR`)
4. Start BRIDGEPORT -- it will detect the existing database and apply any needed migrations

---

## Managed Database Backups

BRIDGEPORT can manage backups for your application databases (PostgreSQL, MySQL, SQLite). For full setup instructions, see the [Databases guide](../guides/databases.md).

### Quick Summary

- **Schedule backups** with cron expressions (e.g., `0 2 * * *` for daily at 2 AM)
- **Set retention** to automatically clean up old backups (1-365 days)
- **Manual backups** can be triggered from the database detail page
- **Formats**: Plain SQL, custom (pg_dump), or tar for PostgreSQL
- **Compression**: None or gzip (configurable level 1-9)

### Restoring a Managed Database

BRIDGEPORT tracks backup files but does not perform automated restores. Download the backup and use the appropriate tool:

**PostgreSQL (plain SQL format)**:
```bash
psql -h hostname -U username -d database_name < backup.sql
```

**PostgreSQL (custom format)**:
```bash
pg_restore -h hostname -U username -d database_name backup.dump
```

**MySQL**:
```bash
mysql -h hostname -u username -p database_name < backup.sql
```

**SQLite**:
```bash
cp backup.db /path/to/database.db
```

---

## Storage Options

Managed database backups can be stored in two locations:

### Local Storage

Backups are written to the database server's filesystem. Configure the `backupLocalPath` on the database (e.g., `/var/backups/postgres`).

- Simple to set up
- Accessible for download if **Allow Backup Download** is enabled in environment settings
- Risk: backups are on the same server as the database

### S3-Compatible Storage (Spaces)

Backups are uploaded to an S3-compatible bucket for offsite storage. Setup:

1. Configure global storage credentials in **Admin > Storage**
2. Enable storage for the target environment
3. Set storage type to "Spaces" when configuring the database
4. Choose a bucket and optional key prefix

Supports DigitalOcean Spaces, AWS S3, MinIO, Backblaze B2, Wasabi, Cloudflare R2, and any S3-compatible service.

For detailed setup, see the [Storage guide](../guides/storage.md).

---

## Recovery Scenarios

### Corrupted BRIDGEPORT Database

**Symptoms**: BRIDGEPORT won't start, logs show "database disk image is malformed" or migration errors.

**Recovery**:

1. Stop BRIDGEPORT:
   ```bash
   docker compose stop
   ```

2. Try SQLite's integrity check:
   ```bash
   sqlite3 ./data/bridgeport.db "PRAGMA integrity_check;"
   ```

3. If the check fails, restore from your most recent backup:
   ```bash
   cp ./backups/bridgeport-latest.db ./data/bridgeport.db
   docker compose up -d
   ```

4. If no backup exists, you can attempt SQLite recovery:
   ```bash
   sqlite3 ./data/bridgeport.db ".recover" | sqlite3 ./data/bridgeport-recovered.db
   mv ./data/bridgeport-recovered.db ./data/bridgeport.db
   docker compose up -d
   ```

### Lost MASTER_KEY

**Impact**: All encrypted data becomes irrecoverable. This includes secrets, SSH keys, registry credentials, SMTP passwords, and Slack webhook URLs.

**What still works**: Unencrypted data remains accessible -- servers, services, environments, config files, users, audit logs, metrics, and deployment history.

**Recovery steps**:

1. Generate a new `MASTER_KEY`:
   ```bash
   openssl rand -base64 32
   ```

2. Update your `.env` with the new key

3. Restart BRIDGEPORT:
   ```bash
   docker compose up -d
   ```

4. Re-create all encrypted resources:
   - Re-upload SSH keys for each environment (Settings > SSH)
   - Re-enter registry credentials (Registries page)
   - Re-create all secrets (Secrets page)
   - Re-configure SMTP if applicable (Admin > Notifications)

### Failed Migration on Startup

**Symptoms**: Container exits on startup, logs show a Prisma migration error.

**Recovery**:

1. Check the logs for the specific error:
   ```bash
   docker logs bridgeport
   ```

2. The issue is in the migration SQL. This is a bug in the BRIDGEPORT release.

3. Restore your pre-upgrade database backup:
   ```bash
   cp ./backups/bridgeport-pre-upgrade.db ./data/bridgeport.db
   ```

4. Pin BRIDGEPORT to the previous working version until the issue is fixed:
   ```yaml
   services:
     bridgeport:
       image: ghcr.io/bridgeinpt/bridgeport:previous-tag
   ```

5. Report the migration issue to the BRIDGEPORT maintainers.

### Lost SSH Key

If an environment's SSH key is lost or compromised:

1. Generate a new SSH key pair:
   ```bash
   ssh-keygen -t ed25519 -f /tmp/bridgeport-env -N ""
   ```

2. Add the public key to `~/.ssh/authorized_keys` on all servers in that environment

3. Upload the new private key in BRIDGEPORT: **Settings > SSH** for that environment

4. Test connectivity from **Monitoring > Agents** using the SSH test feature

---

## Related Documentation

- [Upgrades](upgrades.md) -- back up before upgrading
- [Security & Hardening](security.md) -- protecting your MASTER_KEY
- [Troubleshooting](troubleshooting.md) -- diagnosing backup failures
- [Storage](../guides/storage.md) -- setting up S3-compatible storage
- [Databases](../guides/databases.md) -- managed database backup configuration
