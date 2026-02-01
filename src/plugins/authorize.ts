import type { FastifyRequest, FastifyReply } from 'fastify';
import type { UserRole } from '../services/auth.js';

/**
 * Middleware that requires the user to be an admin.
 * Returns 403 Forbidden if the user is not an admin.
 */
export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.authUser) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  if (request.authUser.role !== 'admin') {
    return reply.code(403).send({ error: 'Admin access required' });
  }
}

/**
 * Middleware that requires the user to be an admin or operator.
 * Returns 403 Forbidden if the user is a viewer.
 */
export async function requireOperator(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.authUser) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }

  const allowedRoles: UserRole[] = ['admin', 'operator'];
  if (!allowedRoles.includes(request.authUser.role)) {
    return reply.code(403).send({ error: 'Operator or admin access required' });
  }
}

/**
 * Creates a middleware that requires the user to be an admin OR the user themselves.
 * Useful for endpoints where admins can manage any user, but users can manage themselves.
 *
 * @param paramName - The name of the route parameter containing the target user ID (default: 'id')
 */
export function requireAdminOrSelf(paramName: string = 'id') {
  return async function (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    if (!request.authUser) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const targetId = (request.params as Record<string, string>)[paramName];

    // Admin can access any resource
    if (request.authUser.role === 'admin') {
      return;
    }

    // Non-admin can only access their own resource
    if (request.authUser.id !== targetId) {
      return reply.code(403).send({ error: 'Access denied' });
    }
  };
}

/**
 * Helper to check if a user has at least the specified role level.
 * Role hierarchy: admin > operator > viewer
 */
export function hasMinimumRole(userRole: UserRole, minimumRole: UserRole): boolean {
  const roleHierarchy: Record<UserRole, number> = {
    admin: 3,
    operator: 2,
    viewer: 1,
  };

  return roleHierarchy[userRole] >= roleHierarchy[minimumRole];
}
