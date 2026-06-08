# API Stability & Deprecation Policy

This document is the compatibility contract for BRIDGEPORT's HTTP API. It tells integrators what they can rely on, how breaking changes are versioned, how long a deprecated surface stays alive, and how to discover what a running instance speaks. Read it before you build anything against the API.

## Table of Contents

- [Scope](#scope)
- [Versioning & semver](#versioning--semver)
- [The canonical contract](#the-canonical-contract)
- [Deprecation policy](#deprecation-policy)
- [Changelog discipline](#changelog-discipline)
- [Version discovery](#version-discovery)
- [Current deprecations](#current-deprecations)
- [Reporting issues & questions](#reporting-issues--questions)

---

## Scope

This policy covers the **HTTP API** — every endpoint under `/api`, plus the unauthenticated `GET /openapi.json` and `GET /health` endpoints. For these surfaces, the guarantees below apply.

**Covered:**

- Request and response shapes (field names, types, nesting).
- HTTP status codes and the standardized [error envelope](reference/api.md#error-format) (`code`, `message`, `field`, `hint`, `requestId`).
- The stable `code` enum on error responses (`VALIDATION_ERROR`, `READONLY_FIELD`, `UNAUTHORIZED`, `FORBIDDEN_SCOPE`, `FORBIDDEN_ROLE`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `RATE_LIMITED`, `INTERNAL`).
- Authentication mechanics (`Authorization: Bearer`, the SSE `?token=` query param, scope enforcement rules).
- The machine-readable contract published at `GET /openapi.json`.

**Not covered** (these may change at any time, in any release, without a deprecation window):

- The **SQLite / Prisma schema** and its migrations — an internal implementation detail. Never read the database directly; everything is exposed through the API.
- The **monitoring agent wire protocol** between the agent and the backend.
- **Internal environment variables** and configuration flags (covered separately by the [Configuration Reference](configuration.md), which has its own compatibility notes).
- The **web UI** — markup, routes, component behavior, and bundled assets are not an API. Build against the documented endpoints, not the pages.

> [!NOTE]
> If a behavior is observable through the API but not described in the [API Reference](reference/api.md) or the OpenAPI spec, treat it as undocumented and subject to change. When in doubt, ask (see [Reporting issues & questions](#reporting-issues--questions)).

---

## Versioning & semver

BRIDGEPORT releases follow [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`), and the **wire format of the HTTP API is the thing semver protects**:

- **MAJOR** (e.g. `1.x` → `2.0`) — may contain breaking wire-format changes. The `2.0` release, for example, redesigned the service model (see [Service → ServiceDeployment](#current-deprecations) below) and was a deliberate, clean break.
- **MINOR** (e.g. `2.0` → `2.1`) — additive only. New endpoints, new optional fields, new error codes. Existing integrations keep working untouched.
- **PATCH** (e.g. `2.0.1` → `2.0.2`) — bug fixes and security fixes only. No new surface, no removed surface.

### Breaking vs non-breaking changes

A change is **breaking** if a previously-valid client could observe a different, incompatible result. Breaking changes ship **only in a major release**.

| Change | Breaking? | Allowed in |
|--------|-----------|------------|
| Removing or renaming a field | Breaking | Major only |
| Changing a field's type (e.g. `string` → `object`) | Breaking | Major only |
| Changing an endpoint's HTTP status code | Breaking | Major only |
| Adding or tightening validation that rejects previously-accepted input | Breaking | Major only |
| Removing an endpoint | Breaking | Major only |
| Removing an enum value from a field | Breaking | Major only |
| Adding a new **optional** field to a response | Non-breaking | Minor / patch |
| Adding a new endpoint | Non-breaking | Minor / patch |
| Adding a new enum value to a field documented as open/extensible | Non-breaking | Minor / patch |
| Adding a new error `code` | Non-breaking | Minor / patch |

> [!IMPORTANT]
> Clients must be **tolerant readers**: ignore unknown fields rather than rejecting them, and branch on the stable `code` enum — never on `message` substrings or, for error handling, on HTTP status alone. A response gaining a new optional field, or an error gaining a new `code`, is explicitly non-breaking and can happen in any minor release.

---

## The canonical contract

The single source of truth for the wire format is the **OpenAPI 3.0.3 specification**, generated at runtime via [`@fastify/swagger`](reference/api.md#openapi-spec--interactive-docs):

| What | Path | Auth |
|------|------|------|
| Raw OpenAPI 3 spec (JSON) | `GET /openapi.json` | No |
| Swagger UI (interactive) | `GET /api/docs` | No |

Both are unauthenticated so CI tools, code generators, and reverse-proxy probes can pull the spec without minting a token. `info.version` in the spec is sourced from the build's `APP_VERSION`.

**Pin the snapshot.** For reproducible integrations, fetch `/openapi.json` from the version you build against and commit it to your repo. Diff it against a later instance's spec to detect drift before upgrading:

```bash
# Snapshot the contract you build against
curl -s https://deploy.example.com/openapi.json > openapi.pinned.json

# Later, before upgrading, diff against the new instance
curl -s https://deploy.example.com/openapi.json > openapi.new.json
diff <(jq -S . openapi.pinned.json) <(jq -S . openapi.new.json)
```

Where the spec models a deprecated field or parameter, it carries `deprecated: true` so generated clients and linters can surface it automatically. Spec coverage of deprecations is best-effort and still expanding, though — treat the [Current deprecations](#current-deprecations) table below as the authoritative, complete list rather than relying on a spec diff alone.

---

## Deprecation policy

We don't break things without warning. When an API surface needs to go away, it is first **deprecated**, kept working for a guaranteed window, and only then removed.

### Deprecation window

> A surface deprecated in a given release is supported through the **remainder of that major series** and is removed **no earlier than the next major release**.

Concretely: anything deprecated anywhere in `2.x` keeps working for all of `2.x` and is only eligible for removal in `3.0`. This gives integrators the full lifetime of a major series to migrate.

### How deprecations are signaled

Every deprecation is recorded in the two **authoritative** places below, and — where the spec models the affected field — surfaced in a third, machine-readable one:

1. **The [Current deprecations](#current-deprecations) table in this document** — the complete, always-current list with replacements and removal targets. This is the canonical record.
2. **An "API changes → Deprecated" entry in the release notes** — tells you *when* a surface was deprecated. See [Changelog discipline](#changelog-discipline) below.
3. **`deprecated: true` in `/openapi.json`** — machine-readable and picked up by code generators and OpenAPI linters, applied **where the spec models the deprecated field** (e.g. the sync `success` alias). Coverage is best-effort and still expanding, so don't rely on a spec diff alone to catch every deprecation.

If you're integrating, the table above is your source of truth; the release notes tell you when the clock started, and the spec annotations help your tooling flag the cases it already covers.

---

## Changelog discipline

Per-release notes live in the **annotated git tag message** for each release (rendered on the corresponding [GitHub Release](https://github.com/bridgeinpt/bridgeport/releases) page), not in a flat `CHANGELOG.md`. Every release's notes carry an explicit:

```markdown
## API changes

### Added
- New `GET /api/...` endpoint for ...

### Deprecated
- `<field>` on `<endpoint>` — use `<replacement>` instead. Removal target: <major>.

### Removed
- `<surface>` (deprecated in <version>) is gone — migrate to `<replacement>`.
```

This section is **required** in every release's notes and says `None` when there are no API-surface changes. It is the authoritative, dated record of additions, deprecations, and removals — distinct from feature/fix descriptions, which describe *behavior*, not *contract*.

---

## Version discovery

A running instance exposes a small amount of build metadata through the unauthenticated health endpoint:

```bash
curl -s https://deploy.example.com/health
```

```json
{
  "status": "ok",
  "timestamp": "2026-06-08T12:00:00.000Z",
  "version": "2026060812-a1b2c3d",
  "bundledAgentVersion": "2026053114-9f8e7d6",
  "cliVersion": "2026052010-1a2b3c4"
}
```

- `version` — the **build stamp** of the running backend, in the format `YYYYMMDDHH-{7-char SHA}`. Use it to identify exactly which build is deployed and to correlate with logs/Sentry releases.
- `bundledAgentVersion` / `cliVersion` — the agent and CLI binaries bundled with this build. `cliVersion` is the build served by `GET /api/downloads/cli`; `bundledAgentVersion` is the agent image this instance deploys to your servers.

> [!WARNING]
> **`version` is a build identifier, not a semantic version.** The `MAJOR.MINOR.PATCH` semver lives only in the git release tag (e.g. `v2.0.2`); the server does not currently expose its semver or a runtime capability list. So you **cannot** read the semver from `/health` today.
>
> For the wire contract, do not try to derive behavior from the build stamp — **pin against the `/openapi.json` snapshot** ([The canonical contract](#the-canonical-contract)) instead, and map the build stamp to a release by checking which tag it was cut from.

**Roadmap (not a present capability):** exposing the semantic version and a machine-readable capability list at runtime — to enable true client-side version/capability negotiation — is future work. Treat any such negotiation as not yet available; rely on the pinned spec for now.

---

## Current deprecations

The following surfaces are deprecated but still present. Per the [deprecation window](#deprecation-window) above, they remain available throughout `2.x` and are scheduled for removal in `3.0`.

| Surface | Deprecated in | Replacement | Removal target |
|---------|---------------|-------------|----------------|
| Sync response top-level `success: boolean` | 2.0 ([#127](https://github.com/bridgeinpt/bridgeport/issues/127)) | Use `status` (`'ok'` \| `'no_targets'` \| `'partial'` \| `'failed'`) | **3.0** (next major) |
| `services[]` flattened shape + `service.server` accessor | 2.0 | Read `service.serviceDeployments[]` | **3.0** (next major) |

### Sync response `success` alias

The sync endpoints (`POST /config-files/:id/sync-all`, `POST /services/:id/sync-files`, `POST /servers/:serverId/sync-all-files`) return:

```json
{
  "status": "partial",
  "targetsAttempted": 3,
  "targetsSucceeded": 2,
  "targetsFailed": 1,
  "results": [ ... ]
}
```

The richer `status` enum replaces the old top-level `success: boolean`. The boolean is kept as a deprecated alias (modeled as `deprecated: true` in the spec's shared `SyncResult` schema) for back-compat. Note that `status` carries information the boolean can't: a zero-target sync now returns `200` with `status: 'no_targets'` (previously a `400`), which you should surface as a warning rather than a green success — distinct from `'ok'`.

### Service → ServiceDeployment split

In `2.0` the service model was split: `Service` became a template (image, env, health, compose), and per-server runtime (container name, status, discovery, ports) moved to `ServiceDeployment`. For back-compat, responses still include a flattened `services[]` array (one row per deployment) and a `service.server`-style accessor that resolves to the first deployment's server. **New integrations should read `service.serviceDeployments[]`** rather than the flattened shape.

> [!NOTE]
> Both deprecations were originally annotated "for this release only" in code comments. Under this now-formalized policy, that note is superseded: their guaranteed removal target is the next major (`3.0`), and they remain fully supported throughout the `2.x` series. This document — not the code comments — is the authority on removal timing.

---

## Reporting issues & questions

- **Found a breaking change that wasn't announced?** That's a bug — open an issue on the [GitHub issue tracker](https://github.com/bridgeinpt/bridgeport/issues) with the `version` from `/health` and a `requestId` from the affected response.
- **Need a deprecation window extended, or unsure how to migrate?** Open an issue describing your integration; we'd rather hear about it before a major release than after.
- **Security-sensitive API behavior?** Follow the [Security Policy](SECURITY.md) — do not open a public issue.

---

## Related Docs

- [API Reference](reference/api.md) — Authentication, endpoints, and the error envelope in detail
- [Configuration Reference](configuration.md) — Environment variables and their compatibility notes
- [Upgrades](operations/upgrades.md) — How upgrades work, rollback, and agent updates
- [Security Policy](SECURITY.md) — Supported versions and vulnerability reporting
