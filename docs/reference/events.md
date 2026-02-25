# Server-Sent Events (SSE) Reference

BridgePort exposes a real-time event stream over Server-Sent Events so clients can react to health changes, deployments, notifications, and metric updates without polling.

## Table of Contents

- [Connecting](#connecting)
  - [Endpoint](#endpoint)
  - [Authentication](#authentication)
  - [Query Parameters](#query-parameters)
- [Event Types](#event-types)
  - [`health_status`](#health_status)
  - [`deployment_progress`](#deployment_progress)
  - [`notification`](#notification)
  - [`metrics_updated`](#metrics_updated)
  - [`container_discovery`](#container_discovery)
- [Environment Filtering](#environment-filtering)
- [Client Integration Examples](#client-integration-examples)
  - [Basic Connection](#basic-connection)
  - [Typed Event Handlers](#typed-event-handlers)
  - [Reconnection and Error Handling](#reconnection-and-error-handling)
- [Infrastructure Notes](#infrastructure-notes)
- [Related Docs](#related-docs)

---

## Connecting

### Endpoint

```
GET /api/events
```

The endpoint returns an unbounded `text/event-stream` response. Keep the connection open for the lifetime of the session.

### Authentication

The browser's `EventSource` API does not support custom request headers, so authentication is passed as a query parameter rather than an `Authorization` header. BridgePort accepts two token formats and tries them in order:

1. **API token** — A long-lived token created under *My Account*. Validated by hashing and looking up in the database. Recommended for scripts and server-side consumers.
2. **JWT** — The short-lived session token returned by `POST /api/auth/login`. Suitable for browser sessions where the JWT is already in memory.

If both checks fail the connection is rejected with `401 Unauthorized` before any SSE headers are written.

> [!WARNING]
> The token appears in the URL, which means it can appear in server access logs and browser history. Prefer API tokens over JWTs for long-running integrations, and scope access logs appropriately on your reverse proxy.

### Query Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `token` | Yes | JWT or API token for authentication |
| `environmentId` | No | When provided, events are filtered to only those belonging to this environment |

**Examples**

Connect without filtering (receives events across all environments):
```
GET /api/events?token=bp_api_xxxxxxxxxxxx
```

Connect scoped to a single environment:
```
GET /api/events?token=bp_api_xxxxxxxxxxxx&environmentId=env_abc123
```

---

## Event Types

Each event is delivered in standard SSE format:

```
event: <type>
data: <JSON payload>

```

The `event` field matches one of the five named types below. Clients should ignore unknown event types to remain forward-compatible.

> [!NOTE]
> BridgePort also sends SSE comment lines (`:ok` on connect, `:keepalive` every 30 seconds). These are not data events — the `EventSource` API silently discards them, but they keep the TCP connection alive through idle-timeout firewalls and load balancers.

---

### `health_status`

Fired when a scheduled health check produces a status change for a server or service.

**Emitted by**: the scheduler's server health check loop and the agent metrics ingest handler (`src/lib/scheduler.ts`).

**Payload**

| Field | Type | Description |
|-------|------|-------------|
| `resourceType` | `"server" \| "service"` | Whether the check was for a server or a container service |
| `resourceId` | `string` | ID of the server or service |
| `status` | `string` | New health status (e.g. `"healthy"`, `"unhealthy"`, `"degraded"`) |
| `environmentId` | `string` | Environment the resource belongs to |

**Example**

```json
{
  "resourceType": "service",
  "resourceId": "svc_9xk2mw",
  "status": "unhealthy",
  "environmentId": "env_abc123"
}
```

**When it fires**

- After each scheduled server health check cycle completes
- When the agent pushes metrics that include health data

---

### `deployment_progress`

Fired at key transitions during a deployment: when it starts, when it succeeds, and when it fails. Both standalone service deployments and orchestrated deployment plan steps emit this event.

**Emitted by**: `src/services/deploy.ts` (individual service deploys) and `src/services/orchestration.ts` (plan step transitions).

**Payload**

| Field | Type | Description |
|-------|------|-------------|
| `deploymentId` | `string \| undefined` | ID of the `Deployment` record (present for single-service deploys) |
| `planId` | `string \| undefined` | ID of the `DeploymentPlan` (present for orchestrated plan steps) |
| `serviceId` | `string` | ID of the service being deployed |
| `status` | `string` | One of: `"deploying"`, `"success"`, `"failed"`, `"running"`, `"completed"` |
| `environmentId` | `string` | Environment the deployment belongs to |

> [!NOTE]
> `deploymentId` and `planId` are mutually exclusive in practice. A standalone deploy sets `deploymentId`; an orchestrated plan step sets `planId`. Either or both may be `undefined` depending on the code path.

**Examples**

Single-service deployment starting:
```json
{
  "deploymentId": "dep_7rtn4q",
  "serviceId": "svc_9xk2mw",
  "status": "deploying",
  "environmentId": "env_abc123"
}
```

Orchestrated plan step completing:
```json
{
  "planId": "plan_2kmpf1",
  "serviceId": "svc_9xk2mw",
  "status": "completed",
  "environmentId": "env_abc123"
}
```

**When it fires**

| Emitter | `status` values |
|---------|----------------|
| `deploy.ts` | `deploying` (start), `success` (done), `failed` (error) |
| `orchestration.ts` | `running` (step starts), `completed` (step done), `failed` (step error) |

---

### `notification`

Fired when a new in-app notification is created for a specific user. Unlike other event types, `notification` events are **user-scoped**: a connected client only receives events where `userId` matches its own authenticated user ID. Other users' notification events are silently dropped.

**Emitted by**: `src/services/notifications.ts`, immediately after a notification record is created.

**Payload**

| Field | Type | Description |
|-------|------|-------------|
| `userId` | `string` | ID of the user the notification was created for |
| `count` | `number` | Always `1` — signals that one new notification arrived |

**Example**

```json
{
  "userId": "usr_4hn8vp",
  "count": 1
}
```

**When it fires**

Any time BridgePort creates a notification for the authenticated user: deployment failures, health state changes that trigger alerts, or other system events with notification types configured in *Admin → Notifications*.

> [!TIP]
> `count` is always `1` per event. To get the current unread total, call `GET /api/notifications/unread-count` after receiving this event. The `NotificationBell` component in the UI does exactly this.

---

### `metrics_updated`

Fired after a fresh set of server metrics has been collected and stored. Clients listening for this event should re-fetch the metrics they care about rather than relying on the event payload itself.

**Emitted by**: the scheduler's SSH metrics collection loop (`src/lib/scheduler.ts`), after metrics are written to the database.

**Payload**

| Field | Type | Description |
|-------|------|-------------|
| `serverId` | `string` | ID of the server whose metrics were updated |
| `environmentId` | `string` | Environment the server belongs to |

**Example**

```json
{
  "serverId": "srv_3qw8xz",
  "environmentId": "env_abc123"
}
```

**When it fires**

On each SSH metrics collection cycle for the server (interval controlled by `SCHEDULER_METRICS_INTERVAL`, default 300 seconds).

---

### `container_discovery`

Fired after BridgePort's scheduled container discovery scan completes for a server. The event signals that the server's container list may have changed; clients should re-fetch service data if they display live container state.

**Emitted by**: the scheduler's discovery loop (`src/lib/scheduler.ts`).

**Payload**

| Field | Type | Description |
|-------|------|-------------|
| `serverId` | `string` | ID of the server that was scanned |
| `environmentId` | `string` | Environment the server belongs to |

**Example**

```json
{
  "serverId": "srv_3qw8xz",
  "environmentId": "env_abc123"
}
```

**When it fires**

On each container discovery cycle (interval controlled by `SCHEDULER_DISCOVERY_INTERVAL`, default 300 seconds).

---

## Environment Filtering

Passing `environmentId` as a query parameter scopes the stream to a single environment. The filter is applied server-side: events whose payload does not contain a matching `environmentId` are dropped before being written to the response.

The `notification` event type does not carry an `environmentId` field. It is exempt from environment filtering and is delivered based solely on the user match.

**Without filtering**: the client receives events from all environments the server manages. Useful for admin dashboards that span environments.

**With filtering**: only events from the specified environment are delivered. This is the correct mode for most UI pages, which operate within a single selected environment.

---

## Client Integration Examples

### Basic Connection

```javascript
const token = 'bp_api_xxxxxxxxxxxx'; // or your JWT
const environmentId = 'env_abc123';

const es = new EventSource(
  `/api/events?token=${encodeURIComponent(token)}&environmentId=${environmentId}`
);

es.addEventListener('health_status', (e) => {
  const data = JSON.parse(e.data);
  console.log(`[health_status] ${data.resourceType} ${data.resourceId} → ${data.status}`);
});

es.addEventListener('deployment_progress', (e) => {
  const data = JSON.parse(e.data);
  console.log(`[deployment_progress] service ${data.serviceId} → ${data.status}`);
});

es.addEventListener('notification', (e) => {
  const data = JSON.parse(e.data);
  console.log(`[notification] ${data.count} new notification(s) for user ${data.userId}`);
});

es.addEventListener('metrics_updated', (e) => {
  const data = JSON.parse(e.data);
  console.log(`[metrics_updated] server ${data.serverId}`);
});

es.addEventListener('container_discovery', (e) => {
  const data = JSON.parse(e.data);
  console.log(`[container_discovery] server ${data.serverId}`);
});

es.onerror = (err) => {
  console.error('SSE error:', err);
};
```

### Typed Event Handlers

For TypeScript projects, import the `BridgePortEvent` discriminated union from the server codebase or define equivalent types on the client:

```typescript
type HealthStatusData = {
  resourceType: 'server' | 'service';
  resourceId: string;
  status: string;
  environmentId: string;
};

type DeploymentProgressData = {
  deploymentId?: string;
  planId?: string;
  serviceId: string;
  status: string;
  environmentId: string;
};

type NotificationData = {
  userId: string;
  count: number;
};

type MetricsUpdatedData = {
  serverId: string;
  environmentId: string;
};

type ContainerDiscoveryData = {
  serverId: string;
  environmentId: string;
};

function parseEvent<T>(e: MessageEvent): T {
  return JSON.parse(e.data) as T;
}

const es = new EventSource(`/api/events?token=${token}&environmentId=${environmentId}`);

es.addEventListener('health_status', (e) => {
  const data = parseEvent<HealthStatusData>(e);
  // data is fully typed
});

es.addEventListener('deployment_progress', (e) => {
  const data = parseEvent<DeploymentProgressData>(e);
});
```

### Reconnection and Error Handling

`EventSource` reconnects automatically after a dropped connection using an exponential back-off managed by the browser. The default retry interval is browser-defined (typically 3 seconds). You do not need to implement reconnection logic manually.

```javascript
const es = new EventSource(`/api/events?token=${token}`);

es.onopen = () => {
  console.log('SSE connected');
};

es.onerror = (e) => {
  // readyState 0 = CONNECTING (browser is retrying)
  // readyState 2 = CLOSED (gave up)
  if (es.readyState === EventSource.CLOSED) {
    console.error('SSE connection closed permanently');
  }
};

// Explicit teardown when no longer needed (e.g. component unmount in React)
function disconnect() {
  es.close();
}
```

> [!TIP]
> In React, close the `EventSource` in a `useEffect` cleanup function to prevent stale listeners when a component unmounts or when `environmentId` changes.
>
> ```typescript
> useEffect(() => {
>   const es = new EventSource(`/api/events?token=${token}&environmentId=${environmentId}`);
>   es.addEventListener('health_status', handler);
>   return () => es.close();
> }, [token, environmentId]);
> ```

---

## Infrastructure Notes

**Response headers**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

`X-Accel-Buffering: no` instructs nginx to disable proxy buffering for this response. Without it, nginx buffers chunks until a threshold is reached, causing events to arrive in delayed bursts rather than immediately. This header must survive your reverse proxy configuration — if you use a custom nginx config, ensure it does not override this header.

**Keepalive comments**

An `:ok` comment is sent immediately on connect to flush the response headers through any intermediate proxies. A `:keepalive` comment is then sent every 30 seconds. These are transparent to `EventSource` listeners but prevent idle connections from being closed by firewalls and load balancers with aggressive connection timeouts.

**Concurrent connection limit**

The event bus sets `EventEmitter.setMaxListeners(100)`, which means Node.js will not warn above 100 concurrent SSE subscribers. If your deployment routinely exceeds 100 simultaneous clients (e.g. a large team with multiple open tabs), increase this value in `src/lib/event-bus.ts`.

> [!WARNING]
> Each connected SSE client holds an open HTTP connection and an active `EventEmitter` listener. Under high concurrency, ensure your Node.js process and reverse proxy are configured with sufficient file descriptor limits and connection timeouts.

---

## Related Docs

- [API Reference](../api-reference.md) — Full REST API documentation
- [Webhooks](../webhooks.md) — Incoming CI/CD webhooks for deployment triggers
- [Monitoring](../monitoring.md) — Server and service monitoring configuration
- [Users and Roles](../users-and-roles.md) — API token creation and management
