# Audit Event Schema (export & drain contract)

> **Status: draft contract — no implementation yet.** This is the wire shape for
> [#330 (audit-log export & SIEM streaming)](https://github.com/bridgeinpt/bridgeport/issues/330):
> the CSV/JSON export download and the HTTP NDJSON drain both emit exactly this
> shape. SIEM parsers will depend on it, so once #330 ships this schema is
> covered by the [API stability policy](../api-stability.md) — additive changes
> only, breaking changes require a `schema` version bump. Update this file in
> the same PR as the #330 implementation.

## Event shape (JSON)

One event per `AuditLog` row. All fields always present; nullable fields are
`null`, never omitted (SIEM field-mapping stays stable).

```json
{
  "schema": 1,
  "id": "cmc3k2...",
  "timestamp": "2026-07-04T18:22:31.000Z",
  "action": "deploy",
  "resource_type": "service",
  "resource_id": "cmc1ab...",
  "resource_name": "api-backend",
  "environment_id": "cmc0env...",
  "environment_name": "production",
  "success": true,
  "error": null,
  "actor": {
    "type": "user",
    "user_id": "cmc9us...",
    "user_email": "ops@example.com",
    "service_account_id": null,
    "api_token_id": null
  },
  "details": { "imageTag": "2026070412-ab3f9c1" },
  "sync_batch_id": null
}
```

Field notes:

- `schema` — integer schema version, currently `1`. Bumped only on breaking
  changes.
- `id` — the `AuditLog` cuid. **Delivery is at-least-once; consumers dedup on
  `id`.**
- `timestamp` — `AuditLog.createdAt`, RFC3339 UTC with milliseconds.
- `action` / `resource_type` — the existing audit vocabulary (`deploy`,
  `restart`, `create`, `update`, `delete`, `access`, … × `service`, `server`,
  `secret`, `environment`, `config_file`, …). New values may be added at any
  time; consumers must tolerate unknown values.
- `actor.type` — `user` | `service_account` | `system`. When the actor was an
  API token, `api_token_id` is set and `service_account_id`/`user_id` identify
  its owner.
- `details` — the row's JSON details, parsed. Never contains secret values
  (guaranteed at write time by the audit layer, not by the exporter).
- `environment_name` / `user_email` are denormalized at export time for SIEM
  usability; they reflect current names, not names at event time.

## Transports

- **Export download** (`GET /api/audit/export?format=json|csv&…`): JSON format
  is NDJSON (one event per line); CSV flattens `actor.*` and serializes
  `details` as a JSON string column. Same filters as the audit list route.
- **Drain** (HTTP NDJSON): batches of up to the configured batch size, POSTed
  with `Content-Type: application/x-ndjson` and the configured auth header.
  A `2xx` response advances the cursor; anything else retries with backoff.
  Ordering within a batch follows `id` insertion order; cross-batch ordering is
  monotonic but delivery may repeat after a retry (dedup on `id`).

## Consumers to keep in mind

- #329's terminal-session events flow through this schema unchanged
  (`action: "terminal_session"`, `details` carries duration + transcript ref).
- Splunk HEC / Elastic / Datadog / vector examples belong in the #330 docs
  guide, not here — this file defines only the shape.
