# Environments

Environments are the top-level organizational unit in BridgePort. They represent logical groupings of infrastructure — typically matching your deployment stages (e.g., `staging`, `production`).

## Creating an Environment

1. In the sidebar, click the environment selector dropdown
2. Click **Create Environment**
3. Enter a name (e.g., `production`)

Creating an environment requires **admin** privileges.

When an environment is created, default settings are automatically initialized for all settings modules.

## What Belongs to an Environment

Each environment is an isolated namespace containing:

- **Servers** — The machines in this environment
- **Services** — Docker containers running on those servers
- **Container Images** — Image definitions with registry links and auto-update settings
- **Secrets** — Encrypted key-value pairs (e.g., API keys, database passwords)
- **Config Files** — Configuration files that can be synced to servers
- **Databases** — Registered databases for backup and monitoring
- **Registry Connections** — Links to container registries

Resources in one environment cannot access resources in another.

## SSH Keys

Each environment has its own SSH private key for connecting to servers.

### Uploading an SSH Key

1. Go to **Settings** (in the sidebar, admin only)
2. Navigate to the environment settings
3. Upload your SSH private key

The SSH key is encrypted at rest using the `MASTER_KEY`. BridgePort uses this key for all SSH connections to servers in the environment.

### SSH User

The default SSH user for the environment is configurable in **Settings > General** (default: `root`). Individual servers can override this if needed.

## Environment Settings

Environment settings are organized into modules, each controlling a different aspect of BridgePort's behavior for that environment. Access them at **Settings** in the sidebar.

### General
- SSH user configuration

### Monitoring
- Enable/disable monitoring
- Health check intervals
- Container discovery intervals
- Metrics collection intervals and retention
- Alert thresholds

### Operations
- Deployment-related settings

### Data
- Backup download permissions

### Configuration
- Secret reveal control (whether secrets can be viewed in the UI)

See [Configuration Reference](configuration.md) for full details on each setting.

## Switching Environments

Use the environment selector in the sidebar to switch between environments. Your selection is persisted across browser sessions.

All pages automatically filter to show resources from the selected environment.
