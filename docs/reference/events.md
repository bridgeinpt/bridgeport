# Real-Time Events (SSE) Reference

BridgePort exposes a Server-Sent Events endpoint for live updates -- health status changes, deployment progress, new notifications, metric refreshes, and container discovery events stream to connected clients without polling.

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

Returns an unbounded `text/event-stream` response. Keep the connection open for the lifetime of the session.

### Authentication

The browser `EventSource` API does not support custom request headers, so authentication is passed as a query parameter. BridgePort accepts two token formats and tries them in order:

1. **API token** -- A long-lived token created under My Account or via `POST /api/auth/tokens`. Validated by hashing and looking up in the database. Recommended for scripts and server-side consumers.
2. **JWT** -- The short-lived session token returned by `POST /api/auth/login`. Suitable for browser sessions where the JWT is already in memory.

If both checks fail, the connection is rejected with `401 Unauthorized` before any SSE headers are written.

> [!WARNING]
> The token appears in the URL, which means it can show up in server access logs and browser history. Prefer API tokens over JWTs for long-running integrations, and scope access logs appropriately on your reverse proxy.

### Query Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `token` | Yes | JWT or API token for authentication |
| `environmentId` | No | Scope events to a single environment |

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
> BridgePort also sends SSE comment lines (`:ok` on connect, `:keepalive` every 30 seconds). These are not data events -- the `EventSource` API silently discards them, but they keep the TCP connection alive through idle-timeout firewalls and load balancers.

---

### `health_status`

Fired when a scheduled health check produces a status change for a server or service.

**Payload**

| Field | Type | Description |
|-------|------|-------------|
| `resourceType` | `"server" \| "service"` | Whether the check targeted a server or a container service |
| `resourceId` | `string` | ID of the server or service |
| `status` | `string` | New health status (e.g., `"healthy"`, `"unhealthy"`, `"degraded"`) |
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

Fired at key transitions during a deployment: start, success, and failure. Both standalone service deployments and orchestrated deployment plan steps emit this event.

**Payload**

| Field | Type | Description |
|-------|------|-------------|
| `deploymentId` | `string \| undefined` | ID of the `Deployment` record (present for single-service deploys) |
| `planId` | `string \| undefined` | ID of the `DeploymentPlan` (present for orchestrated plan steps) |
| `serviceId` | `string` | ID of the service being deployed |
| `status` | `string` | One of: `"deploying"`, `"success"`, `"failed"`, `"running"`, `"completed"` |
| `environmentId` | `string` | Environment the deployment belongs to |

> [!NOTE]
> `deploymentId` and `planId` are mutually exclusive in practice. A standalone deploy sets `deploymentId`; an orchestrated plan step sets `planId`. Either may be `undefined` depending on the code path.

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

**Status values by emitter**

| Source | Status values |
|--------|--------------|
| `deploy.ts` (individual) | `deploying`, `success`, `failed` |
| `orchestration.ts` (plan) | `running`, `completed`, `failed` |

---

### `notification`

Fired when a new in-app notification is created for a specific user. Unlike other event types, `notification` events are **user-scoped**: a connected client only receives events where `userId` matches its own authenticated user ID. Other users' notification events are silently dropped.

**Payload**

| Field | Type | Description |
|-------|------|-------------|
| `userId` | `string` | ID of the user the notification was created for |
| `count` | `number` | Always `1` -- signals that one new notification arrived |

**Example**

```json
{
  "userId": "usr_4hn8vp",
  "count": 1
}
```

**When it fires**

Any time BridgePort creates a notification for the authenticated user: deployment failures, health state changes that trigger alerts, or other system events with notification types configured in Admin > Notifications.

> [!TIP]
> `count` is always `1` per event. To get the current unread total, call `GET /api/notifications/unread-count` after receiving this event.

---

### `metrics_updated`

Fired after a fresh set of server metrics has been collected and stored. Clients listening for this event should re-fetch the metrics they care about rather than relying on the event payload itself.

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

On each metrics collection cycle for the server. The interval depends on the metrics mode:
- **SSH polling**: controlled by `metricsIntervalMs` in environment monitoring settings (default: 300,000 ms)
- **Agent push**: controlled by the agent's `-interval` flag (default: 30s)

---

### `container_discovery`

Fired after BridgePort's scheduled container discovery scan completes for a server. The event signals that the server's container list may have changed; clients should re-fetch service data if they display live container state.

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

On each container discovery cycle (interval controlled by `discoveryIntervalMs` in environment monitoring settings, default: 300,000 ms).

---

## Environment Filtering

Passing `environmentId` as a query parameter scopes the stream to a single environment. The filter is applied server-side: events whose payload does not contain a matching `environmentId` are dropped before being written to the response.

The `notification` event type does not carry an `environmentId` field. It is exempt from environment filtering and is always delivered based on user match.

**Without filtering**: the client receives events from all environments. Useful for admin dashboards.

**With filtering**: only events from the specified environment are delivered. This is the correct mode for most UI pages that operate within a single environment.

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
  console.log(`[health] ${data.resourceType} ${data.resourceId} -> ${data.status}`);
});

es.addEventListener('deployment_progress', (e) => {
  const data = JSON.parse(e.data);
  console.log(`[deploy] service ${data.serviceId} -> ${data.status}`);
});

es.addEventListener('notification', (e) => {
  const data = JSON.parse(e.data);
  console.log(`[notification] ${data.count} new for user ${data.userId}`);
});

es.addEventListener('metrics_updated', (e) => {
  const data = JSON.parse(e.data);
  console.log(`[metrics] server ${data.serverId} updated`);
});

es.addEventListener('container_discovery', (e) => {
  const data = JSON.parse(e.data);
  console.log(`[discovery] server ${data.serverId} scanned`);
});

es.onerror = (err) => {
  console.error('SSE error:', err);
};
```

### Typed Event Handlers

For TypeScript projects, define equivalent types on the client:

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

const es = new EventSource(`/api/events?token=${token}&environmentId=${envId}`);

es.addEventListener('health_status', (e) => {
  const data = parseEvent<HealthStatusData>(e);
  // data is fully typed
});

es.addEventListener('deployment_progress', (e) => {
  const data = parseEvent<DeploymentProgressData>(e);
});
```

### Reconnection and Error Handling

`EventSource` reconnects automatically after a dropped connection with browser-managed exponential backoff (typically starting at 3 seconds). You do not need to implement reconnection logic manually.

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

// Clean up when done (e.g., component unmount)
function disconnect() {
  es.close();
}
```

> [!TIP]
> In React, close the `EventSource` in a `useEffect` cleanup function to prevent stale listeners:
>
> ```typescript
> useEffect(() => {
>   const es = new EventSource(`/api/events?token=${token}&environmentId=${envId}`);
>   es.addEventListener('health_status', handler);
>   return () => es.close();
> }, [token, envId]);
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

`X-Accel-Buffering: no` instructs nginx to disable proxy buffering for this response. Without it, nginx buffers chunks until a threshold is reached, causing events to arrive in delayed bursts. Ensure your reverse proxy configuration does not override this header.

**Keepalive comments**

An `:ok` comment is sent immediately on connect to flush the response headers through intermediate proxies. A `:keepalive` comment is sent every 30 seconds. These are transparent to `EventSource` listeners but prevent idle connections from being closed by firewalls and load balancers with aggressive timeouts.

**Concurrent connection limit**

The event bus sets `EventEmitter.setMaxListeners(100)`, meaning Node.js will not warn below 100 concurrent SSE subscribers. If your deployment exceeds 100 simultaneous clients (e.g., a large team with multiple open tabs), increase this value in `src/lib/event-bus.ts`.

> [!WARNING]
> Each SSE client holds an open HTTP connection and an active `EventEmitter` listener. Under high concurrency, ensure your Node.js process and reverse proxy have sufficient file descriptor limits and connection timeouts.

---

## Related Docs

- [API Reference](api.md) -- REST API authentication and endpoints
- [Agent Reference](agent.md) -- Monitoring agent that triggers `metrics_updated` events
- [Environment Settings](environment-settings.md) -- Monitoring intervals that affect event frequency
