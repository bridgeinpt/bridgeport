# BridgePort Documentation

Everything you need to deploy, manage, and monitor your Docker infrastructure with BridgePort.

---

## Start Here

New to BridgePort? Start from the top and work down.

| Doc | Description |
|-----|-------------|
| [Getting Started](getting-started.md) | Deploy BridgePort and manage your first server in 5 minutes |
| [Core Concepts](concepts.md) | How BridgePort thinks: environments, servers, services, images |
| [Installation Guide](installation.md) | Docker run, Docker Compose, reverse proxy, and development setup |
| [Configuration Reference](configuration.md) | Every environment variable, with recipes for common setups |

---

## Feature Guides

Learn how to use each feature. Every guide includes a quick start, step-by-step walkthrough, configuration options, and troubleshooting.

### Users and Access

| Doc | Description |
|-----|-------------|
| [Users and Roles](guides/users.md) | RBAC model, user management, API tokens, self-service account |

### Infrastructure

| Doc | Description |
|-----|-------------|
| [Environments](guides/environments.md) | Create and configure environments with SSH keys and per-module settings |
| [Servers](guides/servers.md) | Add servers, configure SSH or Docker socket, enable metrics |
| [Services](guides/services.md) | Deploy containers, configure health checks, attach config files |
| [Container Images](guides/container-images.md) | Central image management, tag history, auto-update |
| [Registries](guides/registries.md) | Connect Docker Hub, GHCR, and private registries |

### Configuration and Secrets

| Doc | Description |
|-----|-------------|
| [Secrets and Variables](guides/secrets.md) | Encrypted secrets, plaintext vars, config file scanner, reveal controls |
| [Config Files](guides/config-files.md) | Manage and sync configuration files with edit history |

### Data

| Doc | Description |
|-----|-------------|
| [Databases](guides/databases.md) | Register databases, schedule backups, enable monitoring |
| [S3/Spaces Storage](guides/storage.md) | Configure S3-compatible storage for backup destinations |

### Monitoring

| Doc | Description |
|-----|-------------|
| [Monitoring Quick Start](guides/monitoring.md) | Pick your monitoring mode and see your first metrics |
| [Server Monitoring](guides/monitoring-servers.md) | CPU, memory, disk, load -- SSH polling and agent deep dive |
| [Service Monitoring](guides/monitoring-services.md) | Container CPU, memory, network, and block I/O metrics |
| [Database Monitoring](guides/monitoring-databases.md) | Plugin-driven database metrics for PostgreSQL, MySQL, SQLite, and more |
| [Health Checks](guides/health-checks.md) | Container, URL, TCP, and TLS certificate checks with bounce protection |

### Automation and Visualization

| Doc | Description |
|-----|-------------|
| [Notifications](guides/notifications.md) | In-app, email, Slack, and webhook notifications with preferences |
| [Service Topology](guides/topology.md) | Interactive architecture diagram on the dashboard |
| [Deployment Plans](guides/deployment-plans.md) | Orchestrate multi-service deploys with dependency ordering and auto-rollback |
| [Webhooks](guides/webhooks.md) | CI/CD webhook integration for automated deployments |

---

## Reference

Detailed technical reference for APIs, CLI, agent, plugins, and settings.

| Doc | Description |
|-----|-------------|
| [API Reference](reference/api.md) | REST API authentication, endpoints, and error handling |
| [CLI Reference](reference/cli.md) | Full command reference with examples and expected output |
| [Agent Reference](reference/agent.md) | Monitoring agent installation, configuration, and troubleshooting |
| [Real-Time Events (SSE)](reference/events.md) | Server-Sent Events endpoint, event types, and client integration |
| [Plugin Authoring](reference/plugins.md) | Create custom service types and database types with monitoring queries |
| [Environment Settings](reference/environment-settings.md) | All per-environment settings (General, Monitoring, Operations, Data, Configuration) |
| [System Settings](reference/system-settings.md) | Admin-only system-wide operational settings |

---

## Operations

Run BridgePort reliably in production.

| Doc | Description |
|-----|-------------|
| [Upgrades](operations/upgrades.md) | How upgrades work, upgrade procedure, rollback, and agent updates |
| [Security and Hardening](operations/security.md) | Security architecture, RBAC model, hardening checklist, audit logging |
| [Backup and Restore](operations/backup-restore.md) | Back up BridgePort's own database and manage database backups |
| [Troubleshooting](operations/troubleshooting.md) | Common issues, debug steps, and quick fix table |
| [Architecture Patterns](operations/patterns.md) | Single-server, multi-server, staging+production, and real-world stack examples |

---

## Contributing

Help build BridgePort.

| Doc | Description |
|-----|-------------|
| [Contributing Guide](../CONTRIBUTING.md) | Development setup, workflow, code style, and PR process |
| [Development Setup](development/setup.md) | Full dev environment with hot reload |
| [Architecture Guide](development/architecture.md) | Codebase deep dive: backend, frontend, scheduler, auth flow |
| [Database Migrations](development/database-migrations.md) | How to make schema changes safely with Prisma |
| [Building](development/building.md) | Build the Docker image, Go agent, and CLI |

---

## Quick Links

| I want to... | Go here |
|---|---|
| Get BridgePort running in 5 minutes | [Getting Started](getting-started.md) |
| Deploy to production | [Installation Guide](installation.md) |
| Add my first server | [Servers](guides/servers.md) |
| Deploy a service | [Services](guides/services.md) |
| Set up monitoring | [Monitoring Quick Start](guides/monitoring.md) |
| Back up my databases | [Databases](guides/databases.md) |
| Use the CLI | [CLI Reference](reference/cli.md) |
| Write a plugin | [Plugin Authoring](reference/plugins.md) |
| Upgrade BridgePort | [Upgrade Guide](operations/upgrades.md) |
| Fix a problem | [Troubleshooting](operations/troubleshooting.md) |
| Contribute code | [Contributing Guide](../CONTRIBUTING.md) |
| Report a vulnerability | [Security Policy](./SECURITY.md) |
