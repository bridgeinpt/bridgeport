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
        userId: params.userId,
        environmentId: params.environmentId,
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
