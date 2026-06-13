# MCP Server Reference

BRIDGEPORT can expose a curated subset of its HTTP API as **Model Context Protocol (MCP)** tools, so an MCP-capable agent (Claude Desktop, Claude Code, Cursor, etc.) can list environments, inspect services, read logs, and — for operators — trigger deploys and backups, all through BRIDGEPORT's existing authentication and authorization.

The MCP server is **disabled by default** and is a **thin projection** of the REST API: every tool replays a real internal API request carrying the caller's bearer token, so auth, role/scope enforcement, validation, idempotency, and audit logging behave exactly as they do for a REST call. There is no separate permission model and no new business logic.

## Table of Contents

- [What the MCP Server Is](#what-the-mcp-server-is)
- [Enabling It](#enabling-it)
- [Client Setup](#client-setup)
  - [Claude Desktop / Cursor](#claude-desktop--cursor)
  - [Claude Code](#claude-code)
- [Authentication and Scopes](#authentication-and-scopes)
- [Tools](#tools)
  - [Read Tools](#read-tools)
  - [Write Tools](#write-tools)
  - [Meta Tools](#meta-tools)
- [Idempotency](#idempotency)
- [Data Egress: What Leaves Your Server](#data-egress-what-leaves-your-server)
- [Transport and Networking](#transport-and-networking)
- [Related Docs](#related-docs)

---

## What the MCP Server Is

The Model Context Protocol is an open standard that lets an AI model call external **tools** over a well-defined transport. BRIDGEPORT implements the **server** side: it advertises a set of tools and runs them on request.

Key properties:

- **Bring-your-own-model.** BRIDGEPORT does **no inference on the host.** It never calls an LLM and never ships a model. The model runs wherever your MCP client runs (your laptop, Anthropic's API, etc.); BRIDGEPORT only answers tool calls.
- **A projection of the API.** Each tool maps to one existing REST endpoint. The tool handler issues an internal request with your bearer token, so a tool can never do anything your token couldn't already do via the REST API.
- **Tools only (v1).** The server exposes tools — no MCP *resources*, *prompts*, or *subscriptions*. The transport is stateless: each request is self-contained, with no server-side session.

---

## Enabling It

Set the environment variable and restart BRIDGEPORT:

```bash
MCP_ENABLED=true
```

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MCP_ENABLED` | boolean | `false` | Master switch for the MCP server. **Strictly parsed:** only `true` or `1` (case-insensitive, whitespace-trimmed) enable it; **anything else — including `false`, `0`, an empty string, or leaving it unset — keeps it off.** When off, the `/mcp` route is **not registered at all** (requests return `404`). |
| `MCP_ALLOWED_HOSTS` | string (comma-separated) | _(unset)_ | Public `Host` header value(s) MCP clients use to reach `/mcp` (e.g. `mcp.example.com`). When set, enables DNS-rebinding protection limited to these hosts; off by default. See [Transport and Networking](#transport-and-networking). |

> **Why `MCP_ENABLED` is parsed strictly.** It's a network-exposed, default-off security feature, so it must *fail closed*: a literal `MCP_ENABLED=false` (or `=0`) keeps the endpoint disabled. This differs from BRIDGEPORT's other boolean env flags by design.

When enabled, the endpoint is:

```
POST {BRIDGEPORT_URL}/mcp
```

`MCP_ENABLED` is a deployment-level kill switch (an environment variable, not a database setting): flipping it off and restarting removes the endpoint entirely.

---

## Client Setup

The endpoint speaks **Streamable HTTP** (the modern MCP HTTP transport). Point your client at `POST {BRIDGEPORT_URL}/mcp` and supply an `Authorization: Bearer <token>` header. Use an **API token** (admin-managed, see the [API Reference](api.md#api-tokens)) rather than a session JWT — API tokens are long-lived and can be scoped to specific environments and a capped role.

### Claude Desktop / Cursor

Most desktop clients expect an MCP server entry with a URL and headers. A typical configuration looks like:

```json
{
  "mcpServers": {
    "bridgeport": {
      "url": "https://bridgeport.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <your-api-token>"
      }
    }
  }
}
```

If your client only supports stdio MCP servers, run a Streamable-HTTP bridge (e.g. `mcp-remote`) in front of the URL.

### Claude Code

```bash
claude mcp add --transport http bridgeport https://bridgeport.example.com/mcp \
  --header "Authorization: Bearer <your-api-token>"
```

Then, in a session, the BRIDGEPORT tools appear alongside Claude Code's built-in tools. Start by calling `get_capabilities` to confirm which tools your token unlocked.

---

## Authentication and Scopes

The `/mcp` route is protected by the same authentication layer as the REST API. The bearer token you present is validated on connect, and the **tools registered for that session depend on the token's role-derived scopes**:

| Role | Read tools | Write tools |
|------|:---------:|:-----------:|
| `viewer` | ✅ | ❌ |
| `operator` | ✅ | ✅ |
| `admin` | ✅ | ✅ |

- **Read tools** are available to any valid token (every role has `*:read`).
- **Write tools** are registered only when the token's scopes include `services:write` — which BRIDGEPORT grants to **operator** and **admin** only. A viewer simply doesn't see the write tools in `tools/list`.
- **Environment scoping narrows the tool list.** An env-scoped token can connect, but it sees **only the tools it can actually use** — every tool backed by a global route (all write tools *and* global read tools like `get_server` or `query_audit_log`) is hidden, because such routes always return `FORBIDDEN_SCOPE` for an env-scoped token. See [Environment-scoped tokens see only environment-scoped tools](#environment-scoped-tokens-see-only-environment-scoped-tools).
- **The admin-only secret-reveal endpoint is not exposed as any tool.** There is no way to decrypt a secret value through MCP.

Call `get_capabilities` to see the exact scope set and tool list your token resolved to.

### Environment-scoped tokens see only environment-scoped tools

An **environment-scoped** API token (one whose scope is *not* "all environments") gets a deliberately narrower — and **truthful** — MCP surface: `tools/list` (and `get_capabilities`) advertise **only the tools it can actually use**. A tool is listed for an env-scoped token only when its backing route is reachable by such a token:

- ✅ **Listed** — environment-scoped routes (`/api/environments/:envId/...`), the scope-exempt environment list/get (`GET /api/environments`, `GET /api/environments/:id`), and no-scope routes (`/health`), plus the locally-synthesized `get_capabilities`. These are the per-environment **read tools** — `list_servers`, `list_services`, `list_secrets`, `list_vars`, `get_server_health`, `list_config_files`, `list_config_fragments`, `get_metrics_history`, `list_health_checks`, `list_deployment_plans`, `list_environments`, `get_environment`, `list_databases`, `list_registries`, `list_external_entities`, `list_server_clusters`, `get_dependency_graph`, `list_container_images`, `list_webhook_subscriptions` — plus `get_version` and `get_capabilities`. (An env-scoped **admin** token additionally sees the admin-gated env read `get_environment_settings`, whose route is also under `/api/environments/:id/...`.)
- ❌ **Hidden** — every tool backed by a **global** route (no environment in the path), because BRIDGEPORT's token-scope check rejects an env-scoped token on those routes with `FORBIDDEN_SCOPE`, so listing them would only advertise guaranteed failures. This covers:
  - **All write tools** (`deploy_service`, `execute_deployment_plan`, `restart_deployment`, `rollback_deployment_plan`, `run_database_backup`, `sync_config_file`, `refresh_server_health`, `execute_sync_batch`) — e.g. `POST /api/services/:id/deploy`, `POST /api/servers/:id/health`, `POST /api/sync/batch`.
  - **The global read tools** `get_server`, `get_service`, `get_service_logs`, `get_service_compose`, `get_service_dependencies`, `get_config_file`, `get_server_metrics`, `get_service_metrics`, `get_deployments`, `get_deployment_plan`, `get_drift`, `query_audit_log`, `get_database`, `list_database_backups`, `list_notifications`, `get_registry`, `get_container_image`, `list_image_digests`, `get_topology`, `list_connections`, `list_service_types`, `list_database_types`, `get_system_settings`, and the admin-only `list_service_accounts` / `list_api_tokens` — each hits a global `/api/<resource>/...` route.

> Per-resource scope enforcement still runs on every call regardless; this just stops the env-scoped tool list from advertising tools that could never succeed.

**Recommendation:** for the full MCP surface (all write tools + every read tool), use an **all-environments** API token with the role you intend — or a user session. Use env-scoped tokens when you specifically want to limit a session to read access within particular environments.

---

## Tools

Tool **outputs are passthrough JSON** of the API response, with deliberate exceptions for safety: `get_capabilities` is synthesized locally, and tools touching secret material expose **metadata only** (see the [secret-stripping summary](#read-tools) below and [Data Egress](#data-egress-what-leaves-your-server)). IDs are BRIDGEPORT cuids — get them from the corresponding `list_*` / `get_*` tools.

### Read Tools

Backed by side-effect-free `GET` routes. Available to every role **unless marked admin-only** (the last three rows mirror their `requireAdmin` / `tokens:manage` routes, so a non-admin token simply doesn't see them in `tools/list`).

| Tool | Arguments | Backing route |
|------|-----------|---------------|
| `list_environments` | — | `GET /api/environments` |
| `get_environment` | `id` | `GET /api/environments/:id` |
| `list_servers` | `envId` | `GET /api/environments/:envId/servers` |
| `get_server` | `id`, `includeServices?` | `GET /api/servers/:id` |
| `get_server_health` | `envId` | `GET /api/environments/:envId/health-status` (cached health for all servers/services/databases — **never** triggers a live SSH check) |
| `list_services` | `envId` | `GET /api/environments/:envId/services` |
| `get_service` | `id` | `GET /api/services/:id` |
| `get_service_logs` | `id`, `depId`, `tail?` | `GET /api/services/:id/deployments/:depId/logs` |
| `get_service_compose` | `id` | `GET /api/services/:id/compose/preview` (rendered compose + env artifacts; resolved secret values are redacted) |
| `get_service_dependencies` | `id` | `GET /api/services/:id/dependencies` |
| `get_dependency_graph` | `envId` | `GET /api/environments/:envId/dependency-graph` (nodes, edges, computed deployment order) |
| `list_config_files` | `envId` | `GET /api/environments/:envId/config-files` |
| `get_config_file` | `id` | `GET /api/config-files/:id` |
| `list_config_fragments` | `envId` | `GET /api/environments/:envId/config-fragments` |
| `list_secrets` | `envId` | `GET /api/environments/:envId/secrets` (keys + metadata + usage only) |
| `list_vars` | `envId` | `GET /api/environments/:envId/vars` — **the plaintext `value` field is stripped** from the tool output (keys, descriptions, usage, timestamps only) |
| `list_databases` | `envId` | `GET /api/environments/:envId/databases` (metadata + backup/monitoring state; **credentials never returned** — only a `hasCredentials` flag) |
| `get_database` | `id` | `GET /api/databases/:id` (same credential-free shape as `list_databases`) |
| `list_database_backups` | `id`, `limit?`, `offset?` | `GET /api/databases/:id/backups` |
| `list_container_images` | `envId`, `limit?`, `offset?` | `GET /api/environments/:envId/container-images` |
| `get_container_image` | `id` | `GET /api/container-images/:id` (digests + linked services) |
| `list_image_digests` | `id`, `limit?`, `offset?` | `GET /api/container-images/:id/digests` |
| `list_registries` | `envId` | `GET /api/environments/:envId/registries` — **metadata only**: type/URL/prefix/defaults + `hasToken`/`hasPassword` booleans + the (non-secret) `username`. **Credentials are never returned.** |
| `get_registry` | `id` | `GET /api/registries/:id` (same credential-free shape as `list_registries`) |
| `get_topology` | `environmentId` | `GET /api/diagram-export?format=mermaid` (servers/services/databases/external entities + connections as a Mermaid graph) |
| `list_connections` | `environmentId` | `GET /api/connections` (topology edges) |
| `list_external_entities` | `envId` | `GET /api/environments/:envId/external-entities` |
| `list_server_clusters` | `envId` | `GET /api/environments/:envId/server-clusters` |
| `list_service_types` | — | `GET /api/settings/service-types` (plugin-defined types + commands) |
| `list_database_types` | — | `GET /api/settings/database-types` (connection-field definitions describe shape only — no credential values) |
| `list_notifications` | `limit?`, `offset?`, `unreadOnly?`, `environmentId?`, `category?` | `GET /api/notifications` |
| `list_webhook_subscriptions` | `envId` | `GET /api/environments/:envId/webhooks` — **the signing secret is never returned**, only a `hasSecret` boolean |
| `get_server_metrics` | `id` | `GET /api/servers/:id/metrics` |
| `get_service_metrics` | `id` | `GET /api/services/:id/metrics` |
| `get_metrics_history` | `envId` | `GET /api/environments/:envId/metrics/history` |
| `list_health_checks` | `envId` | `GET /api/environments/:envId/health-logs` |
| `get_deployments` | `id` | `GET /api/services/:id/deployments-history` |
| `list_deployment_plans` | `envId` | `GET /api/environments/:envId/deployment-plans` |
| `get_deployment_plan` | `id` | `GET /api/deployment-plans/:id` |
| `get_drift` | `id` (server) | `GET /api/servers/:id/drift` |
| `get_system_settings` | — | `GET /api/settings/system` — the only secret field (the DO registry token) is **masked** by the route (`****`-suffixed) |
| `query_audit_log` | `environmentId?`, `resourceType?`, `resourceId?`, `action?`, `limit?`, `offset?` | `GET /api/audit-logs` |
| `get_version` | — | `GET /health` (app / bundled agent / CLI versions) |
| `get_environment_settings` 🔒 | `id`, `module` | `GET /api/environments/:id/settings/:module` — **admin-only** (`requireAdmin`). `module` ∈ `general` \| `monitoring` \| `operations` \| `data` \| `configuration` |
| `list_service_accounts` 🔒 | — | `GET /api/admin/service-accounts` — **admin-only**. Metadata only (name, role, disabled, token count); **no token values or hashes** |
| `list_api_tokens` 🔒 | `ownerUserId?`, `ownerServiceAccountId?` | `GET /api/admin/tokens` — requires **`tokens:manage`** (admin). Returns the non-secret `tokenPrefix` only; **the token value/hash is never returned** |

🔒 = admin-gated (the tool is only registered for a token whose scopes include `admin:*` / `tokens:manage`).

> `get_service_logs` and `get_deployments` operate at the **deployment** level (per-server runtime). Get the `depId` from `get_service`, which lists the service's deployments.
>
> **Secret-stripping summary.** Several read tools touch resources with secret material; in every case the tool exposes **metadata only** and the secret never leaves the host: `list_secrets`/`list_vars` (no values), `list_registries`/`get_registry` (`hasToken`/`hasPassword` booleans, no credential), `list_databases`/`get_database` (`hasCredentials` flag, no encrypted blob), `list_webhook_subscriptions` (`hasSecret` boolean, no signing secret), `get_system_settings` (DO registry token masked), and `list_api_tokens` (non-secret prefix, no value/hash). These are properties of the **backing routes' service-layer projections** — the MCP tools add no new exposure.

### Write Tools

Require a write scope (`operator`/`admin`) and are hidden from environment-scoped tokens (see [above](#environment-scoped-tokens-see-only-environment-scoped-tools)). Each carries the MCP `destructiveHint: true` annotation. Each **mutating** call injects a time-bucketed `Idempotency-Key`; `dryRun=true` previews are not cached (see [Idempotency](#idempotency)).

| Tool | Arguments | Backing route |
|------|-----------|---------------|
| `deploy_service` | `id`, `imageTag?`, `pullImage?`, `generateArtifacts?`, `strategy?`, `idempotencyKey?` | `POST /api/services/:id/deploy` |
| `execute_deployment_plan` | `id`, `dryRun?`, `idempotencyKey?` | `POST /api/deployment-plans/:id/execute` (`dryRun=true` → non-mutating preview) |
| `restart_deployment` | `id`, `depId`, `idempotencyKey?` | `POST /api/services/:id/deployments/:depId/restart` |
| `rollback_deployment_plan` | `id`, `idempotencyKey?` | `POST /api/deployment-plans/:id/rollback` |
| `run_database_backup` | `id`, `idempotencyKey?` | `POST /api/databases/:id/backups` (operator) |
| `sync_config_file` | `id`, `dryRun?`, `idempotencyKey?` | `POST /api/config-files/:id/sync-all` (operator; `dryRun=true` → diff preview) |
| `refresh_server_health` | `id`, `idempotencyKey?` | `POST /api/servers/:id/health` (operator) — **performs a LIVE SSH health check** against the host and updates the stored health columns |
| `execute_sync_batch` | `operations[]` (`{ configFileId }`), `rollbackOnFailure?`, `idempotencyKey?` | `POST /api/sync/batch` (operator) — atomic multi-file sync; **no dry-run** (preview individual files with `sync_config_file(dryRun=true)`) |

> For `execute_deployment_plan` and `sync_config_file`, prefer a `dryRun=true` call first to preview the effect before running the real mutation.
>
> `refresh_server_health` is the only read-adjacent write: it triggers a **live host query** rather than reading cached health (use `get_server_health` for the cached view). `execute_sync_batch` is all-or-nothing by default (`rollbackOnFailure=true` rolls back already-applied ops if a later one fails); all files in a batch must live in the **same environment**.
>
> **Conservative by design.** The write surface is deliberately limited to **operational** actions (deploy / restart / rollback / backup / config-sync / live health-check). MCP does **not** expose create/update/delete for servers, services, secrets, vars, config files, databases, environments, registries, etc. — declarative resource management is the Terraform provider's domain. MCP is **observe + safe-operate** only.

### Meta Tools

| Tool | Arguments | Behavior |
|------|-----------|----------|
| `get_capabilities` | — | Returns `{ version, scopes, tools }` for the current session — the BRIDGEPORT version, your token's derived scopes, and the names of the tools you can call. Synthesized locally (no API call). |

---

## Idempotency

Each **mutating** write call injects an `Idempotency-Key` header so BRIDGEPORT's idempotency middleware engages and a duplicated/retried identical call is **deduplicated** (the original result is replayed instead of running the mutation twice).

- **Short dedup window (default).** The derived key folds in a **~60-second time bucket**: `sha256(toolName + ":" + timeBucket + ":" + canonicalJSON(args))`. So **identical calls within ~60s dedupe as retries** (the original result replays), while **an intended repeat of the same operation later executes normally** rather than silently replaying a stale success. For example, `run_database_backup({ id })` called twice within a minute returns the first result both times; called again ten minutes later it runs a **new** backup.
- **Dry-run previews are never cached.** A call with `dryRun=true` (`execute_deployment_plan`, `sync_config_file`) attaches **no** `Idempotency-Key`, so re-running an identical preview always recomputes a fresh diff instead of replaying a stale one.
- **Override.** Pass an explicit `idempotencyKey` string argument on any write tool to set the key yourself — to **force** dedup across the 60s windows (e.g. tie an operation to an external job id) or to **extend** the safety net. The override is excluded from the derived-key hash and is ignored for dry-run previews.

> The outer `POST /mcp` envelope itself is **not** idempotency-managed — only the injected sub-calls are. (The transport hijacks the response, which would wedge a key applied to the envelope; meaningful idempotency lives on the real mutating sub-calls.)

See the [API Reference](api.md) and issue #126 for the underlying idempotency contract (24-hour retention, conflict on same-key/different-body, etc.).

---

## Data Egress: What Leaves Your Server

When you connect an MCP client, **tool outputs are sent to whatever model that client uses.** Treat anything a tool can return as data that may leave your infrastructure:

- **Logs (`get_service_logs`) and audit entries (`query_audit_log`) can contain sensitive application output** — request payloads, stack traces, tokens an app happened to log. They are returned verbatim. Only enable MCP, and only mint tokens, for operators you trust to route that data to their model.
- **Secret, variable, and credential values are never returned.** `list_secrets` exposes keys and metadata only; `list_vars` strips the `value` field; `list_registries`/`get_registry` return `hasToken`/`hasPassword` flags (no credential); `list_databases`/`get_database` return a `hasCredentials` flag (no encrypted blob); `list_webhook_subscriptions` returns a `hasSecret` flag (no signing secret); `get_system_settings` masks the DO registry token; `list_api_tokens` returns only the non-secret token prefix; and the admin-only secret-reveal endpoint is **not exposed as a tool**.
- **Config and compose content is returned.** `get_config_file` returns config-file content, and `get_service_compose` returns the rendered compose/env artifacts; both **redact resolved secret values** in their previews — but a config file you wrote with an inline literal will show that literal. `get_topology` / `list_connections` expose your infrastructure layout (hostnames, ports, service names).
- **`refresh_server_health` performs a live host query.** Unlike the cached `get_server_health` read, it opens an SSH connection to the target host. It's operator-gated and idempotency-keyed, but it is not a free/cached call.
- **Scope your tokens.** Use an environment-scoped, role-capped API token so an MCP session can only read/act on the environments you intend.

---

## Transport and Networking

- **Transport:** Streamable HTTP, stateless (`POST /mcp` only). `GET`/`DELETE /mcp` return `405` — there is no server-side session or SSE notification stream to resume.
- **Rate limiting:** MCP requests — and every API sub-call a tool replays internally — are subject to the same global per-IP rate limit as the rest of the API. Each injected sub-call is **attributed to the calling client's real IP** (the same IP its direct API calls would use), so one caller's tool-call flood is throttled under that caller's bucket and can't starve others. There is intentionally **no bypass**.
- **DNS-rebinding / Origin protection:** **off by default**, controlled by the explicit `MCP_ALLOWED_HOSTS` env var (a comma-separated list of the public `Host` header value(s) clients use, e.g. `mcp.example.com`). When set, the transport validates the request `Host` header against that allowlist; when unset/empty, host validation is left off. This is intentionally **decoupled from `HOST`** (the socket bind address): a public hostname behind a reverse proxy differs from the bind address, and the common `HOST=0.0.0.0` would otherwise either reject every proxied client or silently disable protection. The endpoint is bearer-authenticated regardless; setting `MCP_ALLOWED_HOSTS` (plus TLS) is recommended when exposing MCP to remote clients.
- **TLS:** terminate TLS at your reverse proxy, exactly as for the REST API. Bearer tokens must only travel over HTTPS in production.

---

## Related Docs

- [API Reference](api.md) — authentication, API tokens, scopes, error envelope, idempotency
- [Users and Roles](../guides/users.md) — the RBAC model the MCP scopes derive from
- [Configuration Reference](../configuration.md) — all environment variables
- [Security and Hardening](../operations/security.md) — production hardening checklist
