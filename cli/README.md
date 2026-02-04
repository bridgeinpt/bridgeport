# BridgePort CLI

Command-line interface for managing BridgePort infrastructure.

## Installation

### From BridgePort UI (Recommended)

1. Open your BridgePort instance and go to the **About** page
2. Download the appropriate binary for your platform:
   - **macOS (Intel)**: `bridgeport-darwin-amd64`
   - **macOS (Apple Silicon)**: `bridgeport-darwin-arm64`
   - **Linux (x64)**: `bridgeport-linux-amd64`
   - **Linux (ARM64)**: `bridgeport-linux-arm64`
3. Make it executable and move to your PATH:

```bash
chmod +x bridgeport-*
sudo mv bridgeport-* /usr/local/bin/bridgeport
```

### From Source

```bash
cd bridgeport/cli
make build
sudo mv bridgeport /usr/local/bin/
```

### Cross-Platform Builds

```bash
make build-all
# Outputs:
#   dist/bridgeport-darwin-amd64
#   dist/bridgeport-darwin-arm64
#   dist/bridgeport-linux-amd64
#   dist/bridgeport-linux-arm64
```

## Quick Start

```bash
# Configure and authenticate
bridgeport login --url https://deploy.example.com

# List all servers
bridgeport list

# SSH into a server
bridgeport ssh staging app-api

# View container logs
bridgeport logs staging app-api app-api

# Execute command in container
bridgeport exec staging app-api app-api -- python manage.py shell
```

## Commands

### Authentication

```bash
bridgeport login [--url <url>]
```

Interactive login with email and password. Saves JWT token to `~/.bridgeport/config.yaml`.

### Server Management

```bash
# List all servers with metrics
bridgeport list

# Show detailed server status
bridgeport status <environment> <server>
```

The `list` command displays:
- Environment and server name
- Public/private IP addresses
- Health status (colored)
- CPU and memory usage
- Service count

### SSH Access

```bash
# Interactive shell
bridgeport ssh <environment> <server>

# Run a command
bridgeport ssh <environment> <server> -- <command>
```

Examples:
```bash
bridgeport ssh staging gateway
bridgeport ssh production app-api-1 -- docker ps
bridgeport ssh staging keycloak -- cat /opt/keycloak/data/log/keycloak.log
```

### Container Operations

```bash
# Execute command in container (interactive)
bridgeport exec <environment> <server> <service> [-- <command>]

# View container logs
bridgeport logs <environment> <server> <service> [-f] [--tail <n>]

# Run predefined service command
bridgeport run <environment> <server> <service> <command>
```

Examples:
```bash
# Django shell
bridgeport exec staging app-api app-api -- python manage.py shell

# Follow logs
bridgeport logs staging app-api app-api -f --tail 100

# Run predefined migrate command (if configured in service type)
bridgeport run staging app-api app-api migrate
```

### Shell Completion

```bash
# Bash
bridgeport completion bash > /etc/bash_completion.d/bridgeport

# Zsh
bridgeport completion zsh > "${fpath[1]}/_bridgeport"

# Fish
bridgeport completion fish > ~/.config/fish/completions/bridgeport.fish
```

Completions are context-aware - environments, servers, and services are fetched from the API.

### Version

```bash
bridgeport version
```

The CLI version is derived from git at build time (format: `YYYYMMDD-{7-char SHA}`) and only changes when the `cli/` directory is modified.

## Configuration

Configuration is stored at `~/.bridgeport/config.yaml`:

```yaml
url: https://deploy.example.com
token: eyJhbGciOiJIUzI1NiIs...
default_environment: staging
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `BRIDGEPORT_URL` | Server URL (overrides config) |
| `BRIDGEPORT_TOKEN` | API token (overrides config) |

### Global Flags

| Flag | Description |
|------|-------------|
| `--url` | BridgePort server URL |
| `--token` | API token (overrides config) |
| `--config` | Config file path (default: `~/.bridgeport/config.yaml`) |
| `--no-color` | Disable colored output |
| `-v, --verbose` | Verbose output |

## Development

```bash
# Install dependencies
make deps

# Build
make build

# Run tests
make test

# Lint
make lint

# Generate completions
make completions
```

## Architecture

```
cli/
├── main.go                 # Entry point
├── Makefile                # Build automation
├── cmd/                    # Command implementations
│   ├── root.go             # Root command, global flags, auth setup
│   ├── login.go            # Authentication
│   ├── list.go             # List servers with metrics
│   ├── status.go           # Detailed server info
│   ├── ssh.go              # SSH into servers
│   ├── exec.go             # Docker exec over SSH
│   ├── logs.go             # Docker logs over SSH
│   ├── run.go              # Run predefined commands
│   ├── version.go          # Version display
│   └── completion.go       # Shell completions
└── internal/
    ├── api/                # API client
    │   ├── client.go       # HTTP client wrapper
    │   ├── auth.go         # Login endpoints
    │   ├── environments.go # Environment/server models
    │   └── services.go     # Service models
    ├── config/             # Configuration management
    │   └── config.go       # YAML config handling
    ├── ssh/                # SSH connectivity
    │   └── connect.go      # SSH session management
    ├── docker/             # Docker operations
    │   └── exec.go         # Docker exec/logs via SSH
    └── output/             # Terminal formatting
        └── table.go        # Colored tables and formatting
```
