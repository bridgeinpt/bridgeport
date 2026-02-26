# Project Structure

```
bridgeport/
├── src/                       # Backend (Node.js, Fastify, TypeScript)
│   ├── server.ts              # Fastify entry point
│   ├── lib/                   # Core utilities (config, crypto, db, docker, ssh, scheduler, registry)
│   ├── routes/                # API route handlers (one file per resource)
│   │   └── admin/             # Admin-only route modules (SMTP, webhooks, Slack)
│   ├── services/              # Business logic layer (deploy, orchestration, notifications, etc.)
│   └── plugins/               # Fastify plugins (authenticate, authorize)
├── ui/                        # Frontend (React, Vite, Tailwind CSS)
│   ├── src/
│   │   ├── components/        # Reusable components (Layout, TopBar, monitoring/, topology/)
│   │   ├── pages/             # Page components (one per route)
│   │   │   ├── service-detail/ # Service detail sub-components
│   │   │   └── admin/         # Admin-only pages (separate layout)
│   │   └── lib/               # Utilities (api client, Zustand store, status helpers)
│   └── public/                # Static assets
├── plugins/                   # Plugin JSON definitions
│   ├── service-types/         # Service type definitions (Django, Node.js, etc.)
│   └── database-types/        # Database type definitions with monitoring queries
├── bridgeport-agent/          # Go monitoring agent (collector/system.go, collector/docker.go)
├── cli/                       # Go CLI (Cobra framework, cmd/, internal/)
├── config/                    # Build/test configuration (vitest configs, codecov)
├── prisma/                    # Database schema + migrations
├── docker/                    # Docker + Caddy configuration
├── docs/                      # Project documentation
└── tests/                     # Test infrastructure (helpers, factories, security)
```

## Key Directories

### `src/lib/`
Core utilities shared across routes and services: environment config (`config.ts`), AES-256-GCM encryption (`crypto.ts`), Prisma client singleton (`db.ts`), Docker client abstraction (`docker.ts`), SSH client wrapper (`ssh.ts`), background job scheduler (`scheduler.ts`), container registry client factory (`registry.ts`), image name parsing (`image-utils.ts`), and Sentry init (`sentry.ts`).

### `src/routes/`
Each file exports a Fastify plugin with route handlers for one resource area. Admin-only routes live in `routes/admin/`. Routes handle HTTP concerns (validation, auth, response formatting) and delegate to services.

### `src/services/`
Business logic layer. Each file handles one domain: deployment (`deploy.ts`), orchestration (`orchestration.ts`), image management (`image-management.ts`), notifications (`notifications.ts`), health checks (`health-checks.ts`, `health-verification.ts`), database operations (`database-backup.ts`, `database-monitoring-collector.ts`, `database-query-executor.ts`), agent management (`agent-deploy.ts`, `agent-events.ts`), and more.

### `ui/src/components/`
Reusable UI components. Notable subdirectories: `monitoring/` (ChartCard, StatCard, MetricGauge, TimeRangeSelector, AutoRefreshToggle) and `topology/` (TopologyDiagram, ServiceNode, DatabaseNode, ServerGroupNode, NodePopover, AddConnectionModal).

### `ui/src/pages/`
One component per route. `service-detail/` contains sub-components for the service detail page (DeployCard, DeploymentHistory, ActionHistory, ConfigFilesCard, HealthCheckResultCard). `admin/` contains admin-only pages using a separate layout.

### `tests/`
Test infrastructure: `helpers/` (test app builder, auth helpers), `factories/` (test data factories for User, Environment, Server, ContainerImage, Service), `security/` (RBAC matrix tests).
