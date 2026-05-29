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

Both endpoints are unauthenticated so CI tools, code generators, and reverse-proxy probes can pull the spec without minting a token. The spec includes the standard error envelope as a shared component (`#/components/schemas/ErrorEnvelope`).

```bash
# Pull the spec
curl https://deploy.example.com/openapi.json > openapi.json

# Open the interactive docs in a browser
open https://deploy.example.com/api/docs
```

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
| **Webhooks** | `/api/webhooks/*` | Incoming CI/CD webhook triggers |
| **Events** | `/api/events` | Real-time SSE stream |
| **Audit** | `/api/audit-logs` | Audit log viewer |
| **Settings** | `/api/settings/*` | Service types, system settings |
| **Admin** | `/api/admin/*` | SMTP, outgoing webhooks, Slack channels, Sentry status + test |
| **Users** | `/api/users/*` | User management (admin only) |
| **Downloads** | `/api/downloads/*` | CLI binary downloads |
| **Spaces** | `/api/spaces/*` | Global S3/Spaces storage configuration |

> [!TIP]
> BRIDGEPORT uses three RBAC roles: **admin** > **operator** > **viewer**. Most read endpoints require any authenticated user. Write operations generally require operator or admin. User management and system settings require admin. See [Users & Roles](../guides/users.md) for the full permission matrix.

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

- [Real-Time Events (SSE)](events.md) -- Live event stream for health, deployments, and notifications
- [CLI Reference](cli.md) -- Command-line interface for terminal workflows
- [Environment Settings](environment-settings.md) -- Per-environment configuration reference
- [System Settings](system-settings.md) -- Global system configuration
