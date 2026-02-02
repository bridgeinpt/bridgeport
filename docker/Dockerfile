# Build stage for Go agent
FROM golang:1.22-alpine AS agent-build
WORKDIR /build
COPY bridgeport-agent/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o bridgeport-agent .

# Build stage for UI
FROM node:22-alpine AS ui-build
WORKDIR /app/ui

COPY ui/package.json ui/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY ui/ ./
RUN npm run build

# Build stage for API (TypeScript compilation)
FROM node:22-alpine AS api-build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY prisma/ ./prisma/

# Generate Prisma types
RUN npx prisma generate

COPY src/ ./src/
RUN npm run build

# Prisma CLI stage - generates client and provides CLI for migrations
FROM node:22-alpine AS prisma-build
WORKDIR /app

# Install only prisma CLI (needed for generate and migrate deploy)
RUN npm install prisma@6 --ignore-scripts

COPY prisma/ ./prisma/

# Generate client (outputs to node_modules/@prisma/client)
RUN npx prisma generate

# Production dependencies stage (no native modules needed anymore)
FROM node:22-alpine AS deps-prod
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Copy all prisma-related packages from prisma-build (for both client and CLI)
COPY --from=prisma-build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=prisma-build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=prisma-build /app/node_modules/prisma ./node_modules/prisma
COPY --from=prisma-build /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=prisma-build /app/node_modules/effect ./node_modules/effect
COPY --from=prisma-build /app/node_modules/fast-check ./node_modules/fast-check
COPY --from=prisma-build /app/node_modules/pure-rand ./node_modules/pure-rand

# Remove packages only needed for prisma generate (not migrate deploy)
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
FROM node:22-alpine AS production
WORKDIR /app

# Install runtime dependencies (openssh-client for SSH, docker-cli + compose for localhost, db clients for backups)
RUN apk add --no-cache openssl openssh-client docker-cli docker-cli-compose sqlite postgresql16-client

# Create directories and set ownership for non-root user
RUN mkdir -p /app/data /app/uploads /app/.ssh && \
    chown -R node:node /app

# Copy production node_modules (pruned)
COPY --from=deps-prod /app/node_modules ./node_modules

# Copy built API
COPY --from=api-build /app/dist ./dist

# Copy Prisma migrations (needed for migrate deploy)
COPY --from=api-build /app/prisma ./prisma

# Copy built UI
COPY --from=ui-build /app/ui/dist ./ui/dist

# Copy agent binary for deployment to servers
COPY --from=agent-build /build/bridgeport-agent ./agent/bridgeport-agent

COPY package.json ./

# Set environment
ENV NODE_ENV=production
ENV DATABASE_URL="file:/app/data/bridgeport.db"

EXPOSE 3000

# Run as non-root user
USER node

# Sync database schema and start
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/server.js"]
