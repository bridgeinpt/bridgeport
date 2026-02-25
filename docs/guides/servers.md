# Servers

Servers represent the physical or virtual machines where your Docker containers run -- BridgePort connects to them via SSH or Docker socket to deploy, monitor, and manage services.

## Table of Contents

1. [Quick Start](#quick-start)
2. [How It Works](#how-it-works)
3. [Step-by-Step Guide](#step-by-step-guide)
   - [Adding a Server](#adding-a-server)
   - [SSH Key Configuration](#ssh-key-configuration)
   - [Docker Mode Setup](#docker-mode-setup)
   - [Server Health Monitoring](#server-health-monitoring)
   - [Metrics Mode Selection](#metrics-mode-selection)
   - [Container Discovery](#container-discovery)
   - [Creating Services Manually](#creating-services-manually)
4. [Host Server Mode](#host-server-mode)
5. [Configuration Options](#configuration-options)
6. [Troubleshooting](#troubleshooting)
7. [Related](#related)

---

## Quick Start

Get a server managed by BridgePort in 3 steps:

1. **Configure SSH key** for your environment (one-time setup):
   - Go to **Configuration > Environment Settings** and upload your SSH private key.

2. **Add a server**:
   - Go to **Operations > Servers** and click **Add Server**.
   - Enter a name, hostname (private IP or FQDN), and optional tags.

3. **Discover containers**:
   - On the server detail page, click **Discover** to auto-import all running Docker containers as services.

---

## How It Works

BridgePort manages servers through two connection modes. Each server belongs to one environment and inherits that environment's SSH key.

```mermaid
flowchart TD
    A[BridgePort] -->|SSH connection| B[Remote Server]
    A -->|Docker socket| C[Host Machine]
    B --> D[Docker Daemon]
    C --> E[Docker Daemon]
    D --> F[Containers]
    E --> G[Containers]

    style A fill:#4f46e5,color:#fff
    style B fill:#1e293b,color:#fff
    style C fill:#1e293b,color:#fff
```

**SSH mode** (default): BridgePort connects to the server over SSH using the environment's private key, then runs Docker commands remotely. This is the standard mode for remote servers.

**Socket mode**: BridgePort connects directly to the Docker daemon via the local Docker socket (`/var/run/docker.sock`). This is for the host machine when BridgePort itself runs as a Docker container.

---

## Step-by-Step Guide

### Adding a Server

**UI:**

1. Navigate to **Operations > Servers**.
2. Click **Add Server**.
3. Fill in the form:
   - **Name** -- descriptive identifier (e.g., `app-api-staging`, `web-prod-1`)
   - **Hostname** -- private IP or FQDN (e.g., `10.20.10.3`, `server.example.com`)
   - **Public IP** -- optional reserved/public IP for display purposes
   - **Tags** -- optional labels for organization (e.g., `web`, `api`, `database`)
4. Click **Create**.

**API:**
```http
POST /api/environments/:envId/servers
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "app-api-staging",
  "hostname": "10.20.10.3",
  "publicIp": "203.0.113.50",
  "tags": ["api", "staging"]
}
```

**Response (200):**
```json
{
  "server": {
    "id": "clxyz...",
    "name": "app-api-staging",
    "hostname": "10.20.10.3",
    "publicIp": "203.0.113.50",
    "tags": "[\"api\",\"staging\"]",
    "status": "unknown",
    "dockerMode": "ssh",
    "metricsMode": "disabled",
    "environmentId": "clenv..."
  }
}
```

Server names must be unique within an environment. If a name is already taken, the server returns `409 Conflict`.

### SSH Key Configuration

Every environment has one SSH private key that all servers in that environment share. The key is encrypted at rest using XChaCha20-Poly1305.

**Step 1: Generate or locate your SSH key pair.**

```bash
# Generate a new key pair (if you don't have one)
ssh-keygen -t ed25519 -C "bridgeport-staging" -f ~/.ssh/bridgeport_staging
```

**Step 2: Add the public key to your servers.**

```bash
# Copy public key to each server
ssh-copy-id -i ~/.ssh/bridgeport_staging.pub root@10.20.10.3
```

**Step 3: Upload the private key to BridgePort.**

Navigate to **Configuration > Environment Settings > General** and paste your private key, or use the API:

```http
PUT /api/environments/:envId/ssh
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "sshPrivateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----",
  "sshUser": "root"
}
```

**Step 4: Verify the connection.**

On the server detail page, click the **Health Check** button. A successful check confirms SSH connectivity:

```json
{
  "status": "healthy",
  "container": {
    "state": "running",
    "running": true
  }
}
```

> [!NOTE]
> The SSH user defaults to `root` but can be changed per environment in General Settings. The user must have permission to run `docker` commands.

> [!WARNING]
> Deleting an SSH key (`DELETE /api/environments/:envId/ssh`) removes connectivity to **all servers** in that environment. Health checks, deployments, and container discovery will fail until a new key is configured.

### Docker Mode Setup

Each server has a `dockerMode` that determines how BridgePort communicates with Docker:

| Mode | How it connects | When to use |
|------|----------------|-------------|
| `ssh` (default) | SSH into server, run `docker` commands | Remote servers |
| `socket` | `/var/run/docker.sock` directly | Host machine (BridgePort is a container) |

**Changing Docker mode:**

```http
PATCH /api/servers/:id
Authorization: Bearer <token>
Content-Type: application/json

{
  "dockerMode": "socket"
}
```

> [!TIP]
> If BridgePort runs as a Docker container on the same machine it manages, use `socket` mode for that server. This avoids SSH overhead and does not require an SSH key.

### Server Health Monitoring

Health checks verify that BridgePort can connect to the server and that Docker is responsive.

**Manual health check:**

Click the health check icon on the server card, or:

```http
POST /api/servers/:id/health
Authorization: Bearer <token>
```

This connects via SSH (or socket), runs Docker commands to verify the daemon is responsive, and updates the server's `status` to `healthy` or `unhealthy`.

**Automated health checks:**

When monitoring is enabled for the environment, BridgePort runs server health checks on a configurable interval (default: 60 seconds). Configure the interval in **Environment Settings > Monitoring > Server Health Interval**.

### Metrics Mode Selection

Each server can collect system metrics in one of three modes. Use this decision tree to pick the right one:

```mermaid
flowchart TD
    A{Need server metrics?} -->|No| B[disabled]
    A -->|Yes| C{BridgePort can SSH<br>into the server?}
    C -->|Yes| D{Need container-level<br>detail + processes?}
    C -->|No| B
    D -->|Basic is fine| E[ssh]
    D -->|Yes, I want everything| F[agent]

    style B fill:#374151,color:#fff
    style E fill:#2563eb,color:#fff
    style F fill:#059669,color:#fff
```

| Mode | Metrics collected | How | Requirements |
|------|-------------------|-----|--------------|
| **disabled** | None | -- | -- |
| **ssh** | CPU, memory, disk, load, swap, TCP, FDs | BridgePort polls via SSH on a schedule | SSH key configured |
| **agent** | SSH metrics + container stats, top processes, TCP/cert checks | Agent binary pushes to BridgePort | Agent auto-deployed via SSH |

**Changing metrics mode:**

```http
PATCH /api/servers/:id/metrics-mode
Authorization: Bearer <token>
Content-Type: application/json

{
  "mode": "agent"
}
```

When switching to `agent` mode, BridgePort automatically deploys the monitoring agent binary to the server via SSH. When switching away from `agent`, the agent is removed.

> [!NOTE]
> Agent deployment requires SSH access. The agent runs as a background service on the server and pushes metrics to BridgePort at a regular interval. See [Agent Reference](../reference/agent.md) for details.

### Container Discovery

Discovery scans a server's Docker daemon and automatically creates service records for every running container.

**Manual discovery:**

Click **Discover** on the server detail page, or:

```http
POST /api/servers/:id/discover
Authorization: Bearer <token>
```

**Response:**
```json
{
  "services": [
    {
      "id": "clsvc1...",
      "name": "app-api",
      "containerName": "app-api",
      "imageTag": "v2.1.0",
      "status": "running"
    }
  ],
  "missing": ["old-service"]
}
```

The `services` array contains newly discovered or updated services. The `missing` array lists previously tracked services whose containers were not found during this scan (their `discoveryStatus` is set to `missing`).

**Automated discovery:**

When monitoring is enabled, discovery runs on a configurable interval (default: 5 minutes). Adjust it in **Environment Settings > Monitoring > Discovery Interval**.

> [!TIP]
> Discovery creates a `ContainerImage` record for each unique image it finds. If a matching image already exists in the environment, the service is linked to it automatically.

### Creating Services Manually

You can create services before the container exists on the server. This is useful when preparing a deployment ahead of time.

1. Navigate to the server detail page.
2. Click **Create Service**.
3. Fill in:
   - **Name** -- service identifier
   - **Container Name** -- the Docker container name
   - **Container Image** -- select an existing image or create one
   - **Image Tag** -- tag to deploy (default: `latest`)
   - **Compose Path** -- optional path to `docker-compose.yml` on the server
4. Click **Create**.

See [Services](services.md) for the full guide on managing services after creation.

---

## Host Server Mode

When BridgePort runs as a Docker container, it can manage the host machine directly. BridgePort detects the Docker gateway IP and can register the host as a special server with `serverType: "host"` and `dockerMode: "socket"`.

**Check host info:**
```http
GET /api/environments/:envId/host-info
Authorization: Bearer <token>
```

**Register the host:**
```http
POST /api/environments/:envId/servers/register-host
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "host"
}
```

Host servers connect via Docker socket and do not require SSH keys. They support all the same operations as remote servers (discovery, deployments, health checks).

---

## Configuration Options

### Server-Level Settings

| Setting | API Field | Options | Default | Description |
|---------|-----------|---------|---------|-------------|
| Docker Mode | `dockerMode` | `ssh`, `socket` | `ssh` | How to connect to Docker daemon |
| Metrics Mode | `metricsMode` | `disabled`, `ssh`, `agent` | `disabled` | How server metrics are collected |
| Server Type | `serverType` | `remote`, `host` | `remote` | Whether server is remote or the Docker host |

### Environment-Level Settings (Affect All Servers)

| Setting | Module | Default | Description |
|---------|--------|---------|-------------|
| SSH User | General | `root` | SSH username for all servers in this environment |
| Default Docker Mode | Operations | `ssh` | Docker mode applied to new servers |
| Default Metrics Mode | Operations | `disabled` | Metrics mode applied to new servers |
| Server Health Interval | Monitoring | `60000ms` | How often to check server health |
| Discovery Interval | Monitoring | `300000ms` | How often to scan for containers |
| Metrics Interval | Monitoring | `300000ms` | How often to collect SSH metrics |

---

## Troubleshooting

**Health check fails with "SSH connection refused"**
- Verify the environment has an SSH key configured: `GET /api/environments/:envId/ssh`
- Confirm the SSH user has access: `ssh -i key root@hostname`
- Check the server's firewall allows port 22

**Health check fails with "Docker daemon not responding"**
- Verify Docker is running on the server: `systemctl status docker`
- Confirm the SSH user can run Docker: `docker ps`
- For socket mode, ensure BridgePort's container has the Docker socket mounted

**Container discovery returns empty results**
- Verify Docker is running and has containers: `docker ps` on the server
- Check that the SSH user has permission to list containers
- For socket mode, ensure `/var/run/docker.sock` is mounted in BridgePort's container

**"Server already exists" (409)**
Server names must be unique within an environment. Choose a different name or delete the existing server first.

**Agent deploy fails**
- SSH must be working (test with a health check first)
- The server needs internet access to download the agent binary, or BridgePort serves it
- Check agent deploy logs: **Monitoring > Agents & SSH**

**Metrics not appearing after enabling SSH mode**
- Confirm the SSH user can run system commands (`uptime`, `free`, `df`)
- Check the metrics interval in Environment Settings > Monitoring
- Verify monitoring is enabled for the environment (master toggle)

---

## Related

- [Services](services.md) -- managing Docker containers on servers
- [Environments](environments.md) -- SSH key and per-module settings
- [Monitoring Quick Start](monitoring.md) -- setting up metrics collection
- [Agent Reference](../reference/agent.md) -- agent installation and configuration
- [Environment Settings Reference](../reference/environment-settings.md) -- all server-related settings
