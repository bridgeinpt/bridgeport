# Servers

Servers represent the physical or virtual machines where your Docker containers run. BridgePort connects to servers via SSH (or Docker socket for the local host) to manage containers, collect metrics, and sync configuration files.

## Adding a Server

1. Navigate to **Servers** in the sidebar
2. Click **Add Server**
3. Enter:
   - **Name** — A friendly name (e.g., `app-api-1`)
   - **Hostname** — The IP address or hostname BridgePort will use to connect via SSH
   - **Public IP** — Optional public IP for display purposes
   - **Tags** — Optional labels for organization

Before adding servers, ensure your environment has an SSH key configured (see [Environments](environments.md)).

## Docker Modes

Each server uses one of two Docker modes:

### SSH Mode (Default)

BridgePort connects to the server via SSH and runs Docker commands remotely. This is the standard mode for remote servers.

Requirements:
- SSH access from BridgePort to the server
- Docker installed on the server
- The SSH user must have Docker permissions

### Socket Mode

For the host machine where BridgePort runs, you can mount the Docker socket directly. This avoids SSH overhead for local container management.

To enable socket mode, mount the Docker socket in your `docker-compose.yml`:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
group_add:
  - "999"  # Docker group ID
```

When the socket is mounted, BridgePort automatically creates a "localhost" server using socket mode.

## Host Server Detection

When running inside Docker, BridgePort can detect the host machine:

- **Docker socket**: If mounted, a "localhost" server is auto-created on startup
- **SSH via gateway**: If SSH is reachable through the Docker gateway IP (`172.17.0.1`), a detection banner appears on the Servers page

Click **Add Host Server** on the banner to register the host.

## Container Discovery

BridgePort can automatically discover running Docker containers on a server:

1. Go to the server's detail page
2. Click **Discover**

BridgePort will SSH into the server (or use the Docker socket), list running containers, and create service entries for any containers not already registered.

## Server Health Checks

Health checks verify that BridgePort can reach the server and Docker is responding:

- **Automatic**: The scheduler checks all servers at the configured interval
- **Manual**: Click the health check button on a server to run an immediate check

Health checks update the server's status indicator (healthy/unhealthy/unknown).

## Importing from Terraform

If you manage infrastructure with Terraform, you can import servers in bulk:

```bash
POST /api/environments/:envId/servers/import-terraform
```

Provide a JSON array of servers with their names, IPs, tags, and optionally pre-defined services. See [API Reference](api-reference.md) for details.

## Metrics Mode

Each server can collect metrics in one of three modes:

| Mode | Description |
|------|-------------|
| **Disabled** | No metrics collection |
| **SSH** | BridgePort collects metrics by running commands over SSH |
| **Agent** | A lightweight Go agent on the server pushes metrics to BridgePort |

Configure the metrics mode on the server's detail page. For agent setup, see [Monitoring](monitoring.md).

## Server Tags

Tags are free-form labels you can assign to servers for organization. They appear as badges on the server list and can help you filter and identify servers.

## Deleting a Server

To delete a server, first remove all its services, then delete the server from its detail page. Deletion is permanent and audit-logged.
