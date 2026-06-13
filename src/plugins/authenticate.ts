import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { validateApiToken, getUserById, type AuthUser } from '../services/auth.js';
import { prisma } from '../lib/db.js';
import { userLastActiveThrottle } from '../lib/last-active-throttle.js';
import { ApiError } from '../lib/errors.js';

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
//
// The /mcp routes are exempt because /mcp is a GLOBAL (non-/api/environments)
// route, so an env-scoped token would otherwise be rejected by enforceTokenScope
// right at the door. Exempting /mcp lets env-scoped tokens *connect*; the REAL
// per-resource scope enforcement still runs on each injected API call — an
// env-scoped token hitting a global route like /api/servers/:id correctly gets
// FORBIDDEN_SCOPE at call time, and an env-scoped token hitting
// /api/environments/:envId/... is checked against its env allowlist as usual.
const SCOPE_EXEMPT_ROUTES = new Set<string>([
  'GET /api/auth/me',
  'GET /api/environments',
  'POST /mcp',
  'GET /mcp',
  'DELETE /mcp',
]);

// Mutating routes a viewer is allowed to call (self-service). All other
// non-GET/HEAD/OPTIONS routes require operator or admin. Self-vs-others
// checks for the user-scoped routes still live in requireAdminOrSelf.
//
// `POST /mcp` (and DELETE /mcp) are listed because the MCP endpoint is a POST
// transport that any authenticated principal — including a viewer — must be
// able to OPEN. The connection itself performs no mutation; it only registers
// the tools the caller's role/scope allow. The REAL write enforcement happens
// on each injected API call: a viewer's injected GET passes, while a viewer's
// injected POST (e.g. deploy_service) correctly hits FORBIDDEN_ROLE at call
// time. Without this, enforceRoleForMethod would 403 a viewer at the door and
// deny them even the read tools.
const VIEWER_ALLOWED_MUTATIONS = new Set<string>([
  'POST /api/notifications/:id/read',
  'POST /api/notifications/read-all',
  'PUT /api/notifications/preferences/:typeId',
  'PATCH /api/users/:id',
  'POST /api/users/:id/change-password',
  'POST /mcp',
  'DELETE /mcp',
]);

const READONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Extract env ID from /api/environments/{envId}/... URLs. The param name varies
// between routes (:id for environments.ts, :envId elsewhere), so we read the URL
// directly instead of trusting params naming.
function extractEnvIdFromPath(routePattern: string, params: Record<string, string>): string | null {
  if (!routePattern.startsWith('/api/environments/')) return null;
  return params.envId ?? params.id ?? null;
}

function enforceTokenScope(user: AuthUser, request: FastifyRequest): void {
  // No scope = JWT-authenticated session, no token-scope checks needed.
  if (!user.scope) return;
  // Token allowed everywhere.
  if (user.scope.allEnvironments) return;

  const routePattern = request.routeOptions?.url ?? request.url;
  const method = request.method.toUpperCase();
  const key = `${method} ${routePattern}`;

  if (SCOPE_EXEMPT_ROUTES.has(key)) return;

  const params = (request.params ?? {}) as Record<string, string>;
  const envId = extractEnvIdFromPath(routePattern, params);
  if (envId) {
    if (user.scope.environmentIds.includes(envId)) return;
    throw new ApiError('FORBIDDEN_SCOPE', 'Token is not scoped to this environment');
  }

  // Global route (no env in path) and the token is env-scoped — deny.
  throw new ApiError(
    'FORBIDDEN_SCOPE',
    'Token is scoped to specific environments and cannot access global resources'
  );
}

function enforceRoleForMethod(user: AuthUser, request: FastifyRequest): void {
  const method = request.method.toUpperCase();
  if (READONLY_METHODS.has(method)) return;
  if (user.role === 'admin' || user.role === 'operator') return;

  const routePattern = request.routeOptions?.url ?? request.url;
  if (VIEWER_ALLOWED_MUTATIONS.has(`${method} ${routePattern}`)) return;

  throw new ApiError('FORBIDDEN_ROLE', 'This action requires operator or admin role');
}

async function authenticatePlugin(fastify: FastifyInstance) {
  fastify.decorate(
    'authenticate',
    async function (request: FastifyRequest, _reply: FastifyReply) {
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);

        // Try API token first
        const user = await validateApiToken(token);
        if (user) {
          enforceTokenScope(user, request);
          enforceRoleForMethod(user, request);
          request.authUser = user;
          return;
        }

        // Try JWT
        let jwtPayload: { id: string; email: string } | null = null;
        try {
          jwtPayload = await request.jwtVerify<{ id: string; email: string }>();
        } catch {
          // Invalid JWT — fall through to the generic 401 below.
        }
        if (jwtPayload?.id) {
          const fullUser = await getUserById(jwtPayload.id);
          if (fullUser) {
            enforceRoleForMethod(fullUser, request);
            request.authUser = fullUser;
            // Update lastActiveAt in background (don't await), but throttle
            // per-user so we don't pound the SQLite writer lock on every
            // authenticated request — the timestamp only needs minute
            // granularity. See lib/last-active-throttle for rationale.
            if (userLastActiveThrottle.shouldWrite(fullUser.id)) {
              prisma.user.update({
                where: { id: fullUser.id },
                data: { lastActiveAt: new Date() },
              }).catch(() => {}); // Ignore errors
            }
            return;
          }
        }
      }

      throw new ApiError('UNAUTHORIZED', 'Unauthorized');
    }
  );
}

// Use fastify-plugin to expose decorator to parent scope
export default fp(authenticatePlugin, {
  name: 'authenticate',
  dependencies: ['@fastify/jwt'],
});
