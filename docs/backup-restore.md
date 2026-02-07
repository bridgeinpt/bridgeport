# Backup & Restore

This guide covers both backing up BridgePort itself and using BridgePort's database backup features.

## Backing Up BridgePort

All BridgePort data is stored in a single SQLite database file, including:
- Server, service, and environment configurations
- Config files (text and binary, stored as base64)
- Secrets and SSH keys (encrypted)
- Audit logs and metrics history
- User accounts and backup schedules

### What to Back Up

1. **Database file** — The file at the path defined by `DATABASE_URL` (e.g., `/data/bridgeport.db`)
2. **MASTER_KEY** — Store separately in a password manager or secrets vault

> **Warning**: Without the `MASTER_KEY`, encrypted data (secrets, SSH keys, registry credentials) cannot be decrypted. The database alone is not sufficient for a full restore.

### Backup Methods

**Simple file copy** (requires stopping BridgePort):
```bash
docker compose stop
cp /opt/bridgeport/data/bridgeport.db /backups/bridgeport-$(date +%Y%m%d).db
docker compose start
```

**SQLite online backup** (no downtime):
```bash
sqlite3 /opt/bridgeport/data/bridgeport.db ".backup '/backups/bridgeport-$(date +%Y%m%d).db'"
```

**Automated with cron**:
```bash
0 2 * * * sqlite3 /opt/bridgeport/data/bridgeport.db ".backup '/backups/bridgeport-$(date +\%Y\%m\%d).db'"
```

### Restoring BridgePort

1. Stop BridgePort: `docker compose stop`
2. Replace the database file with your backup
3. Ensure `MASTER_KEY` in `.env` matches the key used when the backup was created
4. Start BridgePort: `docker compose start`

```bash
docker compose stop
cp /backups/bridgeport-20250101.db /opt/bridgeport/data/bridgeport.db
docker compose start
```

## Database Backups (Managed by BridgePort)

BridgePort can manage backups for your application databases. See [Databases](databases.md) for full setup details.

### Backup Storage Options

#### Local Storage

Backups are stored on the database server's filesystem.

- **Backup Path** — Directory where backup files are written
- Accessible for download if environment settings allow it

#### DigitalOcean Spaces (S3-Compatible)

Backups are uploaded to a Spaces bucket for offsite storage.

**Setup**:
1. Go to **Settings > Spaces** (admin only)
2. Enter global Spaces credentials:
   - Access Key ID
   - Secret Access Key
   - Region / Endpoint
3. Enable Spaces for the target environment
4. When registering a database, select "Spaces" as storage type and choose a bucket

### Scheduled Backups

Configure automated backups with cron expressions:

```
0 2 * * *     # Daily at 2:00 AM
0 */6 * * *   # Every 6 hours
0 0 * * 0     # Weekly on Sunday at midnight
```

Set a retention period (1-365 days) to automatically clean up old backups.

### Backup Formats

For PostgreSQL databases:

| Format | Use Case |
|--------|----------|
| **Plain** | Human-readable SQL. Good for small databases and debugging. |
| **Custom** | Compressed, supports selective restore. Recommended for most cases. |
| **Tar** | Archive format, compatible with pg_restore. |

### Compression

| Option | Description |
|--------|-------------|
| **None** | No compression |
| **Gzip** | Compress with gzip (configurable level 1-9) |

### Downloading Backups

Backup downloads are controlled by the **Allow Backup Download** environment setting (disabled by default). When enabled:

- **Local backups**: File is streamed directly from the API
- **Spaces backups**: A presigned URL is generated for direct download

### Restore

BridgePort tracks backup files but does not perform automated restores. To restore a database:

1. Download the backup file from BridgePort
2. Use the appropriate database tool to restore:

**PostgreSQL (plain format)**:
```bash
psql -h hostname -U username -d database_name < backup.sql
```

**PostgreSQL (custom format)**:
```bash
pg_restore -h hostname -U username -d database_name backup.dump
```

**SQLite**:
```bash
cp backup.db /path/to/database.db
```
