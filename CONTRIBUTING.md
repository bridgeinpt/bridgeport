# Contributing to BRIDGEPORT

Thank you for your interest in contributing to BRIDGEPORT! Whether you're fixing a bug, adding a feature, improving documentation, or creating a plugin, we appreciate the help.

## Table of Contents

- [Welcome](#welcome)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Database Migration Guide](#database-migration-guide)
- [Code Style](#code-style)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Common Pitfalls](#common-pitfalls)
- [Getting Help](#getting-help)

## Welcome

BRIDGEPORT is a lightweight, self-hosted deployment management tool for Docker-based infrastructure. We welcome contributions of all kinds:

- **Bug fixes** -- found something broken? We'd love a fix (and a test!)
- **Features** -- have an idea? Open an issue first so we can discuss the approach
- **Documentation** -- clearer docs help everyone
- **Plugins** -- new service types or database types (JSON definitions in `plugins/`)
- **Tests** -- more coverage is always welcome

## Development Setup

### Prerequisites

| Tool | Version | Used For |
|------|---------|----------|
| Node.js | 20+ | Backend and frontend |
| npm | 9+ | Package management |
| Go | 1.21+ | Monitoring agent and CLI (optional) |
| Docker | 20+ | Running BRIDGEPORT in containers (optional) |

### Clone and Install

```bash
git clone https://github.com/bridgeinpt/bridgeport.git
cd bridgeport

# Install backend dependencies
npm install

# Install frontend dependencies
cd ui && npm install && cd ..
```

### Configure Environment

Create a `.env` file in the project root:

```bash
DATABASE_URL=file:./dev.db
MASTER_KEY=$(openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 32)

# Optional: seed an admin user on first boot
ADMIN_EMAIL=admin@local.test
ADMIN_PASSWORD=password123
```

### Initialize the Database

```bash
# Generate Prisma client
npm run db:generate

# Run migrations (creates dev.db)
npx prisma migrate dev
```

### Start Development Servers

You need two terminals:

**Terminal 1 -- Backend (port 3000):**

```bash
npm run dev
```

Expected output:

```
Server listening on http://0.0.0.0:3000
Plugins synced successfully
```

**Terminal 2 -- Frontend (port 5173):**

```bash
cd ui && npm run dev
```

Expected output:

```
VITE v5.x.x  ready in xxx ms

  ➜  Local:   http://localhost:5173/
```

Open [http://localhost:5173](http://localhost:5173) in your browser. The frontend proxies API requests to the backend on port 3000.

### Building the Agent and CLI (Optional)

If you're working on the Go components:

```bash
# Build the monitoring agent
cd bridgeport-agent && make build && cd ..

# Build the CLI
cd cli && make build && cd ..
```

## Development Workflow

### Branch Naming

Use descriptive branch names with a prefix:

| Prefix | Use For | Example |
|--------|---------|---------|
| `feature/` | New features | `feature/slack-notifications` |
| `fix/` | Bug fixes | `fix/health-check-timeout` |
| `docs/` | Documentation changes | `docs/monitoring-guide` |
| `refactor/` | Code improvements | `refactor/deploy-service` |
| `test/` | Test additions | `test/registry-routes` |

### Making Changes

1. Create a branch from `master`:
   ```bash
   git checkout master && git pull
   git checkout -b feature/my-feature
   ```

2. Make your changes with small, focused commits.

3. Run the relevant tests (see [Testing](#testing)).

4. Push and open a pull request.

### Running Checks Before Committing

```bash
# Build backend (type-check)
npm run build

# Build frontend
cd ui && npm run build && cd ..

# Run integration tests
npx vitest run --config config/vitest.config.ts

# Run unit tests
npx vitest run --config config/vitest.unit.config.ts
```

## Database Migration Guide

BRIDGEPORT uses Prisma with SQLite. Schema changes must include migrations so that deployed containers automatically update their database on restart.

> [!WARNING]
> Never use `npx prisma db push` for schema changes. It bypasses the migration system and will break production deployments. Always use `npx prisma migrate dev`.

### Quick Steps

1. Edit `prisma/schema.prisma`
2. Create a migration:
   ```bash
   npx prisma migrate dev --name descriptive_name
   ```
3. Review the generated SQL in `prisma/migrations/`
4. Test with `npm run dev`
5. Commit both the schema and migration files

For the full migration guide, including handling breaking changes and emergency recovery, see [docs/development/database-migrations.md](docs/development/database-migrations.md).

## Code Style

### TypeScript (Backend)

- **Routes** live in `src/routes/` and export a Fastify plugin
- **Business logic** lives in `src/services/` -- keep routes thin
- **Database access** via `import { prisma } from '../lib/db.js'`
- Use Zod for request validation
- Use `requireAdmin` or `requireOperator` from `src/plugins/authorize.js` for protected routes

```typescript
// Route pattern
export default async function (fastify: FastifyInstance) {
  fastify.get('/api/example',
    { preHandler: [fastify.authenticate, requireOperator] },
    async (request, reply) => {
      // Validate, call service, return response
    }
  );
}
```

### React (Frontend)

- **Pages** live in `ui/src/pages/`
- **Components** live in `ui/src/components/`
- **State** is managed with Zustand stores in `ui/src/lib/store.ts`
- **API calls** go through `ui/src/lib/api.ts`
- Use Tailwind CSS for styling
- Persist user preferences to localStorage via Zustand's `persist` middleware

### Prisma

- Always use `prisma migrate dev` for schema changes, never `prisma db push`
- Commit migration files alongside schema changes
- Use `connect` pattern for relations in create operations

## Testing

BRIDGEPORT has two separate test configurations that must not be mixed:

| Config | Scope | Command |
|--------|-------|---------|
| `config/vitest.config.ts` | Integration tests (routes, API) | `npx vitest run --config config/vitest.config.ts` |
| `config/vitest.unit.config.ts` | Unit tests (services, lib) | `npx vitest run --config config/vitest.unit.config.ts` |

### Running Tests

```bash
# All integration tests
npx vitest run --config config/vitest.config.ts

# All unit tests
npx vitest run --config config/vitest.unit.config.ts

# Single test file
npx vitest run src/routes/auth.test.ts

# Watch mode for active development
npx vitest --watch src/routes/auth.test.ts
```

### Writing Tests

- **Route tests** go next to the route file: `src/routes/my-route.test.ts`
- **Service tests** go next to the service file: `src/services/my-service.test.ts`
- Use unique emails per test file (e.g., `admin@myfeature.test`) to avoid conflicts
- Every new route needs tests for: happy path, 401 (no auth), 403 (wrong role), 400 (bad input), 404 (not found)
- Every bug fix should include a regression test

For detailed patterns and examples, see the Testing section in [CLAUDE.md](CLAUDE.md).

## Pull Request Process

1. **Open an issue first** for significant features -- let's discuss the approach before you invest time
2. **Keep PRs focused** -- one feature or fix per PR
3. **Write tests** -- new features need tests, bug fixes need regression tests
4. **Update docs** if your change affects user-facing behavior
5. **Include migration files** if you changed the Prisma schema
6. **Describe your changes** in the PR description -- what and why, not just how

### PR Checklist

- [ ] Tests pass (`vitest run --config vitest.config.ts` and `vitest run --config vitest.unit.config.ts`)
- [ ] Backend builds (`npm run build`)
- [ ] Frontend builds (`cd ui && npm run build`)
- [ ] New routes added to RBAC security tests (`tests/security/rbac-matrix.test.ts`)
- [ ] Migration files committed (if schema changed)
- [ ] Documentation updated (if behavior changed)

## Common Pitfalls

These are the things that trip up most new contributors:

### Prisma Types in Isolation

Fastify augments `request.authUser` via a plugin decorator. If your editor shows type errors when looking at a single file, that's expected -- the types resolve correctly when the full app is compiled.

### SSH Client Method Name

The SSH `CommandClient` uses `exec()`, not `execute()`:

```typescript
// Correct
const result = await client.exec('docker ps');

// Wrong -- this will not compile
const result = await client.execute('docker ps');
```

### SSH Key Decryption

SSH keys are stored as `nonce:ciphertext`. Never call `decrypt()` directly on the raw value. Use the helper:

```typescript
import { getEnvironmentSshKey } from '../routes/environments.js';
const sshKey = await getEnvironmentSshKey(environmentId);
```

### ContainerImage Is Required for Every Service

Every `Service` must be linked to a `ContainerImage`. When creating test data, always create the image first:

```typescript
const image = await createTestContainerImage(prisma, { environmentId });
const service = await createTestService(prisma, { serverId, containerImageId: image.id });
```

### Two Test Configs

Integration tests and unit tests use different Vitest configs with different isolation modes. Running unit tests with the integration config (or vice versa) causes data races or mock pollution. Always specify the config:

```bash
npx vitest run --config config/vitest.config.ts       # Integration
npx vitest run --config config/vitest.unit.config.ts   # Unit
```

## Getting Help

- **Questions about the codebase**: Open a [GitHub Discussion](https://github.com/bridgeinpt/bridgeport/discussions)
- **Bug reports**: Open a [GitHub Issue](https://github.com/bridgeinpt/bridgeport/issues) with reproduction steps
- **Security issues**: See [SECURITY.md](docs/SECURITY.md) -- please do not open public issues for vulnerabilities

We aim to respond to issues and PRs within a few business days. Thank you for contributing!
