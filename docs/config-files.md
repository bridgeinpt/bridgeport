# Config Files

Config files let you store, version, and sync configuration to your servers. Use them for Docker Compose files, Nginx configs, `.env` files, certificates, and any other file that needs to be deployed to servers.

## Creating a Config File

1. Navigate to **Config Files** in the sidebar
2. Click **Add Config File**
3. Enter:
   - **Name** — A display name (e.g., "App API .env")
   - **Filename** — The actual filename (e.g., `.env`, `nginx.conf`)
   - **Content** — The file contents (edit in the built-in editor)
   - **Description** — Optional description

### Binary Files

BridgePort also supports binary files (certificates, compiled configs, etc.):
- Upload binary files using the **Upload Asset** button
- Binary files are stored as base64 in the database
- They can be synced to servers just like text files

## Editing Config Files

Edit any config file from its detail page. Every edit is automatically saved to the version history.

### Secret Placeholders

Config files support secret substitution. Use `${SECRET_KEY}` in your file content:

```env
DATABASE_URL=${DATABASE_URL}
REDIS_URL=${REDIS_URL}
API_KEY=${API_KEY}
```

Placeholders are resolved at sync time — the actual secret values are written to the target server. The stored config file always contains the placeholder, not the secret value.

See [Secrets](secrets.md) for more on secret management.

## Version History

Every content edit creates a history entry with:
- Previous content
- Who made the edit
- Timestamp

### Restoring a Version

1. Go to the config file detail page
2. Click **History**
3. Select a previous version
4. Click **Restore**

The current content is saved as a new history entry before restoring, so you can always undo a restore.

## Attaching Files to Services

Config files exist at the environment level. To deploy them to a server, attach them to a service:

1. Go to the service detail page
2. In the **Config Files** section, click **Attach File**
3. Select the config file
4. Enter the **Target Path** — the absolute path on the server where the file should be written (e.g., `/opt/app/.env`)

A single config file can be attached to multiple services (on different servers) with different target paths.

### Editing the Target Path

Click the edit icon on an attached file to change its target path without detaching and reattaching.

## Syncing Files to Servers

After attaching and editing config files, sync them to the server:

### Per-Service Sync

1. Go to the service detail page
2. Click **Sync Files**
3. All attached files are written to their target paths on the server

### Per-Server Sync

Sync all config files for all services on a server at once:
1. Go to the server detail page
2. Click **Sync All Files**

### Per-File Sync

Sync a specific config file to all services it's attached to:
1. Go to the config file detail page
2. Click **Sync to All**

### What Happens During Sync

1. BridgePort connects to the server via SSH (or Docker socket)
2. Creates the target directory if it doesn't exist
3. Resolves any `${SECRET_KEY}` placeholders with actual secret values
4. Writes the file content to the target path
5. Updates the sync timestamp

## Sync Status

Each file attachment tracks its sync status:

| Status | Meaning |
|--------|---------|
| **Synced** | The file has been synced and hasn't changed since |
| **Pending** | The file was edited after the last sync |
| **Never** | The file has never been synced to this service |
| **Not Attached** | The file isn't attached to any service |

The config files list page shows the aggregate sync status across all attachments.

## Deleting a Config File

Delete a config file from its detail page. This removes it from the database but does not delete the file from servers where it was previously synced.
