# CLI Reference

The BridgePort CLI provides terminal access to your infrastructure -- SSH into servers, view logs, run commands in containers, and manage resources without leaving the command line.

## Table of Contents

- [Installation](#installation)
- [Global Flags](#global-flags)
- [Configuration](#configuration)
- [Authentication and Identity](#authentication-and-identity)
  - [login](#login)
  - [whoami](#whoami)
  - [config](#config)
- [Server Operations](#server-operations)
  - [list](#list)
  - [status](#status)
  - [ssh](#ssh)
  - [exec](#exec)
  - [logs](#logs)
  - [run](#run)
- [Resource Management](#resource-management)
  - [services](#services)
  - [databases](#databases)
  - [secrets](#secrets)
  - [configs](#configs)
  - [images](#images)
  - [registries](#registries)
- [Monitoring and Operations](#monitoring-and-operations)
  - [health](#health)
  - [backups](#backups)
  - [audit](#audit)
- [Utilities](#utilities)
  - [version](#version)
  - [completion](#completion)
- [Shell Completion](#shell-completion)
- [Related Docs](#related-docs)

---

## Installation

Download the CLI binary from your BridgePort instance (click **CLI** in the top bar, or go to **Admin > About**). The modal picks the right build for your architecture; follow the on-screen steps for your OS. If you'd rather install from the terminal:

### macOS

```bash
# Replace arm64 with amd64 for Intel Macs
BIN=bridgeport-darwin-arm64
chmod +x ~/Downloads/$BIN

# Clear Gatekeeper's quarantine flag so the binary runs without the
# "cannot be opened because the developer cannot be verified" dialog
xattr -d com.apple.quarantine ~/Downloads/$BIN

sudo mv ~/Downloads/$BIN /usr/local/bin/bridgeport
```

If you skip the `xattr` step, macOS will block the binary on first run. Either run the command above, or right-click the binary in Finder and pick **Open** once -- macOS then whitelists it permanently.

### Linux

```bash
# Replace amd64 with arm64 for ARM machines
BIN=bridgeport-linux-amd64
chmod +x ~/Downloads/$BIN
sudo mv ~/Downloads/$BIN /usr/local/bin/bridgeport
```

If `/usr/local/bin` is not writable, use `~/.local/bin/bridgeport` and make sure it's on your `PATH`.

### Build from Source

```bash
cd cli && make build
sudo mv cli/bin/bridgeport /usr/local/bin/
```

---

## Global Flags

These flags are available on every command:

| Flag | Description |
|------|-------------|
| `--url <url>` | BridgePort server URL (overrides config file) |
| `--token <token>` | API token (overrides config file) |
| `--config <path>` | Config file path (default: `~/.bridgeport/config.yaml`) |
| `--no-color` | Disable colored output |
| `-v, --verbose` | Enable verbose output |

---

## Configuration

The CLI stores its configuration in `~/.bridgeport/config.yaml`. This file holds three values:

| Key | Description |
|-----|-------------|
| `url` | BridgePort server URL (e.g., `https://deploy.example.com`) |
| `token` | Authentication token (JWT or API token) |
| `defaultEnvironment` | Default environment name for commands that accept `--env` |

You can set these interactively with [`bridgeport config`](#config) or by logging in with [`bridgeport login`](#login).

---

## Authentication and Identity

### login

Authenticate with a BridgePort server. Credentials can be provided interactively or via flags.

```
bridgeport login [flags]
```

**Flags**

| Flag | Description |
|------|-------------|
| `--email <email>` | Email address (prompted if omitted) |
| `--password <password>` | Password (prompted securely if omitted) |
| `--save` | Save token to config file (default: `true`) |

**Examples**

```bash
# Interactive login (recommended)
bridgeport login --url https://deploy.example.com

# Non-interactive (for scripts)
bridgeport login --url https://deploy.example.com --email admin@example.com --password mypassword
```

**Output**

```
Logging in to https://deploy.example.com...
✓ Logged in as admin@example.com (admin)
Token saved to /home/user/.bridgeport/config.yaml
```

---

### whoami

Display information about the currently authenticated user.

```
bridgeport whoami
```

**Output**

```
User:  Admin
Email: admin@example.com
Role:  admin
URL:   https://deploy.example.com
```

---

### config

View or interactively configure CLI settings. Settings are saved to `~/.bridgeport/config.yaml`.

```
bridgeport config [flags]
```

**Flags**

| Flag | Description |
|------|-------------|
| `--show` | Display current configuration |
| `--path` | Print the config file path |

**Examples**

```bash
# Interactive configuration
bridgeport config

# Show current settings
bridgeport config --show

# Print config file location
bridgeport config --path
```

**Output (--show)**

```
Current configuration:

  Server URL:          https://deploy.example.com
  Token:               bp_a...xyz9
  Default Environment: (not set)

Config file: /home/user/.bridgeport/config.yaml
```

---

## Server Operations

### list

List all servers with their status, metrics, and service count.

```
bridgeport list [flags]
```

**Flags**

| Flag | Description |
|------|-------------|
| `--env <name>` | Filter by environment name |

**Examples**

```bash
# List all servers across environments
bridgeport list

# List servers in staging only
bridgeport list --env staging
```

**Output**

```
ENV        SERVER       IP           STATUS    CPU    MEM    SERVICES
staging    app-api      10.20.10.3   healthy   12%    45%    3
staging    app-worker   10.20.10.4   healthy   8%     32%    2
production app-api      10.30.10.3   healthy   34%    67%    3
```

---

### status

Show detailed information about a specific server, including network info, system metrics, and running services.

```
bridgeport status <environment> <server>
```

**Examples**

```bash
bridgeport status staging app-api
```

**Output**

```
Server:      app-api
Environment: staging

Network:
  Private IP: 10.20.10.3
  Public IP:  123.45.67.89

Metrics:
  CPU:    12.3%
  Memory: 1.8 GB / 4.0 GB (45.0%)
  Disk:   12.4 GB / 50.0 GB (24.8%)
  Uptime: 14d 6h 23m

Services:
NAME        STATUS    HEALTH     IMAGE                                        TAG
traefik     running   healthy    traefik                                      v3.0
app-api     running   healthy    registry.example.com/myapp                   v1.4.2
app-worker  running   healthy    registry.example.com/myapp                   v1.4.2
```

---

### ssh

Open an SSH session to a server, or run a one-off command.

```
bridgeport ssh <environment> <server> [-- command]
```

**Examples**

```bash
# Interactive shell
bridgeport ssh staging app-api

# Run a command
bridgeport ssh staging app-api -- ls -la /opt

# Check disk usage
bridgeport ssh staging app-api -- df -h
```

> [!NOTE]
> The SSH key is fetched from BridgePort for the server's environment. You do not need local SSH key configuration.

---

### exec

Execute a command inside a running Docker container, or open an interactive shell.

```
bridgeport exec <environment> <server> <service> [flags] [-- command]
```

**Flags**

| Flag | Description |
|------|-------------|
| `--shell <shell>` | Shell to use (default: `/bin/sh`) |

**Examples**

```bash
# Open a shell in the container
bridgeport exec staging app-api app-api

# Use bash instead of sh
bridgeport exec staging app-api app-api --shell bash

# Run a one-off command
bridgeport exec staging app-api app-api -- ls -la

# Check environment variables
bridgeport exec staging app-api app-api -- env | grep DATABASE
```

---

### logs

View container logs from a service running on a server.

```
bridgeport logs <environment> <server> <service> [flags]
```

**Flags**

| Flag | Description |
|------|-------------|
| `-f, --follow` | Stream logs in real-time |
| `--tail <n>` | Number of lines to show (default: `100`) |

**Examples**

```bash
# View recent logs
bridgeport logs staging app-api app-api

# Stream logs live
bridgeport logs staging app-api app-api -f

# Show last 20 lines
bridgeport logs staging app-api app-api --tail 20
```

---

### run

Run a predefined command from the service's type configuration (e.g., Django shell, database migrations).

```
bridgeport run <environment> <server> <service> [command] [flags]
```

**Flags**

| Flag | Description |
|------|-------------|
| `--list` | Show available commands for the service |

**Examples**

```bash
# List available commands
bridgeport run staging app-api app-api --list

# Run Django migrations
bridgeport run staging app-api app-api migrate

# Open Django shell
bridgeport run staging app-api app-api shell
```

**Output (--list)**

```
Available commands for app-api (Django):

  shell
    Interactive Django shell
    Command: python manage.py shell

  dbshell
    Database CLI shell
    Command: python manage.py dbshell

  migrate
    Apply database migrations
    Command: python manage.py migrate
```

> [!TIP]
> Predefined commands are configured per service type. Assign a service type (Django, Node.js, etc.) to your service in the BridgePort UI to enable predefined commands. See the [Plugin Reference](plugins.md) for creating custom service types.

---

## Resource Management

### services

List services across all servers, optionally filtered by environment or server.

```
bridgeport services [flags]
```

**Flags**

| Flag | Description |
|------|-------------|
| `--env <name>` | Filter by environment name |
| `--server <name>` | Filter by server name (requires `--env`) |

**Examples**

```bash
# List all services
bridgeport services

# Services in staging
bridgeport services --env staging

# Services on a specific server
bridgeport services --env staging --server app-api
```

**Output**

```
ENV        SERVER     SERVICE      STATUS    HEALTH     IMAGE                          TAG
staging    app-api    traefik      running   healthy    traefik                        v3.0
staging    app-api    app-api      running   healthy    registry.example.com/myapp     v1.4.2
staging    app-api    app-worker   running   healthy    registry.example.com/myapp     v1.4.2
```

---

### databases

List databases with their type, monitoring status, and backup configuration.

```
bridgeport databases [flags]
```

**Flags**

| Flag | Description |
|------|-------------|
| `--env <name>` | Filter by environment name |

**Examples**

```bash
bridgeport databases
bridgeport databases --env production
```

**Output**

```
ENV         NAME              TYPE       HOST               MONITORING    BACKUP
staging     app-postgres      postgres   10.20.10.3:5432    connected     local
production  app-postgres      postgres   10.30.10.3:5432    connected     spaces
```

---

### secrets

List secret names in an environment. Values are never displayed in the CLI.

```
bridgeport secrets <environment>
```

**Examples**

```bash
bridgeport secrets staging
```

**Output**

```
KEY                 DESCRIPTION              USAGE    PROTECTED
DATABASE_URL        PostgreSQL connection    3
DJANGO_SECRET_KEY   Application secret       1        yes
SMTP_PASSWORD       SMTP credentials         1        yes
```

---

### configs

List configuration files in an environment with their sync status.

```
bridgeport configs <environment>
```

**Examples**

```bash
bridgeport configs staging
```

**Output**

```
NAME              FILENAME              SYNC       SERVICES            UPDATED
gateway-compose   docker-compose.yml    synced     2                   2026-02-20 14:30:00
caddy-config      Caddyfile             pending    1 (1 pending)       2026-02-24 09:15:00
```

---

### images

List container images tracked in an environment with their current and latest tags.

```
bridgeport images <environment>
```

**Examples**

```bash
bridgeport images staging
```

**Output**

```
NAME            IMAGE                                    CURRENT     LATEST      AUTO-UPDATE
BIOS Backend    registry.example.com/bios-backend        v1.4.2      v1.4.3      yes
BIOS Frontend   registry.example.com/bios-frontend       v1.4.2      v1.4.2
```

> [!TIP]
> When the latest tag differs from the current tag, it is highlighted in yellow to indicate an update is available.

---

### registries

List container registries configured in an environment.

```
bridgeport registries <environment>
```

**Examples**

```bash
bridgeport registries staging
```

**Output**

```
NAME              TYPE             URL                                    IMAGES    DEFAULT
DigitalOcean      digitalocean     registry.digitalocean.com              4         yes
Docker Hub        dockerhub        registry-1.docker.io                   1
```

---

## Monitoring and Operations

### health

Display health check logs for an environment with optional filtering.

```
bridgeport health <environment> [flags]
```

**Flags**

| Flag | Description |
|------|-------------|
| `--status <status>` | Filter by status (`success`, `failure`, `timeout`) |
| `--type <type>` | Filter by resource type (`server`, `service`, `container`) |
| `--hours <n>` | Time range in hours (default: `24`) |
| `--limit <n>` | Number of logs to show (default: `50`) |

**Examples**

```bash
# All health logs in the last 24 hours
bridgeport health staging

# Only failures
bridgeport health staging --status failure

# Server checks in the last 48 hours
bridgeport health staging --type server --hours 48
```

**Output**

```
Showing 12 of 248 logs (last 24 hours)

TIME                 TYPE      RESOURCE     CHECK              STATUS     DURATION
2026-02-25 14:30:00  service   app-api      url                success    45ms
2026-02-25 14:30:00  server    app-api      ssh                success    120ms
2026-02-25 14:25:00  service   app-worker   container_health   failure    -
```

---

### backups

List recent backups for a specific database.

```
bridgeport backups <environment> <database> [flags]
```

**Flags**

| Flag | Description |
|------|-------------|
| `--limit <n>` | Number of backups to show (default: `20`) |

**Examples**

```bash
bridgeport backups staging app-postgres
bridgeport backups production app-postgres --limit 5
```

**Output**

```
Database: app-postgres (postgres)

STATUS      TYPE        FILENAME                           SIZE       DURATION    CREATED
completed   scheduled   app-postgres-20260225-020000.sql   45.2 MB    12s         2026-02-25 02:00:00
completed   scheduled   app-postgres-20260224-020000.sql   44.8 MB    11s         2026-02-24 02:00:00
completed   manual      app-postgres-20260223-143000.sql   44.5 MB    13s         2026-02-23 14:30:00
```

---

### audit

View audit logs with optional filtering by environment, action, or resource type.

```
bridgeport audit [flags]
```

**Flags**

| Flag | Description |
|------|-------------|
| `--env <name>` | Filter by environment name |
| `--action <action>` | Filter by action (`deploy`, `create`, `update`, `delete`, etc.) |
| `--resource-type <type>` | Filter by resource type (`service`, `server`, `database`, etc.) |
| `--limit <n>` | Number of logs to show (default: `50`) |

**Examples**

```bash
# Recent audit logs
bridgeport audit

# Deployment actions in staging
bridgeport audit --env staging --action deploy

# All database-related events
bridgeport audit --resource-type database --limit 100
```

**Output**

```
Showing 15 of 342 logs

TIME                 USER                ACTION    TYPE       RESOURCE       STATUS
2026-02-25 14:25:00  admin@example.com   deploy    service    app-api        ok
2026-02-25 14:20:00  admin@example.com   update    secret     DATABASE_URL   ok
2026-02-25 13:00:00  ci@example.com      deploy    service    app-worker     ok
```

---

## Utilities

### version

Print the CLI version.

```
bridgeport version
```

**Output**

```
bridgeport version 20260225-a1b2c3d
```

---

### completion

Generate shell completion scripts for tab-completion of commands, environments, servers, and services.

```
bridgeport completion <shell>
```

**Supported shells**: `bash`, `zsh`, `fish`, `powershell`

**Installation**

```bash
# Bash (Linux)
bridgeport completion bash > /etc/bash_completion.d/bridgeport

# Bash (macOS with Homebrew)
bridgeport completion bash > $(brew --prefix)/etc/bash_completion.d/bridgeport

# Zsh
bridgeport completion zsh > "${fpath[1]}/_bridgeport"

# Fish
bridgeport completion fish > ~/.config/fish/completions/bridgeport.fish

# PowerShell
bridgeport completion powershell | Out-String | Invoke-Expression
```

> [!TIP]
> After installing completions, restart your shell or run `compinit` (zsh) to activate them. The CLI provides dynamic completions that query the BridgePort API for environment, server, and service names.

---

## Shell Completion

The CLI supports dynamic shell completions powered by the BridgePort API. When you press Tab, the CLI queries your BridgePort instance to suggest:

- **Environment names** for the first positional argument of `ssh`, `status`, `exec`, `logs`, `run`, `health`, `secrets`, `configs`, `registries`, `images`, and `backups`
- **Server names** for the second positional argument (filtered by the selected environment)
- **Service names** for the third positional argument (filtered by the selected server)

This requires an active authentication token in your config file. If the API is unreachable, completions silently fall back to no suggestions.

---

## Related Docs

- [API Reference](api.md) -- REST API authentication and endpoints
- [Agent Reference](agent.md) -- Monitoring agent installation and configuration
- [Plugin Reference](plugins.md) -- Service type and database type plugins (for `run` commands)
