import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { validateApiToken, getUserById, type AuthUser } from '../services/auth.js';
import { prisma } from '../lib/db.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

// Routes that env-scoped tokens are always allowed to call (introspection).
// /api/environments/:envId/... is handled separately by per-env membership check.
const SCOPE_EXEMPT_ROUTES = new Set<string>([
  'GET /api/auth/me',
  'GET /api/environments',
]);

// Mutating routes a viewer is allowed to call (self-service). All other
// non-GET/HEAD/OPTIONS routes require operator or admin. Self-vs-others
// checks for the user-scoped routes still live in requireAdminOrSelf.
const VIEWER_ALLOWED_MUTATIONS = new Set<string>([
  'POST /api/notifications/:id/read',
  'POST /api/notifications/read-all',
  'PUT /api/notifications/preferences/:typeId',
  'PATCH /api/users/:id',
  'POST /api/users/:id/change-password',
]);

const READONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Extract env ID from /api/environments/{envId}/... URLs. The param name varies
// between routes (:id for environments.ts, :envId elsewhere), so we read the URL
// directly instead of trusting params naming.
function extractEnvIdFromPath(routePattern: string, params: Record<string, string>): string | null {
  if (!routePattern.startsWith('/api/environments/')) return null;
  return params.envId ?? params.id ?? null;
}

function enforceTokenScope(
  user: AuthUser,
  request: FastifyRequest,
  reply: FastifyReply
): boolean {
  // No scope = JWT-authenticated session, no token-scope checks needed.
  if (!user.scope) return true;
  // Token allowed everywhere.
  if (user.scope.allEnvironments) return true;

  const routePattern = request.routeOptions?.url ?? request.url;
  const method = request.method.toUpperCase();
  const key = `${method} ${routePattern}`;

  if (SCOPE_EXEMPT_ROUTES.has(key)) return true;

  const params = (request.params ?? {}) as Record<string, string>;
  const envId = extractEnvIdFromPath(routePattern, params);
  if (envId) {
    if (user.scope.environmentIds.includes(envId)) return true;
    reply.code(403).send({ error: 'Token is not scoped to this environment' });
    return false;
  }

  // Global route (no env in path) and the token is env-scoped — deny.
  reply.code(403).send({
    error: 'Token is scoped to specific environments and cannot access global resources',
  });
  return false;
}

function enforceRoleForMethod(
  user: AuthUser,
  request: FastifyRequest,
  reply: FastifyReply
): boolean {
  const method = request.method.toUpperCase();
  if (READONLY_METHODS.has(method)) return true;
  if (user.role === 'admin' || user.role === 'operator') return true;

  const routePattern = request.routeOptions?.url ?? request.url;
  if (VIEWER_ALLOWED_MUTATIONS.has(`${method} ${routePattern}`)) return true;

  reply.code(403).send({ error: 'This action requires operator or admin role' });
  return false;
}

async function authenticatePlugin(fastify: FastifyInstance) {
  fastify.decorate(
    'authenticate',
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        const authHeader = request.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.slice(7);

          // Try API token first
          const user = await validateApiToken(token);
          if (user) {
            if (!enforceTokenScope(user, request, reply)) return;
            if (!enforceRoleForMethod(user, request, reply)) return;
            request.authUser = user;
            return;
          }

          // Try JWT
          try {
            const payload = await request.jwtVerify<{ id: string; email: string }>();
            // Fetch full user to get role
            const fullUser = await getUserById(payload.id);
            if (fullUser) {
              if (!enforceRoleForMethod(fullUser, request, reply)) return;
              request.authUser = fullUser;
              // Update lastActiveAt in background (don't await)
              prisma.user.update({
                where: { id: fullUser.id },
                data: { lastActiveAt: new Date() },
              }).catch(() => {}); // Ignore errors
              return;
            }
          } catch {
            // Invalid JWT
          }
        }

        reply.code(401).send({ error: 'Unauthorized' });
      } catch {
        reply.code(401).send({ error: 'Unauthorized' });
      }
    }
  );
}

// Use fastify-plugin to expose decorator to parent scope
export default fp(authenticatePlugin, {
  name: 'authenticate',
  dependencies: ['@fastify/jwt'],
});
