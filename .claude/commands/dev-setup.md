---
allowed-tools: Bash, Read, Write, Edit
description: Setup BridgePort development environment
---

# Development Setup

Set up the BridgePort development environment by installing all dependencies and initializing the database.

## Steps

1. Check if Node.js is installed (required version >= 18)
2. Install backend dependencies: `npm install`
3. Install frontend dependencies: `cd ui && npm install && cd ..`
4. Generate Prisma client: `npm run db:generate`
5. Initialize the database with migrations: `DATABASE_URL="file:./dev.db" npx prisma migrate dev`
6. Create a `.env` file if it doesn't exist with default development values

## Default .env values for development

```
DATABASE_URL=file:./dev.db
MASTER_KEY=<generate with: openssl rand -base64 32>
JWT_SECRET=<generate with: openssl rand -base64 32>
```

After setup is complete, you can start the development servers:
- Backend: `npm run dev` (runs on port 3000)
- Frontend: `cd ui && npm run dev` (runs on port 5173)
