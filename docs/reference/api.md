# API Reference

BRIDGEPORT exposes a JSON REST API for all operations -- deployments, server management, monitoring, and more. This page covers authentication, error handling, and a high-level overview of endpoint categories.

## Table of Contents

- [Base URL](#base-url)
- [OpenAPI Spec & Interactive Docs](#openapi-spec--interactive-docs)
- [Authentication](#authentication)
  - [JWT Authentication](#jwt-authentication)
  - [API Tokens](#api-tokens)
  - [Service Accounts](#service-accounts)
  - [Token Scope Enforcement](#token-scope-enforcement)
  - [Using Tokens](#using-tokens)
- [Error Format](#error-format)
- [Idempotency-Key](#idempotency-key)
- [Webhook Subscriptions](#webhook-subscriptions)
- [Endpoint Categories](#endpoint-categories)
- [CI/CD Integration Examples](#cicd-integration-examples)
- [Related Docs](#related-docs)

---

## Base URL

All API endpoints are prefixed with `/api`. If BRIDGEPORT runs at `https://deploy.example.com`, the full base URL is:

```
https://deploy.example.com/api
```

All requests and responses use `Content-Type: application/json` unless otherwise noted (e.g., file uploads use `multipart/form-data`).

---

## OpenAPI Spec & Interactive Docs

BRIDGEPORT publishes a self-describing OpenAPI 3 specification so programmatic clients can introspect routes, parameters, and the error envelope without scraping this page.

| What | Path | Auth |
|------|------|------|
| Raw OpenAPI 3 spec (JSON) | `GET /openapi.json` | No |
| Swagger UI (interactive) | `GET /api/docs` | No |

Both endpoints are unauthenticated so CI tools, code generators, and reverse-proxy probes can pull the spec without minting a token. The spec includes the standard error envelope as a shared component (`#/components/schemas/ErrorEnvelope`), and most operations declare their request body / path params and reference that envelope on error responses.

> [!TIP]
> `/openapi.json` is the canonical wire contract. See the [API Stability Policy](../api-stability.md) for the compatibility guarantees, semver rules, and how to pin against a spec snapshot.

```bash
# Pull the spec
curl https://deploy.example.com/openapi.json > openapi.json

# Open the interactive docs in a browser
open https://deploy.example.com/api/docs
```

### How the spec is generated (contributors)

The request contracts in the spec are **derived from the same Zod schemas that
validate requests at runtime** — there is a single source of truth, so the spec
can't drift from the actual validators. The wiring lives in
`src/lib/openapi-schema.ts` (`routeSchema()`), which converts each Zod schema
with `z.toJSONSchema(..., { target: 'openapi-3.0' })` and attaches it to the
Fastify route `schema` option **for documentation only**. Runtime validation
stays with `validateBody()` / `validateUpdateBody()` (a no-op validator compiler
keeps Fastify from re-validating the doc schemas), which preserves the
read-only-field `422` behaviour and the custom error envelope.

A snapshot of the spec is checked in at `openapi.json` (repo root). Regenerate
it whenever you add or change a route schema:

```bash
pnpm run openapi:dump    # rebuild openapi.json from the live route schemas
pnpm run openapi:check   # rebuild + fail if it drifted from git (used in CI)
```

The `openapi` job in `.github/workflows/test.yml` runs `openapi:check` on every
PR, so a stale `openapi.json` fails CI. The spec's `info.version` is pinned to a
stable literal so the snapshot is byte-identical across builds (the build/git
stamp lives in `/health`, not the contract).

---

## Authentication

BRIDGEPORT supports two authentication methods: short-lived JWT tokens for interactive sessions, and long-lived API tokens for programmatic access.

### JWT Authentication

JWTs are issued by the login endpoint and expire after **7 days**.

**Login**

```bash
curl -X POST https://deploy.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "password": "your-password"}'
```

**Response**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "clx...",
    "email": "admin@example.com",
    "name": "Admin",
    "role": "admin"
  }
}
```

Use the returned `token` in subsequent requests via the `Authorization` header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Get current user**

```bash
curl https://deploy.example.com/api/auth/me \
  -H "Authorization: Bearer <token>"
```

**Response**

```json
{
  "user": {
    "id": "clx...",
    "email": "admin@example.com",
    "name": "Admin",
    "role": "admin"
  },
  "role": "admin",
  "environments": ["clenv-staging...", "clenv-prod..."],
  "scopes": [
    "services:read", "secrets:read", "servers:read", "environments:read",
    "services:write", "secrets:write", "servers:write", "environments:write",
    "secrets:reveal", "tokens:manage", "admin:*"
  ]
}
```

- `user` (existing) — full principal record.
- `role` — `admin` / `operator` / `viewer` (effective role for API tokens).
- `environments` — environment IDs the caller may act on. For env-scoped API tokens this is the token's allowlist; for full-access JWTs/tokens it's every environment in the system.
- `scopes` — derived, human-friendly scope strings (`<resource>:<action>`). Use these to gate UI affordances; the source of truth for enforcement is still the role + token scope. Note `secrets:read` (all roles) covers listing secret keys/metadata, while `secrets:reveal` (admin only) covers decrypting values via `GET /api/secrets/:id/value`.

**First-user registration**

If no users exist in the database, the registration endpoint is available. The first user is always created as an admin:

```bash
curl -X POST https://deploy.example.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@example.com", "password": "secure-password", "name": "Admin"}'
```

Once at least one user exists, this endpoint returns `403 Registration disabled`.

### API Tokens

API tokens are designed for CI/CD pipelines, scripts, and long-running integrations. They are **admin-managed** — token CRUD lives under `/api/admin/tokens`, gated by `requireAdmin`. Tokens are scoped along three dimensions: **role** (≤ owner's role), **environment allowlist** (all, or specific envs), and **expiry** (mandatory, max 365 days).

Tokens carry a `bport_pat_` prefix so they are trivially detectable in logs and secret scanners.

> [!WARNING]
> The full token value is returned **only once** at creation time. BRIDGEPORT stores only a SHA-256 hash. Copy it immediately and store it securely; if lost, revoke and re-mint.

**Create a token**

```bash
curl -X POST https://deploy.example.com/api/admin/tokens \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "github-actions-staging",
    "ownerServiceAccountId": "clxyz...",
    "role": "operator",
    "allEnvironments": false,
    "environmentIds": ["clenv-staging..."],
    "expiresInDays": 90
  }'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Display name (e.g., `"github-actions-staging"`) |
| `ownerUserId` | `string` | One of | Mint a user-owned token |
| `ownerServiceAccountId` | `string` | One of | Mint a service-account-owned token (preferred for tools) |
| `role` | `string` | Yes | `admin` / `operator` / `viewer`; ≤ owner role |
| `allEnvironments` | `boolean` | Yes | If `false`, `environmentIds` must be non-empty |
| `environmentIds` | `string[]` | If `!allEnvironments` | Environment IDs the token may act on |
| `expiresInDays` | `number` | Yes | 1–365 |

**Response**

```json
{
  "token": "bport_pat_xxxxxxxxxxxxxxxxxxxxxxxx",
  "tokenRecord": {
    "id": "cltok...",
    "name": "github-actions-staging",
    "tokenPrefix": "bport_pat_xxxx",
    "role": "operator",
    "allEnvironments": false,
    "expiresAt": "2026-08-18T12:00:00.000Z",
    "createdAt": "2026-05-20T12:00:00.000Z",
    "userId": null,
    "serviceAccountId": "clxyz..."
  }
}
```

**List tokens**

```bash
curl https://deploy.example.com/api/admin/tokens \
  -H "Authorization: Bearer <admin-jwt>"
```

Optional query: `?ownerUserId=<id>` or `?ownerServiceAccountId=<id>`. Records include owner info and environment scope. Token hashes are never returned.

**Revoke a token**

```bash
curl -X DELETE https://deploy.example.com/api/admin/tokens/<tokenId> \
  -H "Authorization: Bearer <admin-jwt>"
```

Returns `{"success": true}` and any subsequent request using the token gets `401`.

### Service Accounts

Machine identities — own tokens, never log in. Use for any tool talking to BRIDGEPORT so the credential outlives any one admin.

**Create**

```bash
curl -X POST https://deploy.example.com/api/admin/service-accounts \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name": "ci-deploy-staging", "role": "operator", "description": "GitHub Actions"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | `[a-z0-9][a-z0-9_-]*`, max 64 chars |
| `role` | `string` | No | Default `viewer`; caps the role of any token minted against this SA |
| `description` | `string` | No | Free-form, max 500 chars |

**List / Update / Delete**

- `GET /api/admin/service-accounts`
- `PATCH /api/admin/service-accounts/:id` — body may include `description`, `role`, `disabled`
- `DELETE /api/admin/service-accounts/:id` — cascades to all owned tokens; audit log links go to NULL

Setting `disabled: true` invalidates every token owned by the SA immediately without revoking them individually.

### Token Scope Enforcement

When a token authenticates a request:

1. **Effective role** = `min(token.role, owner.role)`. Owner demotions take effect immediately.
2. If the SA owner is `disabled`, the token returns `401`.
3. If the token is env-scoped:
   - Requests under `/api/environments/:envId/...` check `envId` ∈ allowlist; otherwise `403`.
   - Requests to global routes (admin, users, system settings, etc.) get `403`.
   - `GET /api/environments` returns only the allowed environments.
   - `GET /api/auth/me` is always allowed (introspection).

### Using Tokens

Both JWT and API tokens are used with the same `Authorization` header:

```
Authorization: Bearer <token>
```

For Server-Sent Events (SSE), which do not support custom headers, pass the token as a query parameter:

```
GET /api/events?token=<token>
```

> [!NOTE]
> When a token is passed as a query parameter it appears in server logs and browser history. Prefer API tokens over JWTs for SSE connections, and configure your reverse proxy to redact query strings from access logs.

---

## Error Format

Every non-2xx response returns a standardized envelope:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Must be at least 8 characters",
  "field": "password",
  "hint": "Passwords need 8+ characters",
  "requestId": "req-abc123"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `code` | Yes | Stable, machine-readable error code (see table below). Branch on this, not on `message` or HTTP status. |
| `message` | Yes | Human-readable message. For 5xx responses this is always `"Internal Server Error"` — the real error is logged server-side. |
| `field` | No | Field name when the error is tied to a specific input (e.g. validation, readonly violations). |
| `hint` | No | Optional, human-friendly hint for resolving the error. |
| `requestId` | No | Server-assigned request ID; include it when reporting an issue. |

### Error code → HTTP status

| `code` | HTTP | When |
|--------|------|------|
| `VALIDATION_ERROR` | 400 | Request body / query failed schema validation. |
| `READONLY_FIELD` | 422 | Client tried to mutate a server-managed/derived field on a PATCH (e.g. `status`, `exposedPorts`, `lastCheckedAt`). The entire request is rejected — no partial application. The envelope's `field` names the first offender and `hint` explains how to update it through the correct channel. |
| `UNAUTHORIZED` | 401 | Missing or invalid credentials. |
| `FORBIDDEN_SCOPE` | 403 | Authenticated but the token isn't scoped to this environment (env-scoped API token hitting an environment outside its allowlist, or a global route). |
| `FORBIDDEN_ROLE` | 403 | Authenticated but the principal's role is insufficient (e.g., a viewer attempting a write, a non-admin hitting an admin-only route). |
| `NOT_FOUND` | 404 | Resource doesn't exist (or the caller can't see it). |
| `CONFLICT` | 409 | Conflicting state (duplicate name, optimistic-lock failure, etc.). |
| `IDEMPOTENCY_KEY_REUSED` | 409 | An idempotency key was replayed with a different request body. |
| `RATE_LIMITED` | 429 | Global or per-route rate limit hit. |
| `INTERNAL` | 500 | Anything else; the underlying error is logged + reported to Sentry. |

Validation errors may include a legacy `details` array alongside the envelope when the underlying validator produced one. New clients should rely on `code` + `field`; `details` is kept for backwards compatibility with existing UIs.

---

## Idempotency-Key

Any mutating `POST` can be made safe to retry by sending an `Idempotency-Key` header. This lets a flaky network or a CI retry loop re-send a request (e.g. "deploy this service") without risking a second deployment.

```bash
curl -X POST "$BRIDGEPORT_URL/api/environments/$ENV_ID/servers" \
  -H "Authorization: Bearer $BRIDGEPORT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7c1f0e6e-1f0a-4d2b-9b3a-3e2d1c0b9a87" \
  -d '{"name":"web-1","hostname":"10.0.0.5"}'
```

**How it works**

- The key is scoped to the tuple `(key, HTTP method, route path)`. The same key on a different route is independent.
- The request body is hashed (SHA-256 of its JSON serialization) and stored with the key.
- **First request** with a given key runs normally. On a `2xx` the response status + body are cached against the key.
- **Replay (same key + same body)** short-circuits: the cached response is returned verbatim and the handler does **not** run again — so no second deploy is queued. Replayed responses carry an `Idempotent-Replayed: true` header.
- **Replay while the first request is still running** (a concurrent retry) returns `409 CONFLICT` with the hint to retry once the original completes.
- **Same key + different body** returns `409` with code `IDEMPOTENCY_KEY_REUSED` — keys must not be reused for a different payload.
- On a **non-2xx** the key record is discarded so the client can retry the same key cleanly.

**Scope & lifetime**

- Records expire **24 hours** after creation; after that the same key is treated as new. Expired records are cleaned up by a daily scheduler job.
- The feature engages **only** when the `Idempotency-Key` header is present on a `POST`. All other requests are unaffected.
- Keys are capped at 200 characters. A UUID is the recommended form.
- File-upload (`multipart/form-data`) POSTs are **not** idempotency-protected — their bodies aren't a stable JSON object — and pass through unaffected.
- `POST /api/sync/batch` has its own built-in idempotency handling (see [Sync Batches](#endpoint-categories)); the global mechanism above does not double-handle it.

---

## Webhook Subscriptions

Env-scoped webhook subscriptions let external systems receive a signed HTTP callback when a lifecycle event completes in an environment (a deploy finishes, a plan completes, a backup runs, a sync batch settles). This is distinct from [incoming CI/CD webhooks](../guides/webhooks.md) (which trigger deployments) and from the global admin **outgoing webhooks** (which fan out notification events). Subscriptions are managed per-environment by operators.

### Endpoints

| Method | Path | Role | Description |
|--------|------|------|-------------|
| `POST` | `/api/environments/:envId/webhooks` | operator+ | Create a subscription |
| `GET` | `/api/environments/:envId/webhooks` | viewer+ | List subscriptions |
| `GET` | `/api/environments/:envId/webhooks/:id` | viewer+ | Get one subscription |
| `DELETE` | `/api/environments/:envId/webhooks/:id` | operator+ | Delete a subscription |
| `GET` | `/api/environments/:envId/webhooks/:id/deliveries` | viewer+ | Paginated delivery history (`?limit=&offset=`) |

Create body:

```json
{
  "url": "https://example.com/hooks/bridgeport",
  "secret": "a-shared-signing-secret",
  "events": ["deployment.completed", "deployment.failed"],
  "enabled": true
}
```

The `secret` is **write-only**: it is encrypted at rest (AES-256-GCM) and is **never** returned by any endpoint. Responses expose only `hasSecret: boolean`.

### Event codes

A subscription must list one or more of these canonical event codes:

| Event | Fired when |
|-------|------------|
| `deployment.completed` | A single-service deployment succeeds |
| `deployment.failed` | A single-service deployment fails |
| `plan.completed` | A deployment plan reaches `COMPLETED` (final status in payload) |
| `plan.failed` | A deployment plan reaches a terminal `FAILED` (auto-rollback disabled; when auto-rollback takes over, `plan.rolled_back` fires instead) |
| `plan.rolled_back` | A deployment plan failed with auto-rollback enabled and reached the terminal `ROLLED_BACK` state |
| `backup.completed` | A database backup succeeds |
| `backup.failed` | A database backup fails |
| `sync.completed` | A sync batch settles (final batch status in payload — one event per batch) |

### Delivery payload

Every delivery `POST`s a JSON body of the form:

```json
{
  "event": "deployment.completed",
  "environmentId": "clxxxx",
  "timestamp": "2026-06-11T21:00:00.000Z",
  "data": { "deploymentId": "...", "serviceName": "...", "status": "success" }
}
```

The `data` object's keys depend on the event (deployment/plan/backup/sync context).

### Signature verification

When a subscription has a `secret`, each delivery includes an `X-BridgePort-Signature` header:

```
X-BridgePort-Signature: sha256=<hex HMAC-SHA256(secret, rawRequestBody)>
```

Verify it by computing the HMAC-SHA256 of the **raw request body** with your stored secret and comparing (constant-time) against the hex value after `sha256=`. Two additional headers aid debugging: `X-BridgePort-Event` (the event code) and `X-BridgePort-Delivery` (the delivery id).

### Retry policy

- Deliveries are sent in the background and recorded in delivery history with a `status` of `pending`, `delivered`, or `failed`.
- A `2xx` response marks the delivery `delivered`.
- Any non-2xx, timeout (10s per attempt), or network error is retried with **exponential backoff** (5s, 10s, 20s, 40s, …, capped at 5 minutes) up to **5 attempts**, after which the delivery is `failed` (terminal).
- Delivery history rows are retained for 30 days, then cleaned up by a scheduler job.

---

## Endpoint Categories

BRIDGEPORT's API is organized into the following categories. Each category corresponds to a route module in `src/routes/`.

| Category | Base Path | Description |
|----------|-----------|-------------|
| **Authentication** | `/api/auth/*` | Login, registration, API token management |
| **Environments** | `/api/environments/*` | Environment CRUD, SSH key management |
| **Environment Settings** | `/api/environments/:envId/settings/*` | Per-module settings (General, Monitoring, etc.) |
| **Servers** | `/api/environments/:envId/servers/*` | Server management, health checks |
| **Services** | `/api/environments/:envId/services/*` | Service management, deployment, health checks |
| **Container Images** | `/api/environments/:envId/container-images/*` | Image tracking, tag history, deploy triggers |
| **Deployment Plans** | `/api/environments/:envId/deployment-plans/*` | Orchestrated multi-service deployments |
| **Registries** | `/api/environments/:envId/registries/*` | Container registry connections |
| **Secrets** | `/api/environments/:envId/secrets/*` | Encrypted secret management |
| **Config Files** | `/api/environments/:envId/config-files/*` | Configuration file management with history |
| **Config Fragments** | `/api/environments/:envId/config-fragments/*` | Env-scoped reusable text blocks included by ConfigFiles |
| **Sync Batches** | `/api/sync/batch[, /:batchId]` | Atomic multi-file syncs with optional rollback and `Idempotency-Key` support ([guide](../guides/config-files.md#batched-atomic-sync)) |
| **Databases** | `/api/environments/:envId/databases/*` | Database management, backups, monitoring |
| **Metrics** | `/api/metrics/*` | Server/service metrics, agent ingest endpoint |
| **Monitoring** | `/api/monitoring/*` | Health logs, metrics history, SSH testing |
| **Topology** | `/api/environments/:envId/topology/*` | Service connections, diagram layouts |
| **Notifications** | `/api/notifications/*` | User notifications, preferences |
| **Webhooks (incoming)** | `/api/webhooks/*` | Incoming CI/CD webhook triggers |
| **Webhook Subscriptions** | `/api/environments/:envId/webhooks/*` | Env-scoped signed event callbacks with retry + delivery history ([details](#webhook-subscriptions)) |
| **Events** | `/api/events` | Real-time SSE stream |
| **Audit** | `/api/audit-logs` | Audit log viewer |
| **Settings** | `/api/settings/*` | Service types, system settings |
| **Admin** | `/api/admin/*` | SMTP, outgoing webhooks, Slack channels, Sentry status + test |
| **Users** | `/api/users/*` | User management (admin only) |
| **Downloads** | `/api/downloads/*` | CLI binary downloads |
| **Spaces** | `/api/spaces/*` | Global S3/Spaces storage configuration |

> [!TIP]
> BRIDGEPORT uses three RBAC roles: **admin** > **operator** > **viewer**. Most read endpoints require any authenticated user. Write operations generally require operator or admin. User management and system settings require admin. See [Users & Roles](../guides/users.md) for the full permission matrix.

> [!NOTE]
> Beyond the REST API documented here, BRIDGEPORT can project a curated **observe + safe-operate** subset of these same endpoints to AI agents over the **Model Context Protocol (MCP)** at `POST /mcp` (opt-in, off by default). Each MCP tool replays a real internal API request with your bearer token, so authentication, scopes, idempotency, and audit logging behave identically. See the [MCP Server Reference](mcp.md).

---

## CI/CD Integration Examples

### GitHub Actions

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger deployment
        run: |
          curl -X POST \
            "${{ secrets.BRIDGEPORT_URL }}/api/webhooks/deploy" \
            -H "Authorization: Bearer ${{ secrets.BRIDGEPORT_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{
              "image": "registry.example.com/myapp",
              "tag": "${{ github.sha }}",
              "environment": "staging"
            }'
```

### GitLab CI

```yaml
deploy:
  stage: deploy
  script:
    - |
      curl -X POST \
        "$BRIDGEPORT_URL/api/webhooks/deploy" \
        -H "Authorization: Bearer $BRIDGEPORT_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{
          \"image\": \"registry.example.com/myapp\",
          \"tag\": \"$CI_COMMIT_SHA\",
          \"environment\": \"staging\"
        }"
  only:
    - main
```

### Shell Script

```bash
#!/usr/bin/env bash
set -euo pipefail

BRIDGEPORT_URL="https://deploy.example.com"
BRIDGEPORT_TOKEN="bp_your_api_token_here"

# List servers in staging
curl -s "$BRIDGEPORT_URL/api/environments" \
  -H "Authorization: Bearer $BRIDGEPORT_TOKEN" | jq '.environments[] | .name'

# Trigger a deployment
curl -X POST "$BRIDGEPORT_URL/api/webhooks/deploy" \
  -H "Authorization: Bearer $BRIDGEPORT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"image": "registry.example.com/myapp", "tag": "v1.2.3", "environment": "production"}'
```

---

## Related Docs

- [API Stability Policy](../api-stability.md) -- Compatibility contract, semver rules, deprecation window, and current deprecations
- [MCP Server](mcp.md) -- Expose the API to AI agents as Model Context Protocol tools (opt-in, scoped to your tokens)
- [Real-Time Events (SSE)](events.md) -- Live event stream for health, deployments, and notifications
- [CLI Reference](cli.md) -- Command-line interface for terminal workflows
- [Environment Settings](environment-settings.md) -- Per-environment configuration reference
- [System Settings](system-settings.md) -- Global system configuration
