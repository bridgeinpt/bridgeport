# BridgePort

A lightweight, self-hosted deployment management tool for Docker-based infrastructure.

## Tech Stack

- **Backend**: Node.js, Fastify, TypeScript
- **Frontend**: React, Vite, Tailwind CSS
- **Database**: SQLite with Prisma ORM
- **Encryption**: XChaCha20-Poly1305 for secrets

## Project Structure

```
bridgeport/
├── src/                      # Backend
│   ├── server.ts             # Fastify entry point
│   ├── lib/                  # Core utilities
│   │   ├── config.ts         # Environment configuration
│   │   ├── crypto.ts         # Encryption utilities
│   │   ├── db.ts             # Prisma client
│   │   └── ssh.ts            # SSH client wrapper
│   ├── routes/               # API routes
│   └── services/             # Business logic
├── ui/                       # Frontend (React + Vite)
│   ├── src/
│   │   ├── components/       # Reusable components
│   │   ├── pages/            # Page components
│   │   └── lib/              # API client, store
│   └── public/               # Static assets
├── prisma/schema.prisma      # Database schema
└── docker/                   # Docker configuration
```

## Development Commands

```bash
# Install dependencies
npm install
cd ui && npm install && cd ..

# Generate Prisma client (required after schema changes)
npm run db:generate

# Run migrations
npm run db:push

# Start backend (port 3000)
npm run dev

# Start frontend (port 5173, separate terminal)
cd ui && npm run dev

# Build
npm run build
cd ui && npm run build
```

## Key Patterns

### API Routes
Routes are in `src/routes/`. Each route file exports a Fastify plugin:

```typescript
export default async function (fastify: FastifyInstance) {
  fastify.get('/api/example', async (request, reply) => {
    // Handler
  });
}
```

### Database Access
Use Prisma client from `src/lib/db.ts`:

```typescript
import { prisma } from '../lib/db';
const servers = await prisma.server.findMany();
```

### Secret Encryption
Secrets are encrypted with XChaCha20-Poly1305. Use `src/lib/crypto.ts`:

```typescript
import { encrypt, decrypt } from '../lib/crypto';
const encrypted = encrypt(plaintext);
const decrypted = decrypt(encrypted);
```

### Frontend State
Zustand stores in `ui/src/lib/store.ts`. API client in `ui/src/lib/api.ts`.

## Environment Variables

Required for development:

```bash
DATABASE_URL=file:./dev.db
MASTER_KEY=<openssl rand -base64 32>
JWT_SECRET=<openssl rand -base64 32>
```

## Important Notes

- BridgePort is designed to be a **generic tool** - avoid BridgeIn-specific code
- All secrets must be encrypted at rest
- SSH keys are stored encrypted per-environment
- Audit logging is required for sensitive operations
