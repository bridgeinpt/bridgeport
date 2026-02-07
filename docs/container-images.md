# Container Images

Container images are a central concept in BridgePort that decouple image management from individual services. A single container image definition can be shared across multiple services, making it easy to deploy the same image to multiple servers at once.

## Overview

A container image definition includes:
- **Name** — A friendly display name (e.g., "App API")
- **Image Name** — The full Docker image name (e.g., `registry.example.com/app-api`)
- **Current Tag** — The tag currently considered "deployed" for this image
- **Registry Connection** — Optional link to a registry for update checking
- **Auto-Update** — Whether to automatically deploy new versions

## Creating a Container Image

1. Navigate to **Container Images** in the sidebar
2. Click **Create Image**
3. Enter the name, full image name, and current tag
4. Optionally link it to a registry connection

Container images can also be created automatically during container discovery.

## Linking to Services

Multiple services can reference the same container image. This is common when you run the same application on multiple servers (e.g., `app-api` on `server-1` and `server-2`).

When you deploy a new tag for a container image, all linked services can be updated at once.

## Registry Integration

Linking a container image to a registry connection enables:

- **Tag Listing** — View all available tags from the registry
- **Update Detection** — BridgePort periodically checks for new tags
- **Digest Comparison** — For `latest` tags, BridgePort compares digests to detect changes

## Update Checking

BridgePort checks for updates in two ways:

- **Scheduled**: The background scheduler checks all registry-linked images at the configured interval
- **Manual**: Click "Check Updates" on a service or use the "Check All" button on a registry

When a new tag is detected, the `latestTag` and `latestDigest` fields are updated, and an "Update available" badge appears on linked services.

## Auto-Update

When auto-update is enabled on a container image:

1. BridgePort detects a new version in the registry
2. A deployment plan is created for all linked services
3. The plan is executed automatically, deploying the new tag to each service

Enable auto-update on the container image detail page or via the API:

```bash
PATCH /api/container-images/:id
{ "autoUpdate": true }
```

> **Tip**: Auto-update is best suited for staging environments. For production, use webhooks or manual deployments for more control.

## Deploying an Image

Deploy a specific tag to all services linked to a container image:

1. Go to the container image detail page
2. Click **Deploy**
3. Select the tag to deploy
4. BridgePort creates an orchestration plan and deploys to all linked services

This is also available via webhook. See [Webhooks](webhooks.md) for CI/CD integration.

## Tag History

BridgePort tracks the history of tags deployed for each container image, giving you visibility into what was deployed when.
