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
Each file exports a Fastify plugin with route handlers for one resource area — including servers, services, deployment plans (`deployment-plans.ts`), service dependencies (`service-dependencies.ts`), config files and reusable fragments (`config-files.ts`, `config-fragments.ts`), atomic batch syncs (`sync-batch.ts`), config scanning (`config-scan.ts`), API tokens and machine service accounts (`api-tokens.ts`, `service-accounts.ts`), backup storage (`spaces.ts`), and topology. Admin-only routes live in `routes/admin/`. Routes handle HTTP concerns (validation, auth, response formatting) and delegate to services.

### `src/services/`
Business logic layer. Each file handles one domain: deployment (`deploy.ts`), orchestration (`orchestration.ts`), atomic batch sync (`sync-batch.ts`), server bootstrap (`bootstrap.ts`), config auto-resync (`config-file-auto-resync.ts`), template rendering (`template-engine.ts`), image management (`image-management.ts`), registry login state (`registry-login.ts`), plugin-defined service/database types (`service-types.ts`), notifications (`notifications.ts`, `notification-queue.ts`), health checks (`health-checks.ts`, `health-verification.ts`), database operations (`database-backup.ts`, `database-monitoring-collector.ts`, `database-query-executor.ts`), agent management (`agent-deploy.ts`, `agent-events.ts`), and more.

### `ui/src/components/`
Reusable UI components. Notable subdirectories: `monitoring/` (ChartCard, StatCard, MetricGauge, TimeRangeSelector, AutoRefreshToggle) and `topology/` (TopologyDiagram, ServiceNode, DatabaseNode, ServerGroupNode, ServerClusterNode, ExternalEntityNode, NodePopover, AddConnectionModal).

### `ui/src/pages/`
One component per route — services, servers, databases, registries, config files and fragments (`ConfigFiles.tsx`, `Fragments.tsx`), deployment plans (`DeploymentPlans.tsx`, `DeploymentPlanDetail.tsx`), monitoring, and more. `service-detail/` contains sub-components for the service detail page (DeployCard, DeploymentHistory, ActionHistory, ConfigFilesCard, HealthCheckResultCard). `admin/` contains admin-only pages (users, audit, system settings, integrations, service/database types, storage) using a separate layout.

### `tests/`
Test infrastructure: `helpers/` (test app builder, auth helpers), `factories/` (test data factories for User, Environment, Server, ContainerImage, Service), `security/` (RBAC matrix tests).
