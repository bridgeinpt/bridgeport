# Testing Guide

BridgePort uses Vitest with **two separate configs** that must never be mixed:

| Config | Scope | Isolation | Database |
|--------|-------|-----------|----------|
| `config/vitest.config.ts` | Integration tests (`src/routes/`, `tests/`) | `isolate: false`, `maxWorkers: 1` | Real SQLite |
| `config/vitest.unit.config.ts` | Unit tests (`src/services/`, `src/lib/`) | `isolate: true` | Mocked via `vi.mock` |

**Why two configs?** Integration tests share a real SQLite database and need `isolate: false` so the singleton PrismaClient stays alive across files. Unit tests use `vi.mock('../lib/db.js')` to mock Prisma, and need `isolate: true` so mocks don't leak between files. Mixing them in one process causes data races or mock pollution.

## Running Tests

```bash
# Integration tests (routes, security, smoke)
npx vitest run --config config/vitest.config.ts

# Unit tests (services, lib)
npx vitest run --config config/vitest.unit.config.ts

# Single test file
npx vitest run src/routes/auth.test.ts

# Watch mode
npx vitest --watch src/routes/auth.test.ts
```

## Test File Placement

- **Route tests**: `src/routes/<name>.test.ts` (next to the route file)
- **Service unit tests**: `src/services/<name>.test.ts` (next to the service file)
- **Lib unit tests**: `src/lib/<name>.test.ts`
- **Security tests**: `tests/security/<name>.test.ts`
- **Smoke tests**: `tests/smoke.test.ts`

## Writing Integration Tests (Routes)

Integration tests use a real Fastify instance with all routes registered, backed by a real SQLite database.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, type TestApp } from '../../tests/helpers/app.js';
import { createTestUser } from '../../tests/factories/user.js';
import { createTestEnvironment } from '../../tests/factories/environment.js';
import { generateTestToken } from '../../tests/helpers/auth.js';

describe('example routes', () => {
  let app: TestApp;
  let adminToken: string;
  let viewerToken: string;
  let envId: string;

  beforeAll(async () => {
    app = await buildTestApp();

    // Use unique emails per test file to avoid conflicts with other files
    const admin = await createTestUser(app.prisma, { email: 'admin@example.test', role: 'admin' });
    const viewer = await createTestUser(app.prisma, { email: 'viewer@example.test', role: 'viewer' });
    adminToken = await generateTestToken({ id: admin.id, email: admin.email });
    viewerToken = await generateTestToken({ id: viewer.id, email: viewer.email });

    const env = await createTestEnvironment(app.prisma, { name: 'example-env' });
    envId = env.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/environments/:envId/things', () => {
    it('should list things', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/things`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('things');
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${envId}/things`,
      });

      expect(res.statusCode).toBe(401);
    });

    it('should reject viewer for admin-only route', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/environments/${envId}/things`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'test' },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
```

**Key rules for integration tests:**

1. **Use `buildTestApp()`** — creates a fully-configured Fastify instance with all routes
2. **Use `app.inject()`** — Fastify's built-in HTTP injection (no real server needed)
3. **Use factories** — `createTestUser`, `createTestEnvironment`, `createTestServer`, `createTestContainerImage`, `createTestService` for test data setup
4. **Use unique emails** per test file (e.g., `admin@myfeature.test`) to avoid conflicts since all test files share one database
5. **Always test**: happy path, authentication (401), authorization (403), validation (400), and not-found (404)
6. **Use `app.prisma`** for direct database assertions or extra setup
7. **Match actual route URLs** — check the route file for exact paths (e.g., `/api/settings/system` not `/api/system-settings`)
8. **Match actual field names** — check the Prisma schema and Zod validation for correct request/response shapes

## Writing Unit Tests (Services)

Unit tests mock all dependencies (especially Prisma) and test business logic in isolation.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Hoist mocks BEFORE imports
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    myModel: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// 2. Mock the db module
vi.mock('../lib/db.js', () => ({ prisma: mockPrisma }));

// 3. Import the module under test AFTER mocking
import { createThing, listThings } from './my-service.js';

describe('my-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a thing', async () => {
    mockPrisma.myModel.create.mockResolvedValue({ id: '1', name: 'test' });

    const result = await createThing({ name: 'test' });

    expect(result).toMatchObject({ id: '1', name: 'test' });
    expect(mockPrisma.myModel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'test' }),
    });
  });
});
```

**Key rules for unit tests:**

1. **Use `vi.hoisted()`** to define mocks before any module imports
2. **Use `vi.mock('../lib/db.js')`** to replace the Prisma singleton
3. **Import the module under test AFTER `vi.mock()` calls**
4. **Use `vi.clearAllMocks()`** in `beforeEach`
5. **Mock only what's needed** — only the Prisma models/methods your service uses
6. **Also mock other services** if your service imports them (e.g., `vi.mock('./audit.js')`)

## Available Factories

All factories are in `tests/factories/` and can be imported from `tests/factories/index.js`:

| Factory | Required Fields | Default Role/Type |
|---------|----------------|-------------------|
| `createTestUser(prisma, opts)` | — | `role: 'admin'`, `password: 'test-password-123'` |
| `createTestEnvironment(prisma, opts)` | — | Auto-named `test-env-N` |
| `createTestServer(prisma, opts)` | `environmentId` | `dockerMode: 'ssh'` |
| `createTestContainerImage(prisma, opts)` | `environmentId` | `currentTag: 'latest'` |
| `createTestService(prisma, opts)` | `serverId`, `containerImageId` | Auto-named `service-N` |

Every `Service` requires a `ContainerImage` — always create the image first.

## What to Test for New Routes

For every new API route, test at minimum:

1. **Happy path** — correct response status and shape
2. **Authentication** — returns 401 without token
3. **Authorization** — returns 403 for insufficient role (if route uses `requireAdmin`/`requireOperator`)
4. **Validation** — returns 400 for invalid input (if route validates body/params)
5. **Not found** — returns 404 for non-existent resources
6. **Conflicts** — returns 409 for duplicate entries (if applicable)
7. **Add to security tests** — add the route to `tests/security/rbac-matrix.test.ts` in the appropriate role array (`adminRoutes`, `operatorRoutes`, or `viewerRoutes`)

## What to Test for Bug Fixes

1. **Reproduce the bug** — write a failing test that demonstrates the bug
2. **Fix the code** — make the test pass
3. **Keep the test** — it serves as regression protection
