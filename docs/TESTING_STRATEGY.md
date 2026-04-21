# BRIDGEPORT Testing Strategy

Comprehensive testing spec for full coverage of the BRIDGEPORT codebase — backend (Node.js/Fastify/Prisma), frontend (React/Vite), and Go components (agent + CLI).

---

## Table of Contents

1. [Philosophy & Principles](#1-philosophy--principles)
2. [Tooling](#2-tooling)
3. [Test Tiers](#3-test-tiers)
4. [Project Structure](#4-project-structure)
5. [Backend Testing](#5-backend-testing)
6. [Frontend Testing](#6-frontend-testing)
7. [Go Component Testing](#7-go-component-testing)
8. [Security Testing](#8-security-testing)
9. [Migration Testing](#9-migration-testing)
10. [Test Data Management](#10-test-data-management)
11. [Naming Conventions & Organization](#11-naming-conventions--organization)
12. [Coverage Policy](#12-coverage-policy)
13. [CI/CD Pipeline](#13-cicd-pipeline)
14. [Local Developer Experience](#14-local-developer-experience)
15. [Implementation Plan](#15-implementation-plan)

---

## 1. Philosophy & Principles

- **All external dependencies are mocked.** Docker, SSH, container registries, SMTP, Slack, DO Spaces — every external boundary is mocked/stubbed. Tests are fully deterministic and run without network access.
- **Tiered pipeline.** Fast tests on every commit, full suite on PR, comprehensive E2E nightly.
- **Differential coverage.** No global coverage gate. All changed/new files in PRs must have 90%+ line coverage.
- **One-shot implementation.** The entire test infrastructure and initial test suite is built in a single effort, not incrementally.
- **Tests describe behavior, not implementation.** Tests should survive refactors. Test what the code does, not how it does it internally.

---

## 2. Tooling

### Backend (Node.js/TypeScript)

| Tool | Purpose |
|------|---------|
| **Vitest** | Test runner, assertions, mocking, fake timers, coverage |
| **@vitest/coverage-v8** | V8-based code coverage reporting |
| **fastify.inject()** | In-process HTTP testing without port binding |
| **better-sqlite3** | In-memory SQLite for fast test databases |
| **Prisma** | Schema application to test databases |

### Frontend (React)

| Tool | Purpose |
|------|---------|
| **Vitest** | Test runner (shared config with backend where possible) |
| **@testing-library/react** | Component rendering and assertion |
| **@testing-library/user-event** | Simulating user interactions |
| **msw (Mock Service Worker)** | API mocking at the network layer |
| **jsdom** | DOM environment for component tests |

### Go (Agent + CLI)

| Tool | Purpose |
|------|---------|
| **go test** | Standard Go test runner |
| **testify** | Assertions and mock generation |
| **net/http/httptest** | HTTP server mocking for API tests |

### CI/CD

| Tool | Purpose |
|------|---------|
| **GitHub Actions** | CI/CD pipeline |
| **vitest-github-actions-reporter** | Inline test failure annotations in PRs |
| **codecov** or **coveralls** | Coverage reporting and diff tracking |

---

## 3. Test Tiers

### Tier 1: Unit Tests (every commit, <30s)

- Individual functions, utilities, and pure logic
- No I/O, no database, no network
- Fake timers for time-dependent code
- **Runs:** On every commit (pre-push hook) and CI

### Tier 2: Integration Tests (every PR, <2min)

- API routes via `fastify.inject()`
- Database operations against in-memory SQLite
- Service layer with mocked external deps
- Notification delivery pipeline
- SSE endpoint testing
- **Runs:** On every PR and merge to main

### Tier 3: System Tests (nightly, <10min)

- Full deployment orchestration simulations
- Migration up/down cycle verification
- Multi-step workflow tests (create env → add server → deploy → rollback)
- Go component integration tests
- **Runs:** Nightly scheduled CI run

---

## 4. Project Structure

Colocated test files (standard modern Node.js convention with Vitest):

```
bridgeport/
├── config/                       # Build/test configuration
│   ├── vitest.config.ts          # Backend integration test config
│   ├── vitest.unit.config.ts     # Backend unit test config
│   ├── vitest.workspace.ts       # Vitest workspace
│   └── codecov.yml               # Code coverage config
├── tests/                        # Shared test infrastructure
│   ├── setup.ts                  # Global test setup (env vars, mocks)
│   ├── teardown.ts               # Global teardown
│   ├── factories/                # Test data factories
│   │   ├── index.ts              # Re-exports all factories
│   │   ├── server.ts             # createTestServer()
│   │   ├── service.ts            # createTestService()
│   │   ├── environment.ts        # createTestEnvironment()
│   │   ├── user.ts               # createTestUser()
│   │   ├── container-image.ts    # createTestContainerImage()
│   │   ├── deployment.ts         # createTestDeployment()
│   │   ├── database.ts           # createTestDatabase()
│   │   └── notification.ts       # createTestNotification()
│   ├── scenarios/                # Named integration test scenarios
│   │   ├── healthy-deployment.ts # Full env with successful deployments
│   │   ├── failed-rollback.ts    # Deployment failure with rollback state
│   │   ├── multi-env.ts          # Multiple environments with shared images
│   │   └── notification-storm.ts # Bounce tracker scenario
│   ├── mocks/                    # Shared mock implementations
│   │   ├── docker.ts             # Mock Docker client
│   │   ├── ssh.ts                # Mock SSH client
│   │   ├── registry.ts           # Mock registry client
│   │   ├── smtp.ts               # Mock SMTP transport
│   │   ├── slack.ts              # Mock Slack webhook
│   │   └── spaces.ts             # Mock DO Spaces client
│   ├── helpers/                  # Test utilities
│   │   ├── db.ts                 # In-memory Prisma client setup
│   │   ├── app.ts                # Fastify app builder for testing
│   │   ├── auth.ts               # JWT token generation helpers
│   │   └── sse.ts                # SSE response parser
│   └── migrations/               # Migration-specific test infrastructure
│       └── migration.test.ts     # Migration up/down cycle tests
├── src/
│   ├── lib/
│   │   ├── crypto.ts
│   │   ├── crypto.test.ts        # ← Colocated unit test
│   │   ├── docker.ts
│   │   ├── docker.test.ts
│   │   └── ...
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── auth.test.ts          # ← Route integration test
│   │   └── ...
│   ├── services/
│   │   ├── deploy.ts
│   │   ├── deploy.test.ts
│   │   ├── orchestration.ts
│   │   ├── orchestration.test.ts
│   │   └── ...
│   └── plugins/
│       ├── authenticate.ts
│       └── authenticate.test.ts
├── ui/
│   ├── vitest.config.ts          # Frontend Vitest config
│   ├── src/
│   │   ├── components/
│   │   │   ├── Layout.tsx
│   │   │   ├── Layout.test.tsx   # ← Colocated component test
│   │   │   └── ...
│   │   ├── pages/
│   │   │   ├── Services.tsx
│   │   │   ├── Services.test.tsx
│   │   │   └── ...
│   │   └── lib/
│   │       ├── api.ts
│   │       ├── api.test.ts
│   │       ├── store.ts
│   │       └── store.test.ts
│   └── test/
│       ├── setup.ts              # Frontend test setup (jsdom, MSW)
│       ├── msw-handlers.ts       # Default MSW request handlers
│       └── render.tsx            # Custom render with providers
├── bridgeport-agent/
│   ├── collector/
│   │   ├── system.go
│   │   ├── system_test.go        # ← Go convention: _test.go
│   │   ├── docker.go
│   │   └── docker_test.go
│   └── main_test.go
└── cli/
    ├── cmd/
    │   ├── login.go
    │   ├── login_test.go
    │   └── ...
    └── internal/
        ├── api/
        │   ├── client.go
        │   └── client_test.go
        └── ...
```

---

## 5. Backend Testing

### 5.1 Library/Utility Tests (`src/lib/`)

**What to test:**
- `crypto.ts`: Encrypt/decrypt round-trips, empty strings, large payloads, wrong key rejection, nonce uniqueness
- `docker.ts`: Command construction, response parsing, error mapping (mock the socket/SSH layer)
- `ssh.ts`: Connection setup, command execution, key parsing (mock the SSH library)
- `scheduler.ts`: Job registration, interval firing with fake timers, overlapping execution prevention, error isolation between jobs
- `registry.ts`: Client factory selection, request construction, response parsing per registry type
- `image-utils.ts`: Image name parsing edge cases (with/without registry, tag, digest, port numbers)
- `config.ts`: Zod schema validation for all env var combinations, defaults, error messages

**Pattern:**
```typescript
// src/lib/crypto.test.ts
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from './crypto.js';

describe('crypto', () => {
  describe('encrypt/decrypt round-trip', () => {
    it('should round-trip a normal string', () => {
      const plaintext = 'my-secret-value';
      const encrypted = encrypt(plaintext);
      expect(decrypt(encrypted)).toBe(plaintext);
    });

    it('should produce different ciphertexts for the same input (unique nonce)', () => {
      const encrypted1 = encrypt('same-input');
      const encrypted2 = encrypt('same-input');
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should handle empty string', () => {
      expect(decrypt(encrypt(''))).toBe('');
    });

    it('should reject tampered ciphertext', () => {
      const encrypted = encrypt('secret');
      const tampered = encrypted.slice(0, -2) + 'xx';
      expect(() => decrypt(tampered)).toThrow();
    });
  });
});
```

### 5.2 Service Layer Tests (`src/services/`)

**What to test:**
- `deploy.ts`: Deployment flow (pull → stop → start → verify), error at each stage, log capture
- `orchestration.ts`: **Full simulation** — dependency graph resolution, topological sort, cycle detection, parallel step execution, failure at each step triggering rollback cascade, partial success scenarios
- `health-checks.ts`: Health check execution, retry logic, timeout handling, scheduler config derivation
- `health-verification.ts`: Post-deploy verification with retries, success/failure thresholds
- `notifications.ts`: Full delivery pipeline — event → type matching → preference filtering → bounce logic → channel dispatch
- `bounce-tracker.ts`: Consecutive failure counting, threshold breach, recovery reset, alert storm prevention
- `metrics.ts`: SSH command construction for metric collection, response parsing, error handling
- `database-backup.ts`: Backup flow, progress tracking, error handling
- `database-monitoring-collector.ts`: Collection scheduling with fake timers, per-database intervals, concurrent collection prevention
- `database-query-executor.ts`: SQL mode query execution, SSH mode command execution, result type handling (scalar/row/rows)
- `compose.ts`: Template rendering with placeholder substitution, artifact generation
- `image-management.ts`: CRUD operations, tag history tracking, auto-update logic
- `auth.ts`: User creation, admin bootstrap, password hashing verification
- `plugin-loader.ts`: Plugin sync logic, customization preservation, merge behavior
- `environment-settings.ts`: Default creation, module registration, validation
- `email.ts`: SMTP transport construction, template rendering, error handling
- `slack-notifications.ts`: Webhook payload construction, delivery, error handling
- `outgoing-webhooks.ts`: Webhook delivery with retries, filtering, payload construction
- `agent-deploy.ts`: Agent binary transfer, SSH deployment flow
- `servers.ts`, `services.ts`, `secrets.ts`, `registries.ts`: CRUD helpers with proper validation

**Orchestration simulation pattern:**
```typescript
// src/services/orchestration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDeploymentPlan, executePlan } from './orchestration.js';
import { createMockDocker } from '../../tests/mocks/docker.js';
import { createTestScenario } from '../../tests/scenarios/healthy-deployment.js';

describe('orchestration', () => {
  describe('buildDeploymentPlan', () => {
    it('should resolve linear dependency chain into correct order', async () => {
      // A depends on B depends on C → deploy order: C, B, A
      const { services, dependencies } = await createLinearChain(3);
      const plan = await buildDeploymentPlan(services, dependencies);

      expect(plan.steps.map(s => s.serviceId)).toEqual([
        services[2].id, // C
        services[1].id, // B
        services[0].id, // A
      ]);
    });

    it('should detect circular dependencies and reject', async () => {
      const { services, dependencies } = await createCircularDeps();
      await expect(buildDeploymentPlan(services, dependencies))
        .rejects.toThrow(/circular/i);
    });

    it('should group independent services for parallel execution', async () => {
      // A and B are independent, both depend on C
      const { services, dependencies } = await createDiamondDeps();
      const plan = await buildDeploymentPlan(services, dependencies);

      // C first, then A and B in same level
      expect(plan.steps[0].serviceId).toBe(services[2].id); // C
      expect(plan.steps[1].level).toBe(plan.steps[2].level); // A & B same level
    });
  });

  describe('executePlan', () => {
    it('should roll back all deployed services when one fails', async () => {
      const docker = createMockDocker();
      const plan = await createThreeServicePlan();

      // Service 2 fails during deploy
      docker.failOnContainer(plan.steps[1].containerId);

      const result = await executePlan(plan, { docker });

      expect(result.status).toBe('failed');
      // Service 1 (already deployed) should be rolled back
      expect(result.steps[0].status).toBe('rolled_back');
      // Service 2 should be marked failed
      expect(result.steps[1].status).toBe('failed');
      // Service 3 should never have started
      expect(result.steps[2].status).toBe('skipped');
    });

    it('should handle health check failure after successful deploy', async () => {
      const docker = createMockDocker();
      const plan = await createPlanWithHealthChecks();

      // Deploy succeeds but health check fails
      docker.setHealthCheckResult(plan.steps[0].serviceId, false);

      const result = await executePlan(plan, { docker });

      expect(result.steps[0].deployStatus).toBe('success');
      expect(result.steps[0].healthCheckStatus).toBe('failed');
      expect(result.status).toBe('failed');
    });
  });
});
```

### 5.3 Route Tests (`src/routes/`)

All API routes tested via `fastify.inject()` — in-process, no port binding, fast.

**What to test per route file:**
- Happy path for each endpoint
- Authentication required (401 without token)
- Authorization (403 for wrong role)
- Input validation (400 for bad payloads)
- Not found (404)
- Correct response shape and status codes
- Side effects (database writes, audit log entries, notifications triggered)

**Routes to test:**
- `auth.ts`: Login, token refresh, invalid credentials, expired tokens
- `users.ts`: CRUD with RBAC enforcement (admin-only create, self-edit profile)
- `environments.ts`: CRUD, cascading settings creation
- `environment-settings.ts`: GET/PATCH per module, reset to defaults, admin-only
- `servers.ts`: CRUD, Docker mode selection, metrics mode toggle
- `services.ts`: CRUD with ContainerImage linking, container discovery
- `secrets.ts`: CRUD with encryption verification, neverReveal enforcement, env templates
- `config-files.ts`: CRUD with history tracking, binary support
- `registries.ts`: CRUD, connection testing
- `container-images.ts`: CRUD, tag checking, deploy triggers, auto-update
- `service-dependencies.ts`: CRUD, cycle prevention
- `deployment-plans.ts`: Plan creation, execution trigger, status polling
- `compose.ts`: Template preview, generation
- `databases.ts`: CRUD, backup management, monitoring toggle
- `metrics.ts`: Agent ingest, metric queries, time range filtering
- `monitoring.ts`: Health logs, metrics history, SSH test, overview
- `topology.ts`: Connection CRUD, layout save/load
- `notifications.ts`: Inbox query, preferences CRUD, mark read
- `settings.ts`: Service type CRUD
- `spaces.ts`: Spaces config CRUD
- `system-settings.ts`: System settings GET/PATCH
- `audit.ts`: Audit log query with filtering
- `webhooks.ts`: Incoming CI/CD webhook handling
- `downloads.ts`: Binary download serving
- `admin/smtp.ts`: SMTP config CRUD, test email
- `admin/webhooks.ts`: Outgoing webhook CRUD, test delivery
- `admin/slack.ts`: Slack channel CRUD, routing config

**Pattern:**
```typescript
// src/routes/auth.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';

describe('POST /api/auth/login', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp();
    await createTestUser(app.prisma, {
      email: 'admin@test.com',
      password: 'correct-password',
      role: 'admin',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return JWT on valid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@test.com', password: 'correct-password' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('token');
    expect(res.json()).toHaveProperty('user.email', 'admin@test.com');
  });

  it('should reject invalid password with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@test.com', password: 'wrong' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('should reject non-existent user with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@test.com', password: 'anything' },
    });

    expect(res.statusCode).toBe(401);
  });
});
```

### 5.4 Scheduler Tests

Use Vitest fake timers to test scheduling mechanics without real delays.

```typescript
// src/lib/scheduler.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should fire jobs at configured intervals', async () => {
    const handler = vi.fn();
    scheduler.register('test-job', handler, { intervalSeconds: 60 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should not overlap executions of the same job', async () => {
    let running = 0;
    let maxConcurrent = 0;

    const slowHandler = vi.fn(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(r => setTimeout(r, 120_000)); // Takes longer than interval
      running--;
    });

    scheduler.register('slow-job', slowHandler, { intervalSeconds: 60 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(180_000);
    expect(maxConcurrent).toBe(1);
  });

  it('should isolate job failures — one failing job does not block others', async () => {
    const failingJob = vi.fn().mockRejectedValue(new Error('boom'));
    const healthyJob = vi.fn();

    scheduler.register('failing', failingJob, { intervalSeconds: 60 });
    scheduler.register('healthy', healthyJob, { intervalSeconds: 60 });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(failingJob).toHaveBeenCalled();
    expect(healthyJob).toHaveBeenCalled();
  });
});
```

### 5.5 SSE (Server-Sent Events) Tests

**Connection lifecycle:**
```typescript
describe('SSE /api/deployments/:id/stream', () => {
  it('should open SSE connection and set correct headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/deployments/${deploymentId}/stream`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['connection']).toBe('keep-alive');
  });
});
```

**Event content accuracy:**
```typescript
it('should emit deployment progress events with correct data', async () => {
  const events = await collectSSEEvents(app, deploymentId, token, {
    untilEvent: 'deployment:complete',
    timeout: 5000,
  });

  expect(events).toContainEqual(
    expect.objectContaining({
      event: 'deployment:step',
      data: expect.objectContaining({
        stepId: expect.any(String),
        status: 'running',
      }),
    })
  );
});
```

**Client reconnection:**
```typescript
it('should support Last-Event-ID for reconnection', async () => {
  // Collect first batch of events
  const batch1 = await collectSSEEvents(app, deploymentId, token, { count: 3 });
  const lastId = batch1[batch1.length - 1].id;

  // Reconnect with Last-Event-ID
  const batch2 = await collectSSEEvents(app, deploymentId, token, {
    headers: { 'Last-Event-ID': lastId },
    count: 3,
  });

  // Should not repeat events before lastId
  const batch2Ids = batch2.map(e => e.id);
  const batch1Ids = batch1.map(e => e.id);
  expect(batch2Ids).not.toContain(batch1Ids[0]);
});
```

### 5.6 Notification Pipeline Tests

Test the full delivery pipeline end-to-end:

```typescript
describe('notification delivery pipeline', () => {
  it('should deliver to all enabled channels per user preference', async () => {
    // Setup: user prefers in-app + email for deployment_success
    await setNotificationPreference(userId, 'deployment_success', {
      inApp: true,
      email: true,
      webhook: false,
      slack: false,
    });

    // Trigger
    await sendNotification('deployment_success', {
      serviceName: 'api',
      tag: 'v1.2.3',
      environmentId,
    });

    // Verify in-app notification created
    const inAppNotifs = await prisma.notification.findMany({
      where: { userId, type: 'deployment_success' },
    });
    expect(inAppNotifs).toHaveLength(1);

    // Verify email sent (mock)
    expect(mockSmtp.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: expect.stringContaining('@'),
        subject: expect.stringContaining('api'),
      })
    );

    // Verify webhook NOT called
    expect(mockWebhook.deliver).not.toHaveBeenCalled();
  });

  it('should suppress notifications during bounce period', async () => {
    // Trigger 5 consecutive failures (bounce threshold)
    for (let i = 0; i < 5; i++) {
      await sendNotification('health_check_failed', {
        serviceName: 'api',
        environmentId,
      });
    }

    // 6th should be suppressed
    await sendNotification('health_check_failed', {
      serviceName: 'api',
      environmentId,
    });

    const notifs = await prisma.notification.findMany({
      where: { type: 'health_check_failed' },
    });
    expect(notifs).toHaveLength(5); // Not 6
  });
});
```

---

## 6. Frontend Testing

### 6.1 Setup

- **Vitest** with `jsdom` environment
- **MSW** for API mocking (intercepts `fetch` at the network level)
- **Custom render** wrapper providing Router + Zustand store + query client

```typescript
// ui/test/render.tsx
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: RenderOptions & { route?: string }
) {
  const queryClient = createTestQueryClient();

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[options?.route ?? '/']}>
        {ui}
      </MemoryRouter>
    </QueryClientProvider>,
    options
  );
}
```

### 6.2 Component Tests

**What to test:**
- Rendering with various props/states
- User interaction (clicks, form submissions, toggles)
- Loading/empty/error states
- Conditional rendering (role-based, feature flags)
- Zustand store interactions (preferences persist, state updates)

**Components to test:**
- `Layout.tsx`: Sidebar rendering, env selector, navigation group collapse, role-based visibility
- `AdminLayout.tsx` / `AdminSidebar.tsx`: Admin navigation, active state
- `TopBar.tsx` / `Breadcrumbs.tsx`: Breadcrumb generation from routes
- `NotificationBell.tsx`: Unread count badge, dropdown toggle, mark-read
- `DependencyGraph.tsx` / `DependencyFlow.tsx`: Dependency visualization rendering
- `DeploymentProgress.tsx`: Step status rendering, progress tracking
- `HealthConfigEditor.tsx`: Form validation, save behavior
- `monitoring/ChartCard.tsx`: Chart rendering with data, empty state
- `monitoring/StatCard.tsx`: Value display, color variants
- `monitoring/TimeRangeSelector.tsx`: Selection state, callback
- `topology/*`: Node rendering, connection lines (position math), popover behavior

### 6.3 Page Integration Tests

**What to test:**
- Page renders with API data (MSW provides mock responses)
- Filtering, sorting, pagination
- Create/edit/delete flows (form → API call → UI update)
- Navigation between list → detail pages
- Store persistence (navigate away and back → filters preserved)

**Pages to test:**
- `Dashboard.tsx`: Stats loading, topology diagram rendering
- `Servers.tsx` / `ServerDetail.tsx`: List, create, edit, monitoring card
- `Services.tsx` / `ServiceDetail.tsx`: List, deploy flow, health check display
- `ContainerImages.tsx`: Image list, tag checking, deploy-all flow
- `DeploymentPlans.tsx` / `DeploymentPlanDetail.tsx`: Plan list, progress tracking
- `Registries.tsx`: Registry list, connection test
- `Databases.tsx` / `DatabaseDetail.tsx`: List, backup, monitoring
- `Secrets.tsx`: Create, reveal/hide, neverReveal enforcement
- `ConfigFiles.tsx`: Grid view, file create/edit
- `Settings.tsx`: Tab navigation, settings forms, unsaved changes warning
- `Notifications.tsx`: Inbox filtering, read/unread toggle, preferences
- `Login.tsx`: Login form submission, error display, redirect
- `Monitoring.tsx` and sub-pages: Data display, time range selection, auto-refresh
- Admin pages: Service/database types, users, audit logs, notification config

### 6.4 Store Tests

```typescript
// ui/src/lib/store.test.ts
describe('useAppStore', () => {
  it('should persist environment selection', () => {
    const { result } = renderHook(() => useAppStore());

    act(() => {
      result.current.setSelectedEnvironment('env-123');
    });

    expect(result.current.selectedEnvironment).toBe('env-123');
  });

  it('should persist filter preferences across page navigation', () => {
    const { result } = renderHook(() => useAppStore());

    act(() => {
      result.current.setServicesShowUpdatesOnly(true);
    });

    // Simulate unmount/remount (page navigation)
    const { result: result2 } = renderHook(() => useAppStore());
    expect(result2.current.servicesShowUpdatesOnly).toBe(true);
  });
});
```

### 6.5 API Client Tests

```typescript
// ui/src/lib/api.test.ts
describe('api client', () => {
  it('should attach Authorization header from stored token', async () => {
    const request = interceptNextRequest();
    await api.get('/api/servers');

    expect(request.headers.get('Authorization')).toMatch(/^Bearer /);
  });

  it('should redirect to login on 401 response', async () => {
    server.use(
      rest.get('/api/servers', (req, res, ctx) => res(ctx.status(401)))
    );

    await api.get('/api/servers');
    expect(window.location.pathname).toBe('/login');
  });
});
```

---

## 7. Go Component Testing

### 7.1 Agent (`bridgeport-agent/`)

**What to test:**
- `collector/system.go`: CPU, memory, disk, load parsing from `/proc` and system commands
- `collector/docker.go`: Container metric parsing from Docker API responses
- `main.go`: Agent startup, ingest payload construction, HTTP client error handling

**Pattern (table-driven):**
```go
// collector/system_test.go
func TestParseCPUUsage(t *testing.T) {
    tests := []struct {
        name     string
        input    string
        expected float64
        wantErr  bool
    }{
        {"normal usage", "cpu  1000 200 300 7500 ...", 16.67, false},
        {"100% usage", "cpu  10000 0 0 0 ...", 100.0, false},
        {"empty input", "", 0, true},
        {"malformed", "not cpu data", 0, true},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            result, err := parseCPUUsage(tt.input)
            if tt.wantErr {
                assert.Error(t, err)
            } else {
                assert.NoError(t, err)
                assert.InDelta(t, tt.expected, result, 0.1)
            }
        })
    }
}
```

**HTTP ingest test:**
```go
// main_test.go
func TestIngestPayload(t *testing.T) {
    var received IngestPayload
    ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        assert.Equal(t, "POST", r.Method)
        assert.Equal(t, "application/json", r.Header.Get("Content-Type"))
        json.NewDecoder(r.Body).Decode(&received)
        w.WriteHeader(200)
    }))
    defer ts.Close()

    agent := NewAgent(ts.URL, "test-token")
    err := agent.SendMetrics(testMetrics)
    assert.NoError(t, err)
    assert.Equal(t, testMetrics.CPU, received.CPU)
}
```

### 7.2 CLI (`cli/`)

**What to test:**
- `cmd/*.go`: Command parsing, flag handling, output formatting
- `internal/api/`: API client request construction, response parsing, auth token handling
- `internal/config/`: Config file read/write, credential storage
- `internal/ssh/`: SSH connection setup, command execution (mock SSH server)
- `internal/docker/`: Docker command construction via SSH
- `internal/output/`: Table formatting, color output

**CLI command test pattern:**
```go
// cmd/list_test.go
func TestListCommand(t *testing.T) {
    ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        assert.Equal(t, "/api/servers", r.URL.Path)
        json.NewEncoder(w).Encode([]Server{
            {Name: "web-01", Status: "healthy"},
            {Name: "db-01", Status: "unhealthy"},
        })
    }))
    defer ts.Close()

    buf := new(bytes.Buffer)
    cmd := NewListCmd()
    cmd.SetOut(buf)
    cmd.SetArgs([]string{"--server-url", ts.URL})

    err := cmd.Execute()
    assert.NoError(t, err)
    assert.Contains(t, buf.String(), "web-01")
    assert.Contains(t, buf.String(), "db-01")
}
```

---

## 8. Security Testing

### 8.1 Cryptography

- Encrypt/decrypt round-trip for all value types (strings, empty, unicode, large payloads)
- Nonce uniqueness (same plaintext produces different ciphertext)
- Tampered ciphertext rejection
- Wrong MASTER_KEY rejection
- Key format validation

### 8.2 Authentication

- JWT issuance with correct claims (userId, role, expiry)
- JWT expiry enforcement (expired token → 401)
- JWT refresh flow (valid refresh → new access token)
- Invalid JWT signature → 401
- Missing Authorization header → 401
- Malformed token (not JWT, wrong format) → 401

### 8.3 Authorization (RBAC)

For each role (`admin`, `operator`, `viewer`), test every route category:

```typescript
describe('RBAC enforcement', () => {
  const routes = [
    { method: 'POST', url: '/api/users', minRole: 'admin' },
    { method: 'POST', url: '/api/servers', minRole: 'operator' },
    { method: 'GET', url: '/api/servers', minRole: 'viewer' },
    { method: 'POST', url: '/api/services/:id/deploy', minRole: 'operator' },
    { method: 'DELETE', url: '/api/environments/:id', minRole: 'admin' },
    // ... all routes
  ];

  for (const route of routes) {
    it(`${route.method} ${route.url} should require ${route.minRole}+`, async () => {
      // Test viewer can't access operator routes
      // Test operator can't access admin routes
      // Test correct role succeeds
    });
  }
});
```

### 8.4 Adversarial Testing

- **Injection attempts**: SQL injection via Prisma (should be safe by design, but verify), XSS in service names/descriptions that render in UI
- **Privilege escalation**: Viewer modifying their own role via user update endpoint, cross-environment data access
- **Token tampering**: Modified JWT payload with elevated role, replayed tokens after password change
- **Secret exfiltration**: `neverReveal` secrets cannot be revealed via any API path, secrets don't leak in logs or error messages
- **IDOR (Insecure Direct Object Reference)**: Accessing resources from other environments, accessing other users' notifications

### 8.5 Audit Log Verification

For every sensitive operation, verify an audit log entry is created:

```typescript
const sensitiveOperations = [
  { action: 'deploy service', auditAction: 'service.deploy' },
  { action: 'create user', auditAction: 'user.create' },
  { action: 'delete environment', auditAction: 'environment.delete' },
  { action: 'reveal secret', auditAction: 'secret.reveal' },
  { action: 'modify system settings', auditAction: 'system-settings.update' },
  // ...
];

for (const op of sensitiveOperations) {
  it(`should audit log: ${op.action}`, async () => {
    // Perform the operation
    await performOperation(op);

    // Verify audit entry
    const auditEntry = await prisma.auditLog.findFirst({
      where: { action: op.auditAction },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditEntry).toBeTruthy();
    expect(auditEntry.userId).toBe(testUserId);
  });
}
```

---

## 9. Migration Testing

### 9.1 Up/Down Cycle

Verify all migrations apply cleanly in sequence on a fresh database:

```typescript
// tests/migrations/migration.test.ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('database migrations', () => {
  it('should apply all migrations to a fresh database', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bp-migration-'));
    const dbPath = join(tmpDir, 'test.db');

    try {
      const result = execSync(
        `DATABASE_URL=file:${dbPath} npx prisma migrate deploy`,
        { encoding: 'utf8', timeout: 30_000 }
      );

      expect(result).toContain('All migrations have been successfully applied');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should produce schema matching prisma schema', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bp-migration-'));
    const dbPath = join(tmpDir, 'test.db');

    try {
      // Apply migrations
      execSync(`DATABASE_URL=file:${dbPath} npx prisma migrate deploy`, {
        encoding: 'utf8',
      });

      // Verify no drift
      const result = execSync(
        `DATABASE_URL=file:${dbPath} npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma`,
        { encoding: 'utf8' }
      );

      // No diff means migrations match schema
      expect(result.trim()).toBe('');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should be idempotent — running deploy twice does not error', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bp-migration-'));
    const dbPath = join(tmpDir, 'test.db');

    try {
      execSync(`DATABASE_URL=file:${dbPath} npx prisma migrate deploy`, {
        encoding: 'utf8',
      });

      // Run again
      const result = execSync(
        `DATABASE_URL=file:${dbPath} npx prisma migrate deploy`,
        { encoding: 'utf8' }
      );

      expect(result).toContain('already been applied');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
```

---

## 10. Test Data Management

### 10.1 Factory Functions

Each factory creates a minimal valid entity with sensible defaults. All required relations are handled automatically.

```typescript
// tests/factories/server.ts
import { prisma } from '../helpers/db.js';
import { createTestEnvironment } from './environment.js';

interface ServerOverrides {
  name?: string;
  host?: string;
  environmentId?: string;
  dockerMode?: 'ssh' | 'socket';
  metricsMode?: 'disabled' | 'ssh' | 'agent';
}

export async function createTestServer(overrides: ServerOverrides = {}) {
  const environmentId = overrides.environmentId
    ?? (await createTestEnvironment()).id;

  return prisma.server.create({
    data: {
      name: overrides.name ?? `server-${randomId()}`,
      host: overrides.host ?? `192.168.1.${randomInt(1, 254)}`,
      port: 22,
      dockerMode: overrides.dockerMode ?? 'ssh',
      metricsMode: overrides.metricsMode ?? 'disabled',
      status: 'healthy',
      environmentId,
    },
  });
}
```

### 10.2 Named Scenarios

For integration tests requiring complex state:

```typescript
// tests/scenarios/healthy-deployment.ts
export async function createHealthyDeploymentScenario() {
  const env = await createTestEnvironment({ name: 'production' });
  const server = await createTestServer({ environmentId: env.id });
  const image = await createTestContainerImage({ name: 'myapp' });
  const service = await createTestService({
    serverId: server.id,
    imageId: image.id,
  });
  const deployment = await createTestDeployment({
    serviceId: service.id,
    status: 'success',
    tag: 'v1.0.0',
  });

  return { env, server, image, service, deployment };
}

// tests/scenarios/failed-rollback.ts
export async function createFailedRollbackScenario() {
  const base = await createHealthyDeploymentScenario();

  // Add a failed deployment with rollback
  const failedDeployment = await createTestDeployment({
    serviceId: base.service.id,
    status: 'failed',
    tag: 'v1.1.0',
  });

  const rollbackDeployment = await createTestDeployment({
    serviceId: base.service.id,
    status: 'success',
    tag: 'v1.0.0',
    isRollback: true,
  });

  return { ...base, failedDeployment, rollbackDeployment };
}
```

### 10.3 Database Helpers

```typescript
// tests/helpers/db.ts
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

let prisma: PrismaClient;

export async function setupTestDb() {
  // Use in-memory SQLite
  process.env.DATABASE_URL = 'file::memory:?cache=shared';

  // Apply schema (not migrations — faster for non-migration tests)
  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });

  prisma = new PrismaClient();
  await prisma.$connect();

  return prisma;
}

export async function teardownTestDb() {
  await prisma.$disconnect();
}

export async function cleanTestDb() {
  // Delete all data between tests (respecting foreign key order)
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_prisma%'
  `;

  await prisma.$executeRaw`PRAGMA defer_foreign_keys = ON`;
  for (const { name } of tables) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${name}"`);
  }
}

export { prisma };
```

---

## 11. Naming Conventions & Organization

### 11.1 File Naming

- Test files: `{source-file}.test.ts` (backend) or `{source-file}.test.tsx` (frontend)
- Test factories: `tests/factories/{entity}.ts`
- Test scenarios: `tests/scenarios/{scenario-name}.ts`
- Test mocks: `tests/mocks/{dependency}.ts`
- Test helpers: `tests/helpers/{purpose}.ts`

### 11.2 Describe Block Structure

```typescript
// Level 1: Module or component name
describe('orchestration', () => {

  // Level 2: Function or method name
  describe('buildDeploymentPlan', () => {

    // Level 3 (optional): Scenario grouping
    describe('when dependencies form a diamond shape', () => {

      // Test: "it should [expected behavior]"
      it('should group independent services at the same level', () => {});
    });
  });
});
```

### 11.3 Test Description Rules

| Pattern | Example | When to use |
|---------|---------|-------------|
| `it('should [verb] [outcome]')` | `it('should return 401 for expired tokens')` | Default for all tests |
| `it('should not [verb]')` | `it('should not allow viewers to deploy')` | Negative/constraint tests |
| `describe('when [condition]')` | `describe('when the service has dependencies')` | Grouping related scenarios |
| `describe('[MethodName]')` | `describe('buildDeploymentPlan')` | Grouping by function |

### 11.4 Assertion Style

- Use `expect(x).toBe(y)` for primitives
- Use `expect(x).toEqual(y)` for objects/arrays
- Use `expect(x).toMatchObject({...})` for partial object matching
- Use `expect(fn).toThrow(/pattern/)` for error assertions
- Use `expect(x).toHaveLength(n)` for collection size
- **Avoid** `toBeTruthy()`/`toBeFalsy()` — use specific assertions (`toBe(true)`, `toBeNull()`, `toBeDefined()`)
- **One logical assertion per test.** Multiple `expect()` calls are fine if they verify the same logical outcome.

### 11.5 Test Organization Within File

```typescript
// 1. Imports
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 2. Shared setup
let app: TestApp;

beforeEach(async () => {
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
});

// 3. Happy path tests first
describe('POST /api/resource', () => {
  it('should create resource with valid input', async () => {});
  it('should return the created resource with ID', async () => {});
});

// 4. Validation/error tests
describe('POST /api/resource - validation', () => {
  it('should reject missing required fields', async () => {});
  it('should reject invalid field values', async () => {});
});

// 5. Auth/authz tests
describe('POST /api/resource - authorization', () => {
  it('should require authentication', async () => {});
  it('should require operator role', async () => {});
});

// 6. Edge cases last
describe('POST /api/resource - edge cases', () => {
  it('should handle concurrent creation gracefully', async () => {});
});
```

---

## 12. Coverage Policy

### 12.1 Differential Coverage (PR Gate)

Every PR must achieve **90%+ line coverage on all changed or new files**. This is enforced in CI.

- Measured via `vitest --coverage --changed` or equivalent codecov/coveralls PR diff analysis
- Applies to both backend and frontend
- Exemptions: generated files (`prisma/client`), type-only files, config files

### 12.2 Coverage Reporting

- Coverage reports generated in CI for every PR
- Uploaded to codecov (or coveralls) for diff analysis
- Coverage badge displayed in README
- No global minimum threshold (avoids gaming the metric)

### 12.3 Coverage Exclusions

Files excluded from coverage requirements:
```
// config/vitest.config.ts coverage.exclude
[
  'prisma/**',
  'test/**',
  '**/types.ts',
  '**/index.ts',         // re-export barrels
  'src/lib/sentry.ts',   // third-party init
  'ui/src/lib/sentry.ts',
]
```

---

## 13. CI/CD Pipeline

### 13.1 GitHub Actions Workflow

```yaml
# .github/workflows/test.yml
name: Test

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]
  schedule:
    - cron: '0 3 * * *'  # Nightly at 3 AM UTC

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # ── Tier 1: Unit Tests (fast, every commit) ──────────────
  unit-backend:
    name: Backend Unit Tests
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npx vitest run --project backend --testPathPattern='src/lib/.*\\.test\\.ts$' --reporter=github-actions

  unit-frontend:
    name: Frontend Unit Tests
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: cd ui && npm ci
      - run: cd ui && npx vitest run --testPathPattern='lib/.*\\.test\\.tsx?$' --reporter=github-actions

  unit-go:
    name: Go Unit Tests
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - run: cd bridgeport-agent && go test ./... -short -count=1
      - run: cd cli && go test ./... -short -count=1

  # ── Tier 2: Integration Tests (every PR) ──────────────
  integration-backend:
    name: Backend Integration Tests
    runs-on: ubuntu-latest
    timeout-minutes: 10
    needs: unit-backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npx vitest run --project backend --coverage --reporter=github-actions
        env:
          MASTER_KEY: test-key-for-ci-only-not-real
          JWT_SECRET: test-jwt-secret-for-ci-only
      - uses: codecov/codecov-action@v4
        with:
          files: coverage/lcov.info
          flags: backend

  integration-frontend:
    name: Frontend Integration Tests
    runs-on: ubuntu-latest
    timeout-minutes: 10
    needs: unit-frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: cd ui && npm ci
      - run: cd ui && npx vitest run --coverage --reporter=github-actions
      - uses: codecov/codecov-action@v4
        with:
          files: ui/coverage/lcov.info
          flags: frontend

  # ── Migration Tests (every PR with schema changes) ──────
  migration:
    name: Migration Tests
    runs-on: ubuntu-latest
    timeout-minutes: 5
    if: |
      github.event_name == 'pull_request' &&
      contains(github.event.pull_request.changed_files, 'prisma/')
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx vitest run tests/migrations/

  # ── Tier 3: System Tests (nightly) ──────────────────────
  system:
    name: System Tests
    runs-on: ubuntu-latest
    timeout-minutes: 15
    if: github.event_name == 'schedule'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - run: npm ci
      - run: npx prisma generate
      - run: npx vitest run --project system
        env:
          MASTER_KEY: test-key-for-ci-only-not-real
          JWT_SECRET: test-jwt-secret-for-ci-only
      - run: cd bridgeport-agent && go test ./... -count=1
      - run: cd cli && go test ./... -count=1

  # ── Build Verification ──────────────────────────────────
  build:
    name: Build Check
    runs-on: ubuntu-latest
    timeout-minutes: 5
    needs: [unit-backend, unit-frontend]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npm run build
      - run: cd ui && npm ci && npm run build

  # ── TypeScript Check ────────────────────────────────────
  typecheck:
    name: TypeScript Check
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx prisma generate
      - run: npx tsc --noEmit
      - run: cd ui && npm ci && npx tsc --noEmit
```

### 13.2 Codecov Configuration

```yaml
# codecov.yml
coverage:
  status:
    project: off  # No global gate
    patch:
      default:
        target: 90%  # 90% on changed files
        threshold: 2%
  flags:
    backend:
      paths:
        - src/
    frontend:
      paths:
        - ui/src/

ignore:
  - prisma/
  - tests/
  - "**/*.d.ts"
  - "**/types.ts"
```

---

## 14. Local Developer Experience

### 14.1 Watch Mode

```bash
# Backend tests in watch mode (re-runs on file change)
npx vitest --project backend

# Frontend tests in watch mode
cd ui && npx vitest

# Run specific test file
npx vitest src/services/deploy.test.ts

# Run tests matching a pattern
npx vitest --testNamePattern="should roll back"
```

### 14.2 Pre-push Hook

Install via `husky` or `lefthook`:

```bash
# .husky/pre-push
#!/bin/sh
npx vitest run --project backend --testPathPattern='src/lib/.*\.test\.ts$' --reporter=dot
cd ui && npx vitest run --testPathPattern='lib/.*\.test\.tsx?$' --reporter=dot
```

This runs only Tier 1 (unit tests) before push — fast enough to not disrupt workflow.

### 14.3 VS Code Integration

```jsonc
// .vscode/settings.json (additions)
{
  "vitest.enable": true,
  "vitest.commandLine": "npx vitest",
  "testing.automaticallyOpenPeekView": "failureVisible"
}
```

Recommended extension: **Vitest** (`vitest.explorer`) — inline test status, click-to-run individual tests.

### 14.4 Package.json Scripts

```jsonc
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run --testPathPattern='src/lib/.*\\.test\\.ts$'",
    "test:integration": "vitest run --project backend",
    "test:coverage": "vitest run --coverage",
    "test:migrations": "vitest run tests/migrations/",
    "test:ui": "cd ui && vitest run",
    "test:ui:watch": "cd ui && vitest",
    "test:all": "vitest run && cd ui && vitest run"
  }
}
```

---

## 15. Implementation Plan

This is a one-shot implementation. Build everything in order — each phase builds on the previous.

### Phase 1: Infrastructure (test tooling + helpers)

1. Install dependencies: `vitest`, `@vitest/coverage-v8`, `@testing-library/react`, `@testing-library/user-event`, `msw`, `@testing-library/jest-dom`
2. Create `config/vitest.config.ts` (backend) and `ui/vitest.config.ts` (frontend)
3. Create `config/vitest.workspace.ts` for workspace mode
4. Create `tests/setup.ts` — global setup (env vars, mock MASTER_KEY/JWT_SECRET)
5. Create `tests/helpers/db.ts` — in-memory Prisma client
6. Create `tests/helpers/app.ts` — Fastify test app builder
7. Create `tests/helpers/auth.ts` — JWT token generation for tests
8. Create `tests/helpers/sse.ts` — SSE response parser
9. Create `tests/mocks/` — Docker, SSH, registry, SMTP, Slack, Spaces mocks
10. Create `ui/test/setup.ts` — frontend test setup (jsdom, MSW)
11. Create `ui/test/render.tsx` — custom render with providers
12. Create `ui/test/msw-handlers.ts` — default API mock handlers

### Phase 2: Test Data (factories + scenarios)

13. Create all factory functions in `tests/factories/`
14. Create named scenarios in `tests/scenarios/`
15. Verify factories work by writing a smoke test

### Phase 3: Backend Unit Tests (`src/lib/`)

16. `crypto.test.ts` — encryption/decryption
17. `config.test.ts` — Zod schema validation
18. `image-utils.test.ts` — image name parsing
19. `docker.test.ts` — Docker client
20. `ssh.test.ts` — SSH client
21. `scheduler.test.ts` — scheduler with fake timers
22. `registry.test.ts` — registry client factory

### Phase 4: Backend Service Tests (`src/services/`)

23. `deploy.test.ts` — deployment flow
24. `orchestration.test.ts` — full simulation with rollback
25. `health-checks.test.ts` — health check logic
26. `health-verification.test.ts` — post-deploy verification
27. `notifications.test.ts` — delivery pipeline
28. `bounce-tracker.test.ts` — bounce logic
29. `metrics.test.ts` — metric collection
30. `database-backup.test.ts` — backup flow
31. `database-monitoring-collector.test.ts` — collection scheduling
32. `database-query-executor.test.ts` — query execution
33. `compose.test.ts` — template rendering
34. `image-management.test.ts` — image CRUD
35. `auth.test.ts` — user management
36. `plugin-loader.test.ts` — plugin sync
37. `environment-settings.test.ts` — settings CRUD
38. `email.test.ts` — SMTP
39. `slack-notifications.test.ts` — Slack
40. `outgoing-webhooks.test.ts` — webhook delivery
41. `agent-deploy.test.ts` — agent deployment
42. `audit.test.ts` — audit logging
43. `servers.test.ts`, `services.test.ts`, `secrets.test.ts`, `registries.test.ts` — CRUD helpers
44. `system-settings.test.ts` — cached singleton
45. `service-types.test.ts` — type utilities

### Phase 5: Backend Route Tests (`src/routes/`)

46. `auth.test.ts` — login, refresh, invalid credentials
47. `users.test.ts` — CRUD + RBAC
48. `environments.test.ts` — CRUD + cascading settings
49. `environment-settings.test.ts` — GET/PATCH/reset
50. `servers.test.ts` — CRUD + modes
51. `services.test.ts` — CRUD + discovery
52. `secrets.test.ts` — CRUD + encryption + neverReveal
53. `config-files.test.ts` — CRUD + history
54. `registries.test.ts` — CRUD + connection test
55. `container-images.test.ts` — CRUD + deploy triggers
56. `service-dependencies.test.ts` — CRUD + cycle prevention
57. `deployment-plans.test.ts` — creation + execution
58. `compose.test.ts` — preview + generation
59. `databases.test.ts` — CRUD + backups + monitoring
60. `metrics.test.ts` — ingest + queries
61. `monitoring.test.ts` — health logs + metrics history + SSE
62. `topology.test.ts` — connections + layout
63. `notifications.test.ts` — inbox + preferences
64. `settings.test.ts` — service types
65. `spaces.test.ts` — Spaces config
66. `system-settings.test.ts` — system settings
67. `audit.test.ts` — log queries
68. `webhooks.test.ts` — incoming webhooks
69. `downloads.test.ts` — binary downloads
70. `admin/smtp.test.ts` — SMTP config
71. `admin/webhooks.test.ts` — outgoing webhooks
72. `admin/slack.test.ts` — Slack config

### Phase 6: Security Tests

73. RBAC matrix test (all routes × all roles)
74. Token tampering tests
75. Privilege escalation tests
76. IDOR tests
77. Audit log verification tests
78. Secret exfiltration tests

### Phase 7: Migration Tests

79. `tests/migrations/migration.test.ts` — up/down cycle, idempotency, schema match

### Phase 8: Frontend Tests

80. `ui/src/lib/api.test.ts` — API client
81. `ui/src/lib/store.test.ts` — Zustand stores
82. `ui/src/lib/status.test.ts` — status utilities
83. `ui/src/lib/topology.test.ts` — topology helpers
84. Component tests for all components in `ui/src/components/`
85. Page integration tests for all pages in `ui/src/pages/`

### Phase 9: Go Tests

86. `bridgeport-agent/collector/system_test.go`
87. `bridgeport-agent/collector/docker_test.go`
88. `bridgeport-agent/main_test.go`
89. `cli/cmd/*_test.go` (all commands)
90. `cli/internal/api/client_test.go`
91. `cli/internal/config/*_test.go`
92. `cli/internal/output/*_test.go`

### Phase 10: CI/CD + DX

93. Create `.github/workflows/test.yml`
94. Create `codecov.yml`
95. Add npm scripts to `package.json`
96. Configure pre-push hook
97. Add VS Code settings

---

## Summary

| Aspect | Decision |
|--------|----------|
| **Runner** | Vitest (backend + frontend), go test (Go) |
| **External deps** | All mocked |
| **Database** | In-memory SQLite (tests), temp file (migrations) |
| **API testing** | `fastify.inject()` (in-process) |
| **Frontend** | @testing-library/react + MSW |
| **Test data** | Factory functions + named scenarios |
| **Coverage** | Differential: 90%+ on changed files |
| **CI tiers** | Commit: unit (<30s), PR: integration (<2min), Nightly: system (<10min) |
| **File location** | Colocated (`*.test.ts` next to source) |
| **Conventions** | Strict: describe/it patterns, assertion style, file organization |
| **Go** | Standard go test, table-driven, testify, httptest |
| **Security** | Crypto, auth, RBAC matrix, adversarial, audit verification |
| **Migrations** | Up/down cycle, idempotency, schema drift detection |
| **Timeline** | One-shot implementation |
