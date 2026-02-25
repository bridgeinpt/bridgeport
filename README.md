[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io%2Fbridgeinpt%2Fbridgeport-blue)](https://ghcr.io/bridgeinpt/bridgeport)

# BridgePort

**Dock. Run. Ship. Repeat.**

A lightweight, self-hosted deployment management tool for Docker-based infrastructure. Manage servers, deploy containers, monitor health, and orchestrate multi-service rollouts -- all from one place, no Kubernetes required.

Created by the Engineering Team at [BridgeIn](https://bridgein.pt).

## The Problem

Managing Docker containers across multiple servers means SSH-ing into each machine, remembering the right `docker pull` and `docker compose` commands, hoping nothing breaks, and having zero visibility into what's running where. When something goes wrong at 2 AM, there's no rollback button -- just you and a terminal.

## The Solution

BridgePort gives you a single web UI to manage all your Docker infrastructure. Connect your servers via SSH (or Docker socket for the local host), and you get one-click deploys with auto-rollback, real-time health monitoring, encrypted secrets, database backups, and multi-channel notifications. It's designed for teams that want production-grade tooling without the complexity of Kubernetes.

## Key Features

| | Feature | Description |
|---|---|---|
| **Servers** | Multi-Server Management | Connect via SSH or Docker socket. Discover containers automatically |
| **Deploy** | One-Click Deployments | Deploy new image tags with auto-rollback on failure |
| **Monitor** | Real-Time Monitoring | Server, service, and database metrics via SSH polling or Go agent |
| **Health** | Health Checks | Container, URL, TCP, and TLS certificate checks with bounce protection |
| **Secrets** | Encrypted Secrets | AES-256-GCM encryption at rest with per-environment isolation |
| **Backup** | Database Backups | Scheduled PostgreSQL, MySQL, and SQLite backups to S3-compatible storage |
| **Notify** | Notifications | In-app, email (SMTP), Slack, and outgoing webhooks |
| **Registry** | Registry Integration | Docker Hub, GHCR, and private registries with auto-update |
| **Topology** | Service Topology | Interactive diagram of your service architecture |
| **CLI** | CLI Tool | SSH, logs, exec, deploy, and manage from the terminal |
| **Plugins** | Plugin System | JSON-defined service types and database types with monitoring queries |
| **RBAC** | Access Control | Three roles: admin, operator, viewer |

## Quick Start

Get BridgePort running in 30 seconds:

```bash
docker run -d \
  --name bridgeport \
  -p 3000:3000 \
  -v bridgeport-data:/data \
  -e DATABASE_URL=file:/data/bridgeport.db \
  -e MASTER_KEY=$(openssl rand -base64 32) \
  -e JWT_SECRET=$(openssl rand -base64 32) \
  -e ADMIN_EMAIL=admin@example.com \
  -e ADMIN_PASSWORD=changeme123 \
  ghcr.io/bridgeinpt/bridgeport:latest
```

Expected output:

```
Unable to find image 'ghcr.io/bridgeinpt/bridgeport:latest' locally
latest: Pulling from bridgeinpt/bridgeport
...
Status: Downloaded newer image for ghcr.io/bridgeinpt/bridgeport:latest
a1b2c3d4e5f6...
```

Verify it's running:

```bash
curl http://localhost:3000/health
```

```json
{"status":"ok","timestamp":"2026-02-25T12:00:00.000Z","version":"20260225-abc1234"}
```

Open [http://localhost:3000](http://localhost:3000) and log in with your `ADMIN_EMAIL` and `ADMIN_PASSWORD`.

> [!WARNING]
> This quick start is for trying BridgePort out. For production, use Docker Compose with persistent volumes, HTTPS, and strong credentials. See the [Installation Guide](docs/installation.md).

## Feature Highlights

### Deploy and Monitor Flow

BridgePort coordinates deployments across your services, verifies health after each step, and rolls back automatically if something goes wrong.

```mermaid
flowchart LR
    A[New Image Tag] --> B[Pull Image]
    B --> C[Deploy Container]
    C --> D{Health Check}
    D -->|Healthy| E[Done]
    D -->|Unhealthy| F[Auto-Rollback]
    F --> G[Notify Team]
    E --> G
```

### Multi-Server Architecture

Connect all your servers to a single BridgePort instance. Manage staging and production environments independently, each with their own SSH keys, secrets, and settings.

```mermaid
flowchart TB
    BP[BridgePort]

    subgraph staging[Staging Environment]
        S1[Web Server]
        S2[API Server]
    end

    subgraph production[Production Environment]
        P1[Web Server 1]
        P2[Web Server 2]
        P3[API Server]
        P4[Worker Server]
    end

    BP -->|SSH| S1
    BP -->|SSH| S2
    BP -->|SSH| P1
    BP -->|SSH| P2
    BP -->|SSH| P3
    BP -->|SSH| P4
```

### Deployment Orchestration

Define dependencies between services, and BridgePort builds an execution plan that respects the correct order -- deploying databases before APIs, APIs before frontends, with health checks between each step.

```mermaid
flowchart TD
    A[Deploy Database Migration] --> B{Health Check}
    B -->|OK| C[Deploy API Service]
    B -->|Fail| R1[Rollback Database]
    C --> D{Health Check}
    D -->|OK| E[Deploy Web Frontend]
    D -->|Fail| R2[Rollback API + Database]
    E --> F{Health Check}
    F -->|OK| G[All Services Deployed]
    F -->|Fail| R3[Rollback All]
```

## Documentation

| Section | Description |
|---|---|
| [Getting Started](docs/getting-started.md) | Deploy BridgePort and manage your first server in 5 minutes |
| [Core Concepts](docs/concepts.md) | Architecture overview and glossary |
| [Installation Guide](docs/installation.md) | Docker run, Docker Compose, and development setup |
| [Configuration](docs/configuration.md) | Environment variables, recipes, and settings reference |
| [Feature Guides](docs/guides/) | Server, service, database, monitoring, and more |
| [CLI Reference](docs/reference/cli.md) | Full command-line interface documentation |
| [API Reference](docs/reference/api.md) | REST API authentication and endpoints |
| [Operations](docs/operations/) | Upgrades, security hardening, backups, troubleshooting |
| [Contributing](CONTRIBUTING.md) | Development setup, code style, and PR process |

## Quick Links

| I want to... | Go here |
|---|---|
| Deploy BridgePort for production | [Installation Guide](docs/installation.md) |
| Add my first server | [Server Guide](docs/guides/servers.md) |
| Deploy a service update | [Service Guide](docs/guides/services.md) |
| Set up monitoring | [Monitoring Guide](docs/guides/monitoring.md) |
| Configure database backups | [Database Guide](docs/guides/databases.md) |
| Manage secrets | [Secrets Guide](docs/guides/secrets.md) |
| Set up notifications | [Notifications Guide](docs/guides/notifications.md) |
| Use the CLI | [CLI Reference](docs/reference/cli.md) |
| Orchestrate multi-service deploys | [Deployment Plans](docs/guides/deployment-plans.md) |
| Contribute to BridgePort | [Contributing Guide](CONTRIBUTING.md) |
| Report a security issue | [Security Policy](docs/SECURITY.md) |

## Community and Support

- **Bug reports and feature requests**: [GitHub Issues](https://github.com/bridgeinpt/bridgeport/issues)
- **Questions and discussions**: [GitHub Discussions](https://github.com/bridgeinpt/bridgeport/discussions)
- **Contributing**: See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines
- **Security issues**: See [SECURITY.md](docs/SECURITY.md) for responsible disclosure

## License

BridgePort is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).

**What this means for you:**

- You can use BridgePort freely for any purpose, including commercial use
- You can modify and self-host BridgePort without restriction
- If you modify BridgePort and offer it as a hosted service to others, you must share your modifications under the same license
- If you just run BridgePort internally (even at a company), you have no obligations beyond the license terms

Copyright 2024-2025 BridgeIn.
