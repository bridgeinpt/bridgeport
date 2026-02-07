# CLI

The BridgePort CLI provides terminal access to your infrastructure for SSH, container logs, command execution, and server management.

## Installation

### From BridgePort UI (Recommended)

1. Open BridgePort and go to the **About** page
2. Download the binary for your platform:
   - macOS (Intel): `bridgeport-darwin-amd64`
   - macOS (Apple Silicon): `bridgeport-darwin-arm64`
   - Linux (x64): `bridgeport-linux-amd64`
   - Linux (ARM64): `bridgeport-linux-arm64`
3. Make executable and move to your PATH:

```bash
chmod +x bridgeport-*
sudo mv bridgeport-* /usr/local/bin/bridgeport
```

### From Source

```bash
cd cli
make build
sudo mv bridgeport /usr/local/bin/
```

## Authentication

Log in to your BridgePort instance:

```bash
bridgeport login --url https://deploy.example.com
```

This prompts for your email and password, then saves the JWT token to `~/.bridgeport/config.yaml`.

## Commands

### List Servers

```bash
bridgeport list
```

Shows all servers across all environments with:
- Environment and server name
- IP addresses
- Health status (color-coded)
- CPU and memory usage
- Service count

### Server Status

```bash
bridgeport status <environment> <server>
```

Shows detailed information for a specific server, including all services and their statuses.

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

### Container Exec

Execute commands inside a Docker container:

```bash
# Interactive shell
bridgeport exec <environment> <server> <service>

# Run a specific command
bridgeport exec <environment> <server> <service> -- <command>
```

Examples:
```bash
bridgeport exec staging app-api app-api -- python manage.py shell
bridgeport exec production db-server postgres -- psql -U postgres
```

### Container Logs

View Docker container logs:

```bash
bridgeport logs <environment> <server> <service> [-f] [--tail <n>]
```

Options:
- `-f` — Follow logs in real-time
- `--tail <n>` — Show last N lines (default: 100)

Examples:
```bash
bridgeport logs staging app-api app-api
bridgeport logs staging app-api app-api -f --tail 50
```

### Run Predefined Commands

Run a predefined command from the service's service type:

```bash
bridgeport run <environment> <server> <service> <command>
```

Examples:
```bash
# Run Django migrations
bridgeport run staging app-api app-api migrate

# Open Django shell
bridgeport run staging app-api app-api shell

# Collect static files
bridgeport run staging app-api app-api collectstatic
```

Available commands depend on the service type assigned to the service.

### Version

```bash
bridgeport version
```

### Shell Completions

Generate shell completions for tab-completion of environments, servers, and services:

```bash
# Bash
bridgeport completion bash > /etc/bash_completion.d/bridgeport

# Zsh
bridgeport completion zsh > "${fpath[1]}/_bridgeport"

# Fish
bridgeport completion fish > ~/.config/fish/completions/bridgeport.fish
```

Completions are context-aware — they query the BridgePort API to suggest environment names, server names, and service names.

## Configuration

### Config File

Stored at `~/.bridgeport/config.yaml`:

```yaml
url: https://deploy.example.com
token: eyJhbGciOiJIUzI1NiIs...
default_environment: staging
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `BRIDGEPORT_URL` | Server URL (overrides config file) |
| `BRIDGEPORT_TOKEN` | API token (overrides config file) |

### Global Flags

| Flag | Description |
|------|-------------|
| `--url` | BridgePort server URL |
| `--token` | API token |
| `--config` | Config file path (default: `~/.bridgeport/config.yaml`) |
| `--no-color` | Disable colored output |
| `-v, --verbose` | Verbose output |
