# Registry Connections

Registry connections link BridgePort to your container registries, enabling update detection, tag browsing, and automated deployments.

## Supported Registry Types

| Type | Description |
|------|-------------|
| **DigitalOcean** | DigitalOcean Container Registry (API-based) |
| **Docker Hub** | Docker Hub (Hub API) |
| **Generic** | Any Docker Registry V2 compatible registry (Harbor, GitLab, GitHub Container Registry, etc.) |

## Creating a Registry Connection

1. Navigate to **Registries** in the sidebar
2. Click **Add Registry**
3. Select the registry type
4. Enter:
   - **Name** — A friendly name (e.g., "Production Registry")
   - **Registry URL** — The registry endpoint
   - **Repository Prefix** — Optional prefix to narrow repository listing
   - **Credentials** — Token, or username/password depending on registry type
5. Click **Test Connection** to verify

Credentials are encrypted at rest.

## Authentication

Each registry type accepts different credentials:

- **DigitalOcean**: API token
- **Docker Hub**: Username and password (or access token)
- **Generic**: Username and password, or token

## Refresh Interval

Each registry has a configurable refresh interval (5 minutes to 24 hours, default: 30 minutes). This controls how often BridgePort checks the registry for new tags.

## Auto-Link Pattern

Set an auto-link pattern on a registry to automatically link newly discovered services to this registry. When a container is discovered whose image name matches the pattern, BridgePort creates a container image linked to this registry.

## Browsing Repositories and Tags

From the registry detail page:
- **Repositories** — List all repositories in the registry
- **Tags** — View all tags for a specific repository

## Checking for Updates

### Per-Registry

Click **Check Updates** on a registry to check all linked services at once. The results show which services have updates available.

### Per-Service

Individual services with a registry link can also be checked individually from their detail page.

## Linked Services

The registry detail page shows all services that use images from this registry, along with:
- Current tag vs. latest tag
- Whether auto-update is enabled
- Last check timestamp

## Deleting a Registry

A registry cannot be deleted if container images are still linked to it. Unlink or delete the container images first, then delete the registry.
