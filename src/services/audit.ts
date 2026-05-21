import type { FastifyRequest } from 'fastify';
import { prisma } from '../lib/db.js';

export interface AuditLogParams {
  action: string;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
  details?: Record<string, unknown>;
  success?: boolean;
  error?: string;
  userId?: string;
  environmentId?: string;
  apiTokenId?: string;
  serviceAccountId?: string;
}

// Sentinel prefix for service-account-owned tokens; see auth.ts validateApiToken.
const SERVICE_ACCOUNT_USER_ID_PREFIX = 'sa:';

/**
 * Extract actor identity from a Fastify request. Spread into logAudit params
 * to record who (user or service account) performed the action and which token
 * authenticated them.
 */
export function actorFrom(request: FastifyRequest): {
  userId?: string;
  apiTokenId?: string;
  serviceAccountId?: string;
} {
  const u = request.authUser;
  if (!u) return {};
  if (u.serviceAccountId) {
    return {
      apiTokenId: u.apiTokenId,
      serviceAccountId: u.serviceAccountId,
    };
  }
  return {
    userId: u.id,
    apiTokenId: u.apiTokenId,
  };
}

export interface AuditLogFilters {
  environmentId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}

export async function logAudit(params: AuditLogParams): Promise<void> {
  // Tolerate callers that pass a service-account sentinel as userId
  // (e.g. legacy call sites that used request.authUser!.id directly).
  let userId = params.userId;
  let serviceAccountId = params.serviceAccountId;
  if (userId?.startsWith(SERVICE_ACCOUNT_USER_ID_PREFIX)) {
    serviceAccountId = serviceAccountId ?? userId.slice(SERVICE_ACCOUNT_USER_ID_PREFIX.length);
    userId = undefined;
  }

  try {
    await prisma.auditLog.create({
      data: {
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        resourceName: params.resourceName,
        details: params.details ? JSON.stringify(params.details) : null,
        success: params.success ?? true,
        error: params.error,
        userId,
        environmentId: params.environmentId,
        apiTokenId: params.apiTokenId,
        serviceAccountId,
      },
    });
  } catch (error) {
    // Don't let audit logging failures break the main operation
    console.error('Failed to log audit event:', error);
  }
}

export async function getAuditLogs(filters: AuditLogFilters) {
  const where: Record<string, unknown> = {};

  if (filters.environmentId) {
    where.environmentId = filters.environmentId;
  }
  if (filters.resourceType) {
    where.resourceType = filters.resourceType;
  }
  if (filters.resourceId) {
    where.resourceId = filters.resourceId;
  }
  if (filters.action) {
    where.action = filters.action;
  }
  if (filters.userId) {
    where.userId = filters.userId;
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
        environment: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: filters.limit || 50,
      skip: filters.offset || 0,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total };
}

/**
 * Delete audit logs older than retentionDays.
 * Returns the number of deleted records.
 */
export async function cleanupOldAuditLogs(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0; // 0 = keep forever
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await prisma.auditLog.deleteMany({
    where: { createdAt: { lt: cutoffDate } },
  });
  return result.count;
}
