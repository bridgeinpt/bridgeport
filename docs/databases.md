# Databases

BridgePort can manage backups and monitoring for your databases. Register your databases to enable scheduled backups, on-demand backups, and real-time monitoring.

## Supported Database Types

Database types are plugin-driven. Out of the box, BridgePort supports:

- **PostgreSQL** — Full backup (pg_dump) and monitoring support
- **MySQL** — Backup and monitoring support
- **SQLite** — File-based backup and monitoring via SSH

Additional database types can be added through the plugin system.

## Registering a Database

1. Navigate to **Databases** in the sidebar
2. Click **Add Database**
3. Enter:
   - **Name** — A friendly name (e.g., "Production API DB")
   - **Type** — Select the database type
   - **Server** — Which server hosts this database (for SSH-based operations)
   - **Connection Details** — Host, port, database name, username, password (for SQL databases) or file path (for SQLite)
   - **Backup Settings** — Storage type, path, format, compression

Connection credentials are encrypted at rest.

## Editing a Database

All database settings can be updated after creation:
- Connection details
- Backup configuration
- Monitoring settings

Go to the database detail page and edit the configuration.

## Backup Configuration

### Storage Types

| Type | Description |
|------|-------------|
| **Local** | Backups stored on the server's filesystem |
| **Spaces** | Backups uploaded to DigitalOcean Spaces (S3-compatible) |

For Spaces storage, configure global Spaces credentials at **Settings > Spaces** and enable Spaces for the environment.

### Backup Format (PostgreSQL)

| Format | Description |
|--------|-------------|
| **Plain** | SQL text dump |
| **Custom** | pg_dump custom format (supports selective restore) |
| **Tar** | Tar archive format |

### Compression

| Option | Description |
|--------|-------------|
| **None** | No compression |
| **Gzip** | Gzip compression (levels 1-9) |

### pg_dump Options

For PostgreSQL backups, you can configure:
- **No Owner** — Skip ownership commands
- **Clean** — Include DROP statements before CREATE
- **If Exists** — Use IF EXISTS with DROP statements
- **Schema Only** — Dump schema only (no data)
- **Data Only** — Dump data only (no schema)
- **Timeout** — pg_dump execution timeout (30 seconds to 1 hour)

## Manual Backups

Trigger a backup at any time:
1. Go to the database detail page
2. Click **Backup Now**

The backup runs asynchronously. You can monitor its status on the database detail page.

## Scheduled Backups

Set up automatic backups with a cron schedule:

1. Go to the database detail page
2. Configure the backup schedule:
   - **Cron Expression** — Standard cron format (e.g., `0 2 * * *` for daily at 2 AM)
   - **Retention Days** — How many days to keep backups (1-365)
   - **Enabled** — Toggle the schedule on/off

BridgePort's scheduler checks for due backups at the configured interval (default: every 60 seconds).

## Backup Management

From the database detail page, you can:
- **View** all backups with status, size, and timestamp
- **Download** backups (if allowed by environment settings)
- **Delete** old backups manually

### Download Permissions

Backup downloads are controlled by the **Allow Backup Download** setting in the environment's Data settings (admin only). This is disabled by default.

## Database Monitoring

BridgePort can continuously monitor your databases by running plugin-defined queries:

### Enabling Monitoring

1. Go to the database detail page
2. Enable **Monitoring**
3. Set the **Collection Interval** (how often to collect metrics)
4. Click **Test Connection** to verify

### How It Works

1. Monitoring queries are defined in the database type's plugin file
2. The collector runs on the scheduler at the configured interval
3. For SQL databases, queries run via direct database connections
4. For SSH-based databases (e.g., SQLite), commands run over SSH
5. Metrics are stored as JSON and displayed as charts

### Viewing Metrics

- **Monitoring > Databases** — Overview of all monitored databases with status and key metrics
- **Database Detail** — Detailed charts for individual databases, driven by the plugin's monitoring queries

For more on the monitoring system, see [Monitoring](monitoring.md).

## Deleting a Database

A database cannot be deleted if it has existing backups. Delete all backups first, then delete the database.
