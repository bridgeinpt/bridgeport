# Changelog

All notable changes to BridgePort are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). BridgePort uses git-based versioning in the format `YYYYMMDDHH-{7-char SHA}`.

## [Unreleased]

_Nothing yet._

## [1.0.0] - 2026-02-25

Initial public release of BridgePort.

### Added

**Core Infrastructure**
- Multi-server management via SSH and Docker socket connections
- Environment system for isolating staging, production, and other deployment contexts
- Server health monitoring with configurable check intervals
- Automatic container discovery on connected servers
- Docker host detection with socket or SSH bootstrap

**Deployment and Orchestration**
- One-click container deployments with pull-and-restart workflow
- Container image management as a central entity shared across services
- Deployment orchestration with dependency-aware step ordering
- Service dependencies (`health_before`, `deploy_after`) to control deployment sequence
- Auto-rollback on deployment failure with coordinated rollback of all steps
- Deployment plans with real-time step progress tracking
- Deployment history with expandable logs per service
- Deployment artifacts (generated compose/env/config files) stored per deployment

**Container Images and Registries**
- Container image tag tracking with success, failed, and rolled_back history
- Registry connections for Docker Hub, GitHub Container Registry, and Docker Registry V2 (Harbor, GitLab, etc.)
- Automatic update checking with configurable refresh intervals per registry
- Auto-link patterns for matching images to registries automatically
- Per-image auto-update toggle for automatic deployment on new tags
- Digest-based comparison for detecting `latest` tag changes
- "Deploy All" action to deploy a tag to all linked services

**Docker Compose**
- Auto-generated Docker Compose templates for service deployments
- Custom compose templates with variable substitution (`${SERVICE_NAME}`, `${IMAGE_TAG}`, etc.)
- Compose preview before deploying
- Config file path injection into compose templates

**Monitoring**
- Server metrics collection via SSH polling (CPU, memory, disk, load, swap, TCP connections, file descriptors)
- Lightweight Go monitoring agent with push-based metrics delivery
- Container-level metrics (CPU, memory, network I/O, block I/O)
- Agent container snapshots and process snapshots
- Agent auto-deployment via SSH from the BridgePort UI
- Agent lifecycle event tracking (deploy, status change, token regeneration)
- Agent upgrade detection with "Update available" indicators
- Database monitoring with plugin-driven queries for PostgreSQL, MySQL, SQLite, MongoDB, and Redis
- Configurable collection intervals per database
- SQL mode (direct connection) and SSH mode (command execution) for database monitoring
- Monitoring hub with overview, server, service, database, health check, and agent pages
- Time-series charts with configurable time ranges and auto-refresh
- Metrics retention with automatic cleanup

**Health Checks**
- Container health checks (Docker health status)
- URL health checks (HTTP endpoint verification)
- TCP port connectivity checks (agent-required)
- TLS certificate expiry checks (agent-required)
- Per-service health check configuration (wait time, retries, interval)
- Health check logs with filterable history
- Bounce logic to prevent notification storms from repeated failures
- Post-deployment health verification with configurable retries

**Secrets and Configuration**
- Encrypted secret storage with AES-256-GCM encryption
- Per-environment secret isolation
- `neverReveal` flag for write-only secrets
- Per-environment reveal control (disable secret viewing for production)
- Env template system with secret substitution and `${VARIABLE}` syntax
- Config file management with text and binary support
- Config file edit history with version tracking and rollback
- Config file attachment to services with target paths
- One-click sync to push config files to servers via SSH

**Database Management**
- Database registration for PostgreSQL, MySQL, SQLite, MongoDB, and Redis
- Manual and scheduled backups with cron syntax
- Backup storage on local filesystem or S3-compatible object storage (DigitalOcean Spaces, AWS S3, MinIO, etc.)
- Backup retention policies with automatic cleanup
- Backup download and restore capabilities
- Service-to-database linking with connection environment variables

**Notifications**
- In-app notification inbox with read/unread status and filtering
- Email notifications via SMTP configuration
- Slack notifications via incoming webhooks with channel routing
- Outgoing webhook notifications with retry logic
- Per-user, per-type notification preferences with channel selection
- Environment filtering for notification preferences
- Notification type templates with `{{placeholder}}` substitution
- Bounce tracker for consecutive failure detection and alert storm prevention

**Service Topology**
- Interactive topology diagram on the dashboard
- User-defined connections between services and databases with port, protocol, and direction
- Draggable nodes with per-environment layout persistence
- Server group visualization

**Plugin System**
- JSON-defined service types (Django, Node.js, Generic, and custom)
- JSON-defined database types with monitoring query definitions
- Plugin sync on startup with smart merge (create new, update non-customized, preserve customized)
- `isCustomized` tracking for admin UI modifications
- Plugin reset and export capabilities
- Template-based backup commands with `{{placeholder}}` substitution

**User Management and Security**
- Role-based access control with three tiers: admin, operator, viewer
- JWT authentication with 7-day token expiry
- API tokens for programmatic access with optional expiry and last-used tracking
- Bcrypt password hashing
- Self-service account management (profile and password change for all users)
- Active user tracking with configurable activity window
- Initial admin creation from environment variables on first boot

**Per-Environment Settings**
- General settings (SSH user)
- Monitoring settings (intervals, retention, metric toggles, bounce thresholds)
- Operations settings (default Docker mode, default metrics mode)
- Data settings (backup download, default monitoring)
- Configuration settings (secret reveal permissions)

**System Settings**
- SSH command and connection timeouts
- Webhook max retries, timeout, and retry delays
- Backup timeouts and limits
- Max upload size, active user window, registry max tags, default log lines
- External URL configuration
- Reset to defaults capability

**CLI Tool**
- `login` -- authenticate with a BridgePort instance
- `whoami` -- show current user and server info
- `config` -- manage CLI configuration
- `list` -- list servers in an environment
- `status` -- show server details and container status
- `ssh` -- SSH into a server
- `exec` -- execute commands in containers
- `logs` -- view container logs with follow mode
- `run` -- execute predefined service type commands
- `services`, `databases`, `secrets`, `configs`, `images`, `registries` -- resource management
- `health` -- run health checks
- `backups` -- manage database backups
- `audit` -- view audit logs
- `version` -- show CLI and server version info
- `completion` -- generate shell completions for bash, zsh, fish, powershell

**Web UI**
- Dashboard with topology diagram and summary stats
- Operations section: servers, services, databases
- Monitoring section: overview hub, server/service/database metrics, health checks, agents
- Orchestration section: container images, deployment plans, registries
- Configuration section: environment settings, secrets, config files
- Admin section: about, system settings, service types, database types, storage, users, audit, notifications
- Collapsible sidebar with environment selector
- Notification bell with unread count
- Breadcrumb navigation
- Dark theme

**Infrastructure**
- SQLite database with Prisma ORM and automatic migrations on container start
- Audit logging for all sensitive operations
- Automatic database baselining for legacy databases
- Background job scheduler with configurable intervals
- S3-compatible storage integration for backups (DigitalOcean Spaces, AWS S3, MinIO, etc.)
- Sentry integration for error monitoring (optional, backend and frontend)
- Server-Sent Events (SSE) for real-time UI updates
- CI/CD webhook endpoint for deployment triggers
- Git-based versioning (app, agent, CLI derive versions from commits)

[Unreleased]: https://github.com/bridgeinpt/bridgeport/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/bridgeinpt/bridgeport/releases/tag/v1.0.0
