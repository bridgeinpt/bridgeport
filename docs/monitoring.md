# Monitoring

BridgePort provides comprehensive monitoring for servers, services, and databases through the Monitoring hub.

## Monitoring Hub

Access the monitoring hub from **Monitoring** in the sidebar. It consists of several sub-pages:

| Page | Description |
|------|-------------|
| **Overview** | Summary with quick stats and links to sub-pages |
| **Servers** | Server metrics with time-series charts |
| **Services** | Service/container metrics with charts |
| **Databases** | Database monitoring grid with status and metrics |
| **Health Checks** | Filterable health check log history |
| **Agents** | Agent management, SSH testing, upgrade status |

## Server Metrics

BridgePort collects system-level metrics from servers using one of two methods:

### SSH Polling

BridgePort runs commands over SSH to collect metrics. No additional software needed on the server.

Collected metrics:
- CPU usage
- Memory usage (used/total)
- Swap usage
- Disk usage (used/total)
- Load averages (1m, 5m, 15m)
- TCP connections
- File descriptor counts
- Process counts

**Setup**: Set the server's metrics mode to "SSH" on its detail page. Ensure monitoring is enabled in environment settings.

### Agent Push

A lightweight Go agent runs on the server and pushes metrics to BridgePort every 30 seconds.

Collected metrics (same as SSH plus):
- Per-container CPU and memory
- Per-container network I/O
- Per-container block I/O
- Container restart counts

**Setup**:

1. Set the server's metrics mode to "Agent" on its detail page
2. Copy the generated agent token
3. Install the agent on the server:

```bash
# Download from BridgePort
curl -L https://your-bridgeport/api/downloads/cli/linux/amd64 -o /usr/local/bin/bridgeport-agent
chmod +x /usr/local/bin/bridgeport-agent

# Create systemd service
cat > /etc/systemd/system/bridgeport-agent.service << 'EOF'
[Unit]
Description=BridgePort Monitoring Agent
After=network.target docker.service

[Service]
Type=simple
Environment="BRIDGEPORT_SERVER=https://deploy.example.com"
Environment="BRIDGEPORT_TOKEN=your-agent-token-here"
ExecStart=/usr/local/bin/bridgeport-agent
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bridgeport-agent
systemctl start bridgeport-agent
```

> **Tip**: Use internal/VPC IPs for the `BRIDGEPORT_SERVER` URL for better security and performance.

### Agent Configuration

| Flag | Environment Variable | Default | Description |
|------|---------------------|---------|-------------|
| `-server` | `BRIDGEPORT_SERVER` | Required | BridgePort server URL |
| `-token` | `BRIDGEPORT_TOKEN` | Required | Agent authentication token |
| `-interval` | — | `30s` | Collection interval |

### Agent Upgrades

The Monitoring > Agents page shows the upgrade status of all agents:
- **Current version** of the deployed agent
- **Bundled version** in the BridgePort image
- **"Update available"** badge when versions differ

The agent binary can be extracted from the BridgePort container:
```bash
docker cp bridgeport:/app/agent/bridgeport-agent ./bridgeport-agent
```

## Service Metrics

Service-level metrics are collected alongside server metrics and show per-container resource usage:

- CPU usage percentage
- Memory usage (used/limit)
- Network I/O (RX/TX in MB)
- Block I/O (read/write)
- Restart count

View service metrics on **Monitoring > Services** or on individual service detail pages.

## Database Monitoring

Database monitoring runs plugin-defined queries against your registered databases at configurable intervals.

### Setup

1. Register a database (see [Databases](databases.md))
2. Enable monitoring on the database detail page
3. Set the collection interval
4. Click **Test Connection** to verify

### How It Works

- **SQL mode** (PostgreSQL, MySQL): BridgePort connects directly to the database and runs monitoring queries
- **SSH mode** (SQLite): BridgePort runs commands over SSH on the database server

Monitoring queries are defined in the database type's plugin file. They produce scalar values, single rows, or tables that are stored as JSON metrics and displayed as charts.

### Viewing Database Metrics

- **Monitoring > Databases**: Overview grid showing all monitored databases with status, key metrics, and sparkline charts
- **Database Detail > Monitoring**: Full charts for individual database metrics over time

## Health Checks

Health checks verify that servers and services are reachable and functioning:

### Automatic Health Checks

The scheduler runs health checks at the configured intervals:
- **Server health**: Verify SSH/socket connectivity and Docker responsiveness
- **Service health**: Check container status, Docker health, and URL health (if configured)

### Manual Health Checks

Trigger a health check at any time by clicking the health check button on a server or service.

### Health Check Logs

All health check results are recorded in **Monitoring > Health Checks** with:
- Timestamp
- Server/service name
- Status (healthy/unhealthy/unknown)
- Duration
- Response details

Health check logs are filterable by server, service, status, and time range. Retention is controlled by the **Health Log Retention** setting (default: 30 days).

## SSH Testing

Test SSH connectivity to any server from **Monitoring > Agents**. This verifies that BridgePort can reach the server and execute commands.

## Metrics Retention

Metrics data is automatically cleaned up based on the **Metrics Retention** setting (default: 7 days). The cleanup job runs hourly.

Storage estimates for typical deployments:
- 10 servers x 5 services x 2 metrics/min x 7 days ≈ 1M records ≈ ~100MB

Adjust retention in your environment's Monitoring settings based on your storage capacity and history needs.

## Auto-Refresh

All monitoring pages auto-refresh every 30 seconds. You can toggle auto-refresh on or off using the checkbox in the page header.

## Configuring Monitoring Intervals

Monitoring intervals can be configured at two levels:

1. **Global** (environment variables): Set default intervals for all environments
2. **Per-environment** (Settings > Monitoring): Override intervals for specific environments

Per-environment settings override global defaults when configured.
