---
allowed-tools: Bash, Read
description: Build BRIDGEPORT Docker image
---

# Build Docker Image

Build the BRIDGEPORT Docker image for deployment.

## Steps

1. Get the current git commit info for versioning
2. Build the Docker image with version tags:

```bash
# Get version info
VERSION=$(date +%Y%m%d%H)-$(git rev-parse --short HEAD)
AGENT_VERSION=$(git log -1 --format='%cd-%h' --date=format:'%Y%m%d' -- bridgeport-agent/)
CLI_VERSION=$(git log -1 --format='%cd-%h' --date=format:'%Y%m%d' -- cli/)

# Build the image
docker build \
  --build-arg APP_VERSION=$VERSION \
  --build-arg AGENT_VERSION=$AGENT_VERSION \
  --build-arg CLI_VERSION=$CLI_VERSION \
  -f docker/Dockerfile \
  -t bridgeport:$VERSION \
  -t bridgeport:latest \
  .
```

## Output

The build creates a Docker image tagged with:
- `bridgeport:<date>-<sha>` - specific version
- `bridgeport:latest` - latest build

To view the built images:
```bash
docker images bridgeport
```
