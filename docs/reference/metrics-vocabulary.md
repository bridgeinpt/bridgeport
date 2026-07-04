# Metrics Vocabulary (shared contract)

> **Status: draft contract — no implementation yet.** This document is the single
> source of truth referenced by [#318 (metric threshold alerting)](https://github.com/bridgeinpt/bridgeport/issues/318)
> and [#325 (Prometheus/OpenMetrics export)](https://github.com/bridgeinpt/bridgeport/issues/325).
> Both features MUST use these identifiers so a BRIDGEPORT alert rule and a
> Grafana alert on the same metric mean the same thing. Update this file in the
> same PR as either implementation; once #325 ships, names and labels below are
> covered by the [API stability policy](../api-stability.md).

## Conventions

- Exported metric names are prefixed `bridgeport_` and follow Prometheus naming
  rules: base units (`bytes`, `seconds`, `ratio`), `_total` suffix for counters.
- Stored values that use MB/GB (`ServerMetrics.memoryUsedMb`,
  `diskUsedGb`, …) are **converted to bytes by the exporter**; the stored schema
  is unchanged.
- Alert rules (#318) reference the short **rule metric id** (left column), which
  maps 1:1 to the exported name. Rule ids are stable API values.

## Labels

| Label | Applies to | Source |
|---|---|---|
| `environment` | all | `Environment.name` |
| `server` | server metrics | `Server.name` |
| `service` | container metrics | `Service.name` |
| `deployment` | container metrics | `ServiceDeployment` (server name) |
| `database` | database metrics | `Database.name` |

Label values are resource display names, never secrets or connection details.

## Server metrics (source: `ServerMetrics`)

| Rule id | Exported name | Type | Notes |
|---|---|---|---|
| `cpu` | `bridgeport_server_cpu_percent` | gauge | 0–100 |
| `memory` | `bridgeport_server_memory_used_bytes` | gauge | with `bridgeport_server_memory_total_bytes` |
| `swap` | `bridgeport_server_swap_used_bytes` | gauge | with `..._total_bytes` |
| `disk` | `bridgeport_server_disk_used_bytes` | gauge | with `..._total_bytes` |
| `load1` / `load5` / `load15` | `bridgeport_server_load1` / `load5` / `load15` | gauge | |
| `uptime` | `bridgeport_server_uptime_seconds` | gauge | |
| `open_fds` | `bridgeport_server_open_fds` | gauge | with `bridgeport_server_max_fds` |
| `tcp_established` | `bridgeport_server_tcp_connections{state="established"}` | gauge | also `listen`, `time_wait`, `close_wait`, `total` |

For threshold rules on `memory` / `swap` / `disk`, the evaluator compares the
**used/total percentage**, not raw bytes — rules read "disk > 85%".

## Container metrics (source: `ServiceMetrics`)

| Rule id | Exported name | Type | Notes |
|---|---|---|---|
| `cpu` | `bridgeport_container_cpu_percent` | gauge | |
| `memory` | `bridgeport_container_memory_used_bytes` | gauge | with `..._limit_bytes` when a limit is set |
| `network_rx` / `network_tx` | `bridgeport_container_network_receive_bytes_total` / `..._transmit_bytes_total` | counter | |
| `block_read` / `block_write` | `bridgeport_container_block_read_bytes_total` / `..._write_bytes_total` | counter | |
| `restart_count` | `bridgeport_container_restarts_total` | counter | crash-loop rules evaluate the delta over the rule window |
| `oom_killed` | `bridgeport_container_oom_killed` | gauge (0/1) | requires the agent version introduced by #318; absent otherwise |

## Health & status (denormalized read cache)

| Exported name | Type | Notes |
|---|---|---|
| `bridgeport_server_up` | gauge (0/1) | from last health/agent state |
| `bridgeport_service_health` | gauge (0/1) | from `lastHealthCheck*` on `ServiceDeployment` |
| `bridgeport_database_up` | gauge (0/1) | from database monitoring |

Status gauges are exported for scraping but are **not** valid threshold-rule
metrics in #318 — state transitions already alert through the existing
health-check notification types.

## Database metrics (source: `DatabaseMetrics.metricsJson`)

Plugin-defined query results are exported as
`bridgeport_database_metric{database="...", metric="<json key>"}` gauges for
numeric values only. Because keys are plugin-defined, they are exempt from the
stability policy; pin plugins if you depend on them.

## BRIDGEPORT self-metrics (#325 bonus namespace)

`bridgeport_scheduler_job_duration_seconds`, `bridgeport_notification_queue_depth`,
`bridgeport_build_info{version="..."}` — exporter-internal, not rule targets.
