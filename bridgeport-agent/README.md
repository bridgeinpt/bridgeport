# BridgePort Agent

A lightweight monitoring agent that collects server and container metrics and pushes them to BridgePort.

## Overview

The agent runs on monitored servers and periodically collects:
- **System metrics**: CPU usage, memory usage, disk usage, load averages, uptime
- **Container metrics**: Per-container CPU, memory, network I/O, block I/O, restart counts

Metrics are pushed to BridgePort via HTTP POST every 30 seconds (configurable).

## Versioning

The agent version is derived from git at build time (format: `YYYYMMDD-{7-char SHA}`) and only changes when the `bridgeport-agent/` directory is modified.

**Upgrade Indicators**: BridgePort UI shows an "Update available" badge on servers when the deployed agent version differs from the bundled version. Check the Monitoring > Agents page to see which servers need agent updates.

## Building

```bash
# Build for current platform
make build

# Cross-compile for Linux amd64 (typical server target)
make build-linux

# Clean build artifacts
make clean
```

Output binary: `bridgeport-agent` (or `bridgeport-agent-linux` for cross-compile)

## Installation

### 1. Enable Agent Mode in BridgePort

1. Go to the server's settings page in BridgePort UI
2. Set **Metrics Mode** to "Agent"
3. Copy the generated **Agent Token**

### 2. Install the Agent Binary

```bash
# Copy the binary to the server
scp bridgeport-agent-linux root@server:/usr/local/bin/bridgeport-agent
ssh root@server chmod +x /usr/local/bin/bridgeport-agent
```

### 3. Create Systemd Service

```bash
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
```

### 4. Start the Service

```bash
systemctl daemon-reload
systemctl enable bridgeport-agent
systemctl start bridgeport-agent

# Check status
systemctl status bridgeport-agent
journalctl -u bridgeport-agent -f
```

## Configuration

| Flag | Environment Variable | Description | Default |
|------|---------------------|-------------|---------|
| `-server` | `BRIDGEPORT_SERVER` | BridgePort server URL | Required |
| `-token` | `BRIDGEPORT_TOKEN` | Agent authentication token | Required |
| `-interval` | - | Collection/push interval | 30s |
| `-version` | - | Print version and exit | - |

### Internal Networking (Recommended)

Use internal/VPC IPs instead of public URLs for better security and performance:

```bash
# Public (works but not recommended):
Environment="BRIDGEPORT_SERVER=https://deploy.example.com"

# Internal (recommended - stays within VPC):
Environment="BRIDGEPORT_SERVER=http://10.30.10.5:3000"
```

Requirements for internal networking:
- BridgePort must be in the same VPC or a peered VPC
- BridgePort's `HOST` config should be `0.0.0.0`
- Firewall allows port 3000 from agent servers

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    Monitored Server                      │
│                                                          │
│  ┌──────────────────┐                                    │
│  │ bridgeport-agent │                                    │
│  └────────┬─────────┘                                    │
│           │                                              │
│     ┌─────┴─────┐                                        │
│     │           │                                        │
│     ▼           ▼                                        │
│  /proc/*    Docker Socket                                │
│  (system)   (containers)                                 │
│                                                          │
└──────────────────────────────────────────────────────────┘
            │
            │ POST /api/metrics/ingest
            │ (every 30s)
            ▼
┌──────────────────────────────────────────────────────────┐
│                     BridgePort                           │
│                                                          │
│  ┌─────────────────┐    ┌─────────────────┐              │
│  │ Metrics Ingest  │───▶│ ServerMetrics   │              │
│  │ Endpoint        │    │ ServiceMetrics  │              │
│  └─────────────────┘    └─────────────────┘              │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### System Metrics Collection

The agent reads from `/proc` filesystem:
- `/proc/stat` - CPU usage
- `/proc/meminfo` - Memory usage
- `/proc/loadavg` - Load averages
- `/proc/uptime` - System uptime
- `statfs("/")` - Disk usage

### Container Metrics Collection

The agent connects to the Docker socket (`/var/run/docker.sock`) and uses:
- `docker stats` equivalent API - CPU, memory, network, block I/O
- Container inspection - Restart counts

## Authentication

The agent authenticates using a Bearer token in the `Authorization` header:

```
Authorization: Bearer <agent-token>
```

Each server has a unique agent token, generated when agent mode is enabled. The token is validated against the server's `agentToken` field in the database.

## Payload Format

```json
{
  "cpuPercent": 23.5,
  "memoryUsedMb": 4096.0,
  "memoryTotalMb": 8192.0,
  "diskUsedGb": 50.0,
  "diskTotalGb": 100.0,
  "loadAvg1": 0.5,
  "loadAvg5": 0.7,
  "loadAvg15": 0.6,
  "uptime": 86400,
  "services": [
    {
      "containerName": "nginx",
      "cpuPercent": 2.5,
      "memoryUsedMb": 128.0,
      "memoryLimitMb": 512.0,
      "networkRxMb": 100.5,
      "networkTxMb": 50.2,
      "blockReadMb": 10.0,
      "blockWriteMb": 5.0,
      "restartCount": 0
    }
  ]
}
```

## Troubleshooting

### Agent can't connect to Docker

Ensure the agent has access to the Docker socket:
```bash
# Check socket permissions
ls -la /var/run/docker.sock

# Add user to docker group (if not running as root)
usermod -aG docker <user>
```

### Metrics not appearing in BridgePort

1. Check agent logs: `journalctl -u bridgeport-agent -f`
2. Verify the token matches the one in BridgePort UI
3. Ensure the server URL is reachable from the monitored server
4. Check that the server's metrics mode is set to "Agent" in BridgePort

### High CPU usage

Increase the collection interval:
```bash
ExecStart=/usr/local/bin/bridgeport-agent -interval 60s
```

## License

Copyright 2024-2025 BridgeIn. All rights reserved.
