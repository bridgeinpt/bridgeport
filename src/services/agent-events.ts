import { prisma } from '../lib/db.js';

export type AgentEventType =
  | 'deploy_started'
  | 'deploy_success'
  | 'deploy_failed'
  | 'token_regenerated'
  | 'status_change';

export interface LogAgentEventParams {
  serverId: string;
  eventType: AgentEventType;
  status?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Log an agent lifecycle event
 */
export async function logAgentEvent(params: LogAgentEventParams): Promise<void> {
  const { serverId, eventType, status, message, details } = params;

  await prisma.agentEvent.create({
    data: {
      serverId,
      eventType,
      status,
      message,
      details: details ? JSON.stringify(details) : null,
    },
  });
}

/**
 * Get recent agent events for a server
 */
export async function getAgentEvents(
  serverId: string,
  limit = 20
): Promise<
  Array<{
    id: string;
    eventType: string;
    status: string | null;
    message: string | null;
    details: string | null;
    createdAt: Date;
  }>
> {
  return prisma.agentEvent.findMany({
    where: { serverId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
