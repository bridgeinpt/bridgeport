# Getting Started

This guide walks you through deploying BridgePort with Docker and completing initial setup.

## Prerequisites

- A Linux server (or any machine) with Docker and Docker Compose installed
- A domain name (optional, but recommended for production)

## Installation

### 1. Create a directory

```bash
mkdir -p /opt/bridgeport && cd /opt/bridgeport
```

### 2. Create your `.env` file

```bash
cat > .env << 'EOF'
DATABASE_URL=file:/data/bridgeport.db
MASTER_KEY=<run: openssl rand -base64 32>
JWT_SECRET=<run: openssl rand -base64 32>
HOST=0.0.0.0
PORT=3000
NODE_ENV=production

# Initial admin user (created on first boot)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your-secure-password
EOF
```

Generate the required secrets:

```bash
# Generate and replace MASTER_KEY
sed -i "s|<run: openssl rand -base64 32>|$(openssl rand -base64 32)|" .env
# Generate and replace JWT_SECRET (run again for a different value)
sed -i "0,/<run: openssl rand -base64 32>/s|<run: openssl rand -base64 32>|$(openssl rand -base64 32)|" .env
```

> **Important**: Back up your `MASTER_KEY` separately (e.g., in a password manager). It is required to decrypt secrets and SSH keys stored in the database. Without it, encrypted data cannot be recovered.

### 3. Create `docker-compose.yml`

```yaml
version: '3.8'
services:
  bridgeport:
    image: your-registry/bridgeport:latest
    container_name: bridgeport
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      - ./data:/data
      # Optional: Mount Docker socket for host container management
      # - /var/run/docker.sock:/var/run/docker.sock
    # Required if mounting Docker socket
    # group_add:
    #   - "999"  # Find your docker group ID: stat -c '%g' /var/run/docker.sock
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
```

### 4. Start BridgePort

```bash
docker compose up -d
```

BridgePort will:
1. Create the database automatically
2. Run any pending migrations
3. Create the initial admin user (from `ADMIN_EMAIL` / `ADMIN_PASSWORD`)
4. Start the web server on port 3000

### 5. Log in

Open `http://your-server:3000` in your browser and log in with the admin credentials you configured.

## Managing the Docker Host

If BridgePort runs on the same machine as your Docker containers, you have two options for managing them:

### Option A: Docker Socket (Recommended)

Mount the Docker socket to give BridgePort direct access to the Docker daemon:

```yaml
services:
  bridgeport:
    volumes:
      - ./data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    group_add:
      - "999"  # Docker group ID
```

Find your Docker group ID:

```bash
stat -c '%g' /var/run/docker.sock
```

When the socket is mounted and accessible, BridgePort automatically creates a "localhost" server on startup. This server uses socket mode for all Docker operations — no SSH required.

> **Security note**: Mounting the Docker socket gives BridgePort full access to the Docker daemon, equivalent to root access on the host.

### Option B: SSH

If you can't mount the socket, BridgePort can manage the host via SSH through the Docker gateway IP. Requirements:

1. SSH server running on the host
2. SSH connections allowed from Docker network (`172.17.0.0/16`)
3. SSH key configured in the environment settings

BridgePort will detect the host and show a banner on the Servers page to register it.

## Next Steps

After initial setup:

1. **Create an environment** — Go to the sidebar and create your first environment (e.g., "production")
2. **Upload an SSH key** — In environment settings, upload the SSH private key used to connect to your servers
3. **Add a server** — Register your first server with its hostname/IP
4. **Discover containers** — Click "Discover" on the server to find running Docker containers
5. **Connect a registry** — Add a container registry to enable update checking and deployments

For detailed configuration options, see [Configuration Reference](configuration.md).
