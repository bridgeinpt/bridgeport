# Build stage for Go agent
FROM golang:1.26.4-alpine AS agent-build
WORKDIR /build
ARG AGENT_VERSION=dev
COPY bridgeport-agent/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w -X main.Version=${AGENT_VERSION}" -o bridgeport-agent .
# Write agent version to file for runtime access
RUN echo "${AGENT_VERSION}" > agent-version.txt

# Build stage for Go CLI (multi-platform)
FROM golang:1.26.4-alpine AS cli-build
WORKDIR /build
ARG CLI_VERSION=dev
COPY cli/ ./
# The CLI module's `replace github.com/bridgeinpt/bridgeport/client => ../client`
# resolves to /client (cli is at /build), so the client module must be present there.
COPY client/ /client
# Build for all supported platforms
RUN mkdir -p dist && \
    CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w -X github.com/bridgeinpt/bridgeport/cli/cmd.Version=${CLI_VERSION}" -o dist/bridgeport-darwin-amd64 . && \
    CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w -X github.com/bridgeinpt/bridgeport/cli/cmd.Version=${CLI_VERSION}" -o dist/bridgeport-darwin-arm64 . && \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w -X github.com/bridgeinpt/bridgeport/cli/cmd.Version=${CLI_VERSION}" -o dist/bridgeport-linux-amd64 . && \
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w -X github.com/bridgeinpt/bridgeport/cli/cmd.Version=${CLI_VERSION}" -o dist/bridgeport-linux-arm64 .
# Write CLI version to file for runtime access
RUN echo "${CLI_VERSION}" > cli-version.txt

# ─────────────────────────────────────────────────────────────────────────────
# pnpm base: every Node stage shares the same pnpm + workspace manifests so the
# `pnpm install` layers cache identically. corepack was removed from Node.js 25+
# (node:26-alpine has no corepack), so pnpm is installed globally and pinned to
# the same version as package.json's `packageManager` field.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-alpine AS pnpm-base
WORKDIR /app
RUN npm install -g pnpm@11.5.3
# Workspace manifests + lockfile first for cache-friendly layering: dependency
# layers only bust when these files change, not on every source edit.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY ui/package.json ./ui/

# Build stage for UI
FROM pnpm-base AS ui-build
ARG APP_VERSION=dev
# Install the whole workspace (frozen against the committed lockfile). The
# allowBuilds allowlist in pnpm-workspace.yaml runs native build scripts.
RUN pnpm install --frozen-lockfile

COPY ui/ ./ui/
# Pass version to Vite at build time
ENV VITE_APP_VERSION=${APP_VERSION}
RUN pnpm --filter bridgeport-ui run build

# Build stage for API (TypeScript compilation)
FROM pnpm-base AS api-build
RUN pnpm install --frozen-lockfile

COPY tsconfig.json prisma.config.ts ./
COPY prisma/ ./prisma/

# Generate Prisma types (needed for tsc)
RUN pnpm exec prisma generate

COPY src/ ./src/
RUN pnpm run build

# ─────────────────────────────────────────────────────────────────────────────
# Production dependencies stage.
#
# We install with `--config.nodeLinker=hoisted` so the output node_modules is a
# flat, npm-like tree (real directories, not symlinks into a .pnpm virtual
# store). That layout copies cleanly across stages with a single `COPY --from`
# — pnpm's default symlinked layout would leave dangling links once copied out
# of its workspace context.
#
# This single stage replaces the old separate prisma-build + deps-prod stages:
# the hoisted `--prod` install keeps the `prisma` CLI (for `migrate deploy` at
# runtime) and `@prisma/client`, and `prisma generate` then materialises a real
# generated client directly inside this node_modules.
# ─────────────────────────────────────────────────────────────────────────────
FROM pnpm-base AS deps-prod
# prisma.config.ts + schema are needed for `prisma generate` below.
COPY prisma.config.ts ./
COPY prisma/ ./prisma/

# python3/make/g++ are needed only if better-sqlite3's prebuilt binary is
# unavailable for this platform; the native build falls back to compiling from
# source. Installed and removed in one layer to keep the stage slim.
RUN apk add --no-cache python3 make g++ && \
    pnpm install --frozen-lockfile --prod --filter=bridgeport --config.nodeLinker=hoisted && \
    apk del python3 make g++

# Generate the Prisma client into this stage's node_modules (real files, not a
# dangling symlink). Output lands in node_modules/@prisma/client for Prisma 7.
RUN pnpm exec prisma generate

# typescript / @types are only needed for `prisma generate`, not at runtime.
RUN rm -rf node_modules/typescript node_modules/@types

# Prune unnecessary files from node_modules to reduce image size
RUN find node_modules -type f \( \
    -name "*.d.ts" -o \
    -name "*.d.mts" -o \
    -name "*.map" -o \
    -name "*.md" -o \
    -name "LICENSE*" -o \
    -name "CHANGELOG*" -o \
    -name "*.ts" ! -name "*.d.ts" -o \
    -name "Makefile" -o \
    -name "*.gyp" \
  \) -delete 2>/dev/null || true

# Remove non-musl and non-amd64 Prisma engines (keep only linux-musl-openssl-3.0.x for Alpine amd64)
RUN find node_modules -type f \( -name "libquery*" -o -name "schema-engine*" \) \
    \( ! -name "*linux-musl-openssl*" -o -name "*arm64*" \) -delete 2>/dev/null || true

# Production stage (minimal Alpine)
FROM node:26-alpine AS production
WORKDIR /app

# Carried through from the top-level build arg so the backend can stamp
# /health and the Sentry release with the real version at runtime.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# Install runtime dependencies (openssh-client for SSH, docker-cli + compose for localhost, db clients for backups)
RUN apk add --no-cache openssl openssh-client docker-cli docker-cli-compose sqlite postgresql16-client

# Create directories and set ownership for non-root user
RUN mkdir -p /app/data /app/uploads /app/.ssh && \
    chown -R node:node /app

# Copy production node_modules (hoisted + pruned, self-contained: prisma CLI +
# generated @prisma/client + native better-sqlite3 binding).
COPY --from=deps-prod /app/node_modules ./node_modules

# Copy built API
COPY --from=api-build /app/dist ./dist

# Copy Prisma migrations and config (needed for migrate deploy)
COPY --from=api-build /app/prisma ./prisma
COPY --from=api-build /app/prisma.config.ts ./prisma.config.ts

# Copy built UI
COPY --from=ui-build /app/ui/dist ./ui/dist

# Copy agent binary and version file for deployment to servers
COPY --from=agent-build /build/bridgeport-agent ./agent/bridgeport-agent
COPY --from=agent-build /build/agent-version.txt ./agent/agent-version.txt

# Copy CLI binaries and version file for downloads
COPY --from=cli-build /build/dist/ ./cli/
COPY --from=cli-build /build/cli-version.txt ./cli/cli-version.txt

COPY plugins/ ./plugins/
COPY package.json ./
COPY docker/entrypoint.sh ./entrypoint.sh

# Set environment
ENV NODE_ENV=production
ENV DATABASE_URL="file:/app/data/bridgeport.db"

EXPOSE 3000

# Run as non-root user
USER node

# Entrypoint handles migrations automatically
ENTRYPOINT ["sh", "/app/entrypoint.sh"]
