# API Reference

BridgePort exposes a REST API on the same port as the web UI. All endpoints (except health and webhooks) require JWT authentication.

## Authentication

### Login

```
POST /api/auth/login
Content-Type: application/json

{
  "email": "admin@example.com",
  "password": "your-password"
}
```

Response:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": { "id": "...", "email": "admin@example.com", "role": "admin" }
}
```

Use the token in subsequent requests:
```
Authorization: Bearer <token>
```

### Get Current User

```
GET /api/auth/me
```

## Health

```
GET /health
```

Returns server status, timestamp, app version, bundled agent version, and CLI version. No authentication required.

---

## Environments

```
GET    /api/environments                          # List all environments
GET    /api/environments/:id                      # Get environment details
POST   /api/environments                          # Create environment (admin)
PUT    /api/environments/:id/ssh                  # Upload SSH key
GET    /api/environments/:id/ssh-key              # Get SSH credentials (for CLI)
```

### Environment Settings

```
GET    /api/environments/:id/settings/registry     # Get settings definitions
GET    /api/environments/:id/settings/:module      # Get module settings (admin)
PATCH  /api/environments/:id/settings/:module      # Update module settings (admin)
POST   /api/environments/:id/settings/:module/reset # Reset module to defaults (admin)
```

Modules: `general`, `monitoring`, `operations`, `data`, `configuration`

---

## Servers

```
GET    /api/environments/:envId/servers            # List servers
POST   /api/environments/:envId/servers            # Create server
GET    /api/servers/:id                            # Get server details
PATCH  /api/servers/:id                            # Update server
DELETE /api/servers/:id                            # Delete server (admin)
POST   /api/servers/:id/health                     # Run health check
POST   /api/servers/:id/discover                   # Discover containers
```

### Server Metrics

```
GET    /api/servers/:id/metrics                    # Get server metrics history
PATCH  /api/servers/:id/metrics-mode               # Update metrics mode
```

### Host Detection

```
GET    /api/servers/host-info                      # Get Docker host info
POST   /api/environments/:envId/servers/register-host # Register host server
```

### Terraform Import

```
POST   /api/environments/:envId/servers/import-terraform  # Bulk import servers
```

### Agent Management

```
POST   /api/servers/:id/agent/deploy               # Deploy agent to server
POST   /api/servers/:id/agent/remove               # Remove agent from server
GET    /api/servers/:id/agent/status               # Check agent status
```

### Config File Status

```
GET    /api/servers/:serverId/config-files-status  # Get sync status for all files
POST   /api/servers/:serverId/sync-all-files       # Sync all config files (operator)
```

---

## Services

```
GET    /api/servers/:serverId/services             # List services for server
GET    /api/services/:id                           # Get service details
POST   /api/servers/:serverId/services             # Create service
PATCH  /api/services/:id                           # Update service
DELETE /api/services/:id                           # Delete service
```

### Deployments

```
POST   /api/services/:id/deploy                    # Deploy new version
GET    /api/services/:id/deployments               # List deployment history
GET    /api/deployments/:id                        # Get deployment details
```

### Operations

```
POST   /api/services/:id/restart                   # Restart container
POST   /api/services/:id/health                    # Run health check
GET    /api/services/:id/logs                      # Get container logs
GET    /api/services/:id/logs/stream               # Stream container logs (SSE)
POST   /api/services/:id/check-updates             # Check for image updates
POST   /api/services/:id/run-command               # Run predefined command
GET    /api/services/:id/history                   # Get action history
GET    /api/services/:id/image-tags                # Get available image tags
```

### Config Files

```
GET    /api/services/:id/files                     # List attached config files
POST   /api/services/:id/files                     # Attach config file
DELETE /api/services/:serviceId/files/:fileId      # Detach config file
PATCH  /api/services/:serviceId/files/:fileId      # Update target path (operator)
POST   /api/services/:id/sync-files                # Sync all attached files (operator)
```

---

## Container Images

```
GET    /api/environments/:envId/container-images   # List container images
POST   /api/environments/:envId/container-images   # Create container image
GET    /api/container-images/:id                   # Get container image details
PATCH  /api/container-images/:id                   # Update container image
DELETE /api/container-images/:id                   # Delete container image
POST   /api/container-images/:id/deploy            # Deploy to all linked services
POST   /api/container-images/:id/check-updates     # Check for registry updates
GET    /api/container-images/:id/tags              # Get tag history
```

---

## Registry Connections

```
GET    /api/environments/:envId/registries         # List registries
POST   /api/environments/:envId/registries         # Create registry connection
GET    /api/registries/:id                         # Get registry details
PATCH  /api/registries/:id                         # Update registry
DELETE /api/registries/:id                         # Delete registry
POST   /api/registries/:id/test                    # Test connection
GET    /api/registries/:id/repositories            # List repositories
GET    /api/registries/:id/repositories/:repo/tags # List tags for repository
GET    /api/registries/:id/services                # List linked services
POST   /api/registries/:id/check-updates           # Check all linked services for updates
```

---

## Secrets

```
GET    /api/environments/:envId/secrets            # List secrets (with usage info)
POST   /api/environments/:envId/secrets            # Create secret
GET    /api/secrets/:id/value                      # Get decrypted value
PATCH  /api/secrets/:id                            # Update secret
DELETE /api/secrets/:id                            # Delete secret
```

---

## Config Files

```
GET    /api/environments/:envId/config-files       # List config files (with sync status)
POST   /api/environments/:envId/config-files       # Create config file (operator)
POST   /api/environments/:envId/asset-files/upload # Upload binary file (operator)
GET    /api/config-files/:id                       # Get config file with content
PATCH  /api/config-files/:id                       # Update config file (operator)
DELETE /api/config-files/:id                       # Delete config file (operator)
GET    /api/config-files/:id/history               # Get edit history
POST   /api/config-files/:id/restore/:historyId   # Restore from history (operator)
POST   /api/config-files/:id/sync-all             # Sync to all attached services (operator)
```

---

## Databases

```
GET    /api/environments/:envId/databases          # List databases
POST   /api/environments/:envId/databases          # Create database (operator)
GET    /api/databases/:id                          # Get database details
PATCH  /api/databases/:id                          # Update database (operator)
DELETE /api/databases/:id                          # Delete database (operator)
```

### Backups

```
POST   /api/databases/:id/backups                  # Create backup (operator)
GET    /api/databases/:id/backups                  # List backups
GET    /api/backups/:id                            # Get backup details
GET    /api/backups/:id/download                   # Download backup file
DELETE /api/backups/:id                            # Delete backup (operator)
```

### Backup Schedule

```
GET    /api/databases/:id/schedule                 # Get backup schedule
PUT    /api/databases/:id/schedule                 # Set backup schedule (operator)
DELETE /api/databases/:id/schedule                 # Delete backup schedule (operator)
```

### Database Monitoring

```
GET    /api/environments/:envId/databases/monitoring-summary       # Get monitoring summary
GET    /api/environments/:envId/databases/metrics/history          # Get metrics history (charts)
GET    /api/environments/:envId/databases/:id/metrics              # Get metrics for one database
POST   /api/environments/:envId/databases/:id/test-connection      # Test monitoring connection
PATCH  /api/environments/:envId/databases/:id/monitoring           # Update monitoring config (operator)
```

---

## Metrics

```
GET    /api/servers/:id/metrics                    # Server metrics history
GET    /api/services/:id/metrics                   # Service metrics history
GET    /api/environments/:envId/metrics/summary    # Environment metrics summary
POST   /api/metrics/ingest                         # Agent metrics push (agent token auth)
```

---

## Monitoring

```
GET    /api/monitoring/health-logs                 # List health check logs (filterable)
GET    /api/monitoring/health-logs/:id             # Get single health log
GET    /api/monitoring/metrics-history             # Server/service metrics over time
POST   /api/monitoring/test-ssh/:serverId          # Test SSH connectivity
```

---

## Users

```
GET    /api/users                                  # List users (admin)
GET    /api/users/active                           # List active users (admin)
POST   /api/users                                  # Create user (admin)
PATCH  /api/users/:id                              # Update user (admin or self)
DELETE /api/users/:id                              # Delete user (admin)
POST   /api/users/:id/change-password              # Change password (admin or self)
```

---

## Audit Logs

```
GET    /api/audit                                  # List audit logs (filterable)
GET    /api/audit/:id                              # Get audit log details
```

---

## Webhooks

No authentication required (uses signature verification instead):

```
POST   /api/webhooks/deploy                        # Deploy a service
POST   /api/webhooks/deploy-image                  # Deploy all services for an image
POST   /api/webhooks/github                        # GitHub webhook handler
```

See [Webhooks](webhooks.md) for detailed usage.

---

## Settings (Admin)

### Service Types

```
GET    /api/settings/service-types                 # List service types
POST   /api/settings/service-types                 # Create service type
GET    /api/settings/service-types/:id             # Get service type
PATCH  /api/settings/service-types/:id             # Update service type
DELETE /api/settings/service-types/:id             # Delete service type
POST   /api/settings/service-types/:id/commands    # Add command
DELETE /api/settings/service-types/:typeId/commands/:cmdId  # Remove command
```

### Database Types

```
GET    /api/settings/database-types                # List database types
```

### Spaces Configuration

```
GET    /api/settings/spaces                        # Get global Spaces config
PUT    /api/settings/spaces                        # Update global Spaces config
GET    /api/settings/spaces/environments           # Per-environment Spaces settings
PUT    /api/settings/spaces/environments/:id       # Update environment Spaces
```

### System Settings

```
GET    /api/settings/system                        # Get system settings
PATCH  /api/settings/system                        # Update system settings
POST   /api/settings/system/reset                  # Reset to defaults
```

---

## Downloads

```
GET    /api/downloads/cli                          # List CLI downloads (versions, sizes)
GET    /api/downloads/cli/:os/:arch                # Download CLI binary
```

Supported platforms: `darwin/amd64`, `darwin/arm64`, `linux/amd64`, `linux/arm64`
