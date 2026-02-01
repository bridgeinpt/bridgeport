# Build stage for UI
FROM node:22-slim AS ui-build
WORKDIR /app/ui

COPY ui/package.json ui/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY ui/ ./
RUN npm run build

# Build stage for API (TypeScript compilation)
FROM node:22-slim AS api-build
WORKDIR /app

COPY package.json package-lock.json* ./
# Install all deps for TypeScript build (no native modules needed for tsc)
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY prisma/ ./prisma/
COPY src/ ./src/

# Generate Prisma types (doesn't need native modules)
RUN npx prisma generate
RUN npm run build

# Production dependencies stage (with native modules)
FROM node:22-slim AS deps-prod
WORKDIR /app

# Install build dependencies for native modules (bcrypt, sodium-native)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy Prisma schema and regenerate client for production
COPY prisma/ ./prisma/
RUN npx prisma generate

# Production stage (minimal)
FROM node:22-slim AS production
WORKDIR /app

# Install only runtime dependencies
RUN apt-get update && apt-get install -y \
    openssl \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Create directories
RUN mkdir -p /app/data /app/uploads /app/.ssh

# Copy production node_modules (without dev deps)
COPY --from=deps-prod /app/node_modules ./node_modules

# Copy built API
COPY --from=api-build /app/dist ./dist

# Copy Prisma migrations (needed for migrate deploy)
COPY --from=api-build /app/prisma ./prisma

# Copy built UI
COPY --from=ui-build /app/ui/dist ./ui/dist

COPY package.json ./

# Set environment
ENV NODE_ENV=production
ENV DATABASE_URL="file:/app/data/bridgeport.db"

EXPOSE 3000

# Run migrations and start
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
