# Services

Services represent Docker containers running on your servers. BridgePort lets you deploy, restart, monitor, and manage services through the web UI, CLI, or API.

## Creating a Service

There are two ways to add services:

### Container Discovery (Recommended)

1. Go to a server's detail page
2. Click **Discover**
3. BridgePort lists all running containers not yet registered
4. Select which containers to add as services

### Manual Creation

1. Go to a server's detail page
2. Click **Create Service**
3. Enter:
   - **Name** — Display name for the service
   - **Container Name** — The Docker container name on the server
   - **Container Image** — Select or create a container image definition
   - **Image Tag** — The currently deployed tag (e.g., `latest`, `v1.2.3`)

## Deploying a Service

To deploy a new version:

1. Go to the service detail page
2. Click **Deploy**
3. Select an image tag (if a registry is connected, available tags are shown)
4. Confirm the deployment

BridgePort will:
1. Pull the new image on the server
2. Stop the current container
3. Start the container with the new image
4. Run a health check to verify the deployment

Deployments are audit-logged with the image tag, who triggered it, and the result.

### Deployment History

Every deployment is recorded. View deployment history on the service detail page to see:
- Image tag deployed
- Who triggered it (user, webhook, or auto-update)
- Timestamp
- Success/failure status

## Restarting a Service

Click **Restart** on the service detail page to restart the container without changing the image. This runs `docker restart` on the container.

## Health Checks

Services support two types of health checks:

### Container Health Check

BridgePort connects to the server and checks the container's state:
- Is the container running?
- Does Docker report it as healthy? (if Docker health checks are configured)
- What ports are exposed?

### URL Health Check

If you configure a `healthCheckUrl` on the service, BridgePort will also make an HTTP request to that URL and verify it returns a success status code.

### Deployment Health Checks

During deployment, BridgePort can automatically verify the service is healthy:
- **Health Wait** — Time to wait before checking (ms)
- **Health Retries** — Number of health check attempts
- **Health Interval** — Time between retry attempts (ms)

Configure these on the service detail page.

## Service Types

Assign a service type (e.g., Django, Node.js) to enable predefined commands:

1. Go to the service detail page
2. Set the **Service Type**

Once assigned, you can run predefined commands directly from the UI or CLI:

- **Shell** — Open an interactive shell in the container
- **Migrate** — Run database migrations
- **Collectstatic** — Collect static files (Django)
- Custom commands defined in the service type

Run commands from the CLI:
```bash
bridgeport run staging app-api app-api migrate
```

Manage service types at **Settings > Service Types** (admin only). See [Configuration Reference](configuration.md) for details.

## Container Logs

View container logs from the service detail page. Logs are streamed in real-time with support for:
- Stdout and stderr differentiation
- Tail mode (last N lines)
- Follow mode (live streaming)

From the CLI:
```bash
bridgeport logs staging app-api app-api -f --tail 100
```

## Config Files

Attach configuration files to services to sync them to the server. See [Config Files](config-files.md) for details.

## Update Checking

If the service's container image is linked to a registry, BridgePort can check for new image versions:
- **Manual**: Click "Check Updates" on the service
- **Automatic**: The scheduler checks at the configured interval

When an update is available, the UI shows an "Update available" badge with the latest tag.

## Auto-Update

Enable auto-update on the **container image** (not the service) to automatically deploy new versions when detected. This is useful for staging environments or services that should always run the latest version.

See [Container Images](container-images.md) for details.

## Deleting a Service

Delete a service from its detail page. This only removes BridgePort's record — the Docker container on the server is not affected.
