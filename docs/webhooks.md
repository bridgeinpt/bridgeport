# Webhooks

BridgePort provides webhook endpoints for integrating with CI/CD pipelines. Use webhooks to trigger deployments automatically when new images are built.

## Webhook Types

### Deploy Webhook

Deploys a specific service by name or ID.

**Endpoint**: `POST /api/webhooks/deploy`

**Headers**:
- `X-Webhook-Signature` — HMAC-SHA256 signature of the request body (required if `WEBHOOK_SECRET` is set)

**Body**:
```json
{
  "service": "app-api",
  "environment": "production",
  "imageTag": "v1.2.3",
  "generateArtifacts": false
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `service` | Yes | Service name or ID |
| `environment` | Yes | Environment name |
| `imageTag` | No | Tag to deploy (defaults to current) |
| `generateArtifacts` | No | Whether to generate deployment artifacts (default: false) |

**Response**:
```json
{
  "success": true,
  "deploymentId": "abc-123",
  "status": "success"
}
```

### Deploy Image Webhook

Deploys a new tag to all services linked to a container image. Only triggers if the container image has `autoUpdate` enabled.

**Endpoint**: `POST /api/webhooks/deploy-image`

**Headers**:
- `X-Webhook-Signature` — HMAC-SHA256 signature (required if `WEBHOOK_SECRET` is set)

**Body**:
```json
{
  "imageName": "registry.example.com/app-api",
  "environment": "production",
  "imageTag": "v1.2.3"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `imageName` | Yes | Full Docker image name (must match a registered container image) |
| `environment` | Yes | Environment name |
| `imageTag` | Yes | Tag to deploy |

**Response**:
```json
{
  "success": true,
  "planId": "plan-123",
  "serviceCount": 3,
  "services": ["app-api-1", "app-api-2", "app-api-3"]
}
```

> **Note**: The container image must have `autoUpdate` enabled. If it exists but autoUpdate is disabled, the webhook returns a 400 error with a hint to enable it.

### GitHub Webhook

Handles GitHub webhook events, specifically the `package` published event for container registries.

**Endpoint**: `POST /api/webhooks/github`

**Headers**:
- `X-Hub-Signature-256` — GitHub's HMAC-SHA256 signature (verified if `GITHUB_WEBHOOK_SECRET` is set)
- `X-GitHub-Event` — The event type (e.g., `package`)

When a `package` event with action `published` is received, BridgePort finds all services whose image name matches the package name and deploys the new version.

## Signature Verification

### Custom Webhook Signature

Set `WEBHOOK_SECRET` in your `.env` file. Then compute the signature in your CI/CD pipeline:

```bash
# Generate signature
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')

# Send webhook
curl -X POST https://deploy.example.com/api/webhooks/deploy \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: $SIGNATURE" \
  -d "$BODY"
```

### GitHub Signature

Set `GITHUB_WEBHOOK_SECRET` in your `.env` file and configure the same secret in your GitHub repository's webhook settings. GitHub automatically signs all webhook deliveries.

## CI/CD Integration Examples

### GitHub Actions

```yaml
- name: Deploy to BridgePort
  run: |
    BODY='{"service":"app-api","environment":"production","imageTag":"${{ github.sha }}"}'
    SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "${{ secrets.WEBHOOK_SECRET }}" | awk '{print $2}')
    curl -X POST https://deploy.example.com/api/webhooks/deploy \
      -H "Content-Type: application/json" \
      -H "X-Webhook-Signature: $SIGNATURE" \
      -d "$BODY"
```

### GitLab CI

```yaml
deploy:
  stage: deploy
  script:
    - BODY='{"service":"app-api","environment":"production","imageTag":"'"$CI_COMMIT_SHA"'"}'
    - SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
    - |
      curl -X POST https://deploy.example.com/api/webhooks/deploy \
        -H "Content-Type: application/json" \
        -H "X-Webhook-Signature: $SIGNATURE" \
        -d "$BODY"
```

### Image-Based Deployment

For deploying to multiple servers at once, use the deploy-image webhook:

```bash
BODY='{"imageName":"registry.example.com/app-api","environment":"production","imageTag":"v1.2.3"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
curl -X POST https://deploy.example.com/api/webhooks/deploy-image \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: $SIGNATURE" \
  -d "$BODY"
```

This creates a deployment plan for all services linked to the `app-api` container image and executes them.
