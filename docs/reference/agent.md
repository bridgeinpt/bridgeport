# Agent Reference

The BRIDGEPORT agent is a lightweight Go binary that runs on your servers, pushing system metrics, container stats, health check results, and process snapshots to BRIDGEPORT at regular intervals.

## Table of Contents

- [What the Agent Does](#what-the-agent-does)
- [Installation](#installation)
  - [Auto-Deploy via UI (Recommended)](#auto-deploy-via-ui-recommended)
  - [Manual Installation](#manual-installation)
  - [Building from Source](#building-from-source)
- [Configuration](#configuration)
  - [Command-Line Flags](#command-line-flags)
  - [Environment Variables](#environment-variables)
  - [Running as a systemd Service](#running-as-a-systemd-service)
- [How It Works](#how-it-works)
  - [Metrics Collection Loop](#metrics-collection-loop)
  - [Configuration Fetching](#configuration-fetching)
  - [Internal Networking](#internal-networking)
- [Collected Metrics](#collected-metrics)
  - [System Metrics](#system-metrics)
  - [Container Metrics](#container-metrics)
  - [Health Checks](#health-checks)
  - [TCP and Certificate Checks](#tcp-and-certificate-checks)
  - [Container Discovery](#container-discovery)
  - [Process Snapshots](#process-snapshots)
- [Upgrade Detection](#upgrade-detection)
- [Troubleshooting](#troubleshooting)
- [Related Docs](#related-docs)

---

## What the Agent Does

The agent replaces BRIDGEPORT's default SSH-based metrics collection with a **push model**. Instead of BRIDGEPORT SSHing into each server to gather metrics, the agent runs locally and pushes data to BRIDGEPORT on a configurable interval (default: 30 seconds).

The agent collects:

- **System metrics** -- CPU, memory, swap, disk, load averages, uptime, file descriptors, TCP connections
- **Container metrics** -- Per-container CPU, memory, network I/O, block I/O, restart count, state
- **Health checks** -- HTTP health check requests against services with configured health URLs
- **TCP connectivity checks** -- Port reachability tests for configured services
- **TLS certificate checks** -- Certificate expiry monitoring for HTTPS endpoints
- **Container discovery** -- Full container list for automatic service detection
- **Process snapshots** -- Top processes by CPU and memory usage

Which metrics are collected is controlled by per-environment monitoring settings in BRIDGEPORT. The agent fetches its configuration from BRIDGEPORT every 60 seconds.

---

## Installation

### Auto-Deploy via UI (Recommended)

The simplest way to install the agent:

1. Go to the server detail page in BRIDGEPORT
2. Set **Metrics Mode** to "Agent"
3. Click **Deploy Agent**

BRIDGEPORT will SSH into the server, upload the agent binary, create a systemd service, and start it. The agent token is generated automatically.

### Manual Installation

1. Download the agent binary from **Admin > About** in BRIDGEPORT, or copy it from the BRIDGEPORT container:

   ```bash
   # From Admin > About page, download the binary for your architecture
   # Or extract from the Docker image:
   docker cp bridgeport:/app/bridgeport-agent-linux-amd64 ./bridgeport-agent
   ```

2. Copy the binary to your server:

   ```bash
   scp bridgeport-agent user@server:/usr/local/bin/bridgeport-agent
   chmod +x /usr/local/bin/bridgeport-agent
   ```

3. Get the agent token from BRIDGEPORT:
   - Go to the server detail page
   - Set Metrics Mode to "Agent"
   - Copy the displayed agent token

4. Run the agent:

   ```bash
   /usr/local/bin/bridgeport-agent \
     -server https://deploy.example.com \
     -token YOUR_AGENT_TOKEN \
     -interval 30s
   ```

### Building from Source

```bash
cd bridgeport-agent

# Build for your current platform
make build

# Build for Linux (amd64 + arm64)
make build-linux
```

This produces `bridgeport-agent-linux-amd64` and `bridgeport-agent-linux-arm64` binaries.

---

## Configuration

### Command-Line Flags

| Flag | Default | Description |
|------|---------|-------------|
| `-server` | (required) | BRIDGEPORT server URL (e.g., `https://deploy.example.com`) |
| `-token` | (required) | Agent authentication token (from server settings in BRIDGEPORT) |
| `-interval` | `30s` | How often to collect and send metrics |

### Environment Variables

Flags can also be set via environment variables (used as fallback if flags are not provided):

| Variable | Equivalent Flag |
|----------|----------------|
| `BRIDGEPORT_SERVER` | `-server` |
| `BRIDGEPORT_TOKEN` | `-token` |

### Running as a systemd Service

Create `/etc/systemd/system/bridgeport-agent.service`:

```ini
[Unit]
Description=BRIDGEPORT Monitoring Agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/bridgeport-agent \
  -server https://deploy.example.com \
  -token YOUR_AGENT_TOKEN \
  -interval 30s
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bridgeport-agent
```

Check status:

```bash
sudo systemctl status bridgeport-agent
sudo journalctl -u bridgeport-agent -f
```

---

## How It Works

### Metrics Collection Loop

```
Agent starts
  |
  +--> Collect and send immediately
  |
  +--> Every <interval> seconds:
         1. Fetch metrics config from BRIDGEPORT (cached, refreshed every 60s)
         2. Perform health checks on configured services
         3. Perform TCP/cert checks (if enabled)
         4. Collect system metrics (CPU, memory, disk, etc.)
         5. Collect Docker container metrics
         6. Collect container list (for discovery)
         7. Collect top processes (if enabled)
         8. POST all data to /api/metrics/ingest
```

### Configuration Fetching

The agent fetches its configuration from `GET /api/agent/config` every 60 seconds. This configuration includes:

- **Server ID and name** -- Which server this agent belongs to
- **Service list** -- Services with health check URLs, TCP checks, and certificate checks
- **Metrics config** -- Which metric categories to collect (controlled by environment monitoring settings)

This means you can enable/disable specific metrics in the BRIDGEPORT UI, and the agent will pick up changes within 60 seconds without a restart.

### Internal Networking

The agent needs to reach BRIDGEPORT's API. In typical deployments:

- If BRIDGEPORT and the agent are on the same private network, use the internal IP (e.g., `http://10.30.10.5:3000`)
- If they are on different networks, use the public URL (e.g., `https://deploy.example.com`)

You can configure a separate agent callback URL in **Admin > System Settings > Agent Callback URL** to override the public URL for agent-to-server communication.

The agent also needs access to the Docker socket (`/var/run/docker.sock`) to collect container metrics and discover containers. When deployed via systemd, the service runs as root by default, which has Docker socket access.

---

## Collected Metrics

### System Metrics

All system metrics are collected from `/proc` on Linux. Each can be individually enabled/disabled via environment monitoring settings.

| Metric | Fields | Toggle |
|--------|--------|--------|
| CPU | `cpuPercent` | `collectCpu` |
| Memory | `memoryUsedMb`, `memoryTotalMb` | `collectMemory` |
| Swap | `swapUsedMb`, `swapTotalMb` | `collectSwap` |
| Disk | `diskUsedGb`, `diskTotalGb` | `collectDisk` |
| Load | `loadAvg1`, `loadAvg5`, `loadAvg15` | `collectLoad` |
| File Descriptors | `openFds`, `maxFds` | `collectFds` |
| TCP Connections | `tcpEstablished`, `tcpListen`, `tcpTimeWait`, `tcpCloseWait`, `tcpTotal` | `collectTcp` |
| Uptime | `uptime` (seconds) | Always collected |

### Container Metrics

Per-container metrics are collected via the Docker API:

| Field | Description |
|-------|-------------|
| `containerName` | Docker container name |
| `cpuPercent` | Container CPU usage percentage |
| `memoryUsedMb` | Container memory usage (MB) |
| `memoryLimitMb` | Container memory limit (MB) |
| `networkRxMb` | Network received (MB) |
| `networkTxMb` | Network transmitted (MB) |
| `blockReadMb` | Block device reads (MB) |
| `blockWriteMb` | Block device writes (MB) |
| `restartCount` | Container restart count |
| `state` | Container state (`running`, `stopped`, `exited`, etc.) |
| `health` | Docker health status (`healthy`, `unhealthy`, `none`) |

### Health Checks

For services with a configured `healthCheckUrl`, the agent performs HTTP GET requests and reports:

| Field | Description |
|-------|-------------|
| `containerName` | Service container name |
| `healthCheckUrl` | URL that was checked |
| `success` | `true` if status code is 2xx or 3xx |
| `statusCode` | HTTP status code |
| `durationMs` | Response time in milliseconds |
| `checkedAt` | ISO 8601 timestamp |
| `error` | Error message (if request failed) |

### TCP and Certificate Checks

**TCP checks** verify port reachability with a 5-second timeout:

| Field | Description |
|-------|-------------|
| `host`, `port` | Target endpoint |
| `success` | Whether the TCP connection succeeded |
| `durationMs` | Connection time |

**Certificate checks** inspect TLS certificates with a 10-second timeout:

| Field | Description |
|-------|-------------|
| `host`, `port` | TLS endpoint |
| `success` | Whether the certificate is valid |
| `expiresAt` | Certificate expiry date |
| `daysUntilExpiry` | Days remaining |
| `issuer`, `subject` | Certificate details |

### Container Discovery

The agent reports the full list of Docker containers (running and stopped) on each collection cycle. BRIDGEPORT uses this data for automatic service discovery.

### Process Snapshots

When enabled (`collectProcesses`), the agent reports the top 10 processes by CPU and memory, plus overall process statistics (total, running, sleeping, stopped, zombie).

---

## Upgrade Detection

BRIDGEPORT tracks agent versions and indicates when an upgrade is available:

- The agent reports its version on every metrics push (`agentVersion` field)
- BRIDGEPORT compares this against the bundled agent version in the Docker image
- The **server detail page** shows an "Update available" badge when versions differ
- The **Monitoring > Agents** page shows upgrade status for all agents

To upgrade an agent:

1. Go to the server detail page
2. Click **Deploy Agent** (this re-deploys with the latest bundled binary)

Or manually download the new binary and restart the systemd service.

---

## Troubleshooting

**Agent not reporting**

1. Check the agent logs:
   ```bash
   sudo journalctl -u bridgeport-agent -f
   ```

2. Verify the agent can reach BRIDGEPORT:
   ```bash
   curl -v https://deploy.example.com/api/agent/config \
     -H "Authorization: Bearer YOUR_AGENT_TOKEN"
   ```

3. Check that the agent token matches what BRIDGEPORT expects (visible on the server detail page)

**"Config fetch failed with status 401"**

The agent token is invalid or was regenerated. Go to the server detail page in BRIDGEPORT, copy the current token, and update the agent configuration.

**"Error collecting Docker metrics"**

The agent cannot access the Docker socket. Ensure:
- The agent runs as root or a user in the `docker` group
- `/var/run/docker.sock` exists and is accessible

**Metrics not appearing in the UI**

1. Confirm the server's metrics mode is set to "Agent" (not "SSH" or "Disabled")
2. Check that monitoring is enabled for the environment (Environment Settings > Monitoring > Enable Monitoring)
3. Verify the agent is sending data by checking its logs for "Metrics sent successfully"

**Agent shows "stale" or "offline"**

BRIDGEPORT marks agents based on how recently they pushed metrics:
- **Stale**: No push in the last 3 minutes (configurable via `agentStaleThresholdMs` in system settings)
- **Offline**: No push in the last 5 minutes (configurable via `agentOfflineThresholdMs`)

Check if the agent process is running and if there are network issues between the agent and BRIDGEPORT.

---

## Related Docs

- [System Settings](system-settings.md) -- Agent threshold configuration
- [Environment Settings](environment-settings.md) -- Per-environment metric toggles
- [CLI Reference](cli.md) -- Terminal-based server management
- [API Reference](api.md) -- Metrics ingest endpoint documentation
