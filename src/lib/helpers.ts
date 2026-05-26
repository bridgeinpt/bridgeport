/**
 * Shared helper utilities for routes and services.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z, ZodType } from 'zod';

/**
 * Validate the request body against a Zod schema.
 * Returns the parsed data (output type, with defaults applied), or null after sending a 400 response.
 */
export function validateBody<S extends ZodType>(
  schema: S,
  request: FastifyRequest,
  reply: FastifyReply
): z.infer<S> | null {
  const result = schema.safeParse(request.body);
  if (!result.success) {
    reply.code(400).send({ error: 'Invalid input', details: result.error.issues });
    return null;
  }
  return result.data as z.infer<S>;
}

/**
 * Await a Prisma query and return 404 if the result is null.
 * Returns the entity, or null after sending a 404 response.
 */
export async function findOrNotFound<T>(
  query: Promise<T | null>,
  entityName: string,
  reply: FastifyReply
): Promise<T | null> {
  const entity = await query;
  if (!entity) {
    reply.code(404).send({ error: `${entityName} not found` });
    return null;
  }
  return entity;
}

/**
 * Handle Prisma unique constraint errors by sending a 409 response.
 * Returns true if the error was handled, false otherwise.
 */
export function handleUniqueConstraint(error: unknown, message: string, reply: FastifyReply): boolean {
  if (error instanceof Error && error.message.includes('Unique constraint')) {
    reply.code(409).send({ error: message });
    return true;
  }
  return false;
}

/**
 * Safely parse a JSON string with a fallback default value.
 * Unlike raw JSON.parse, this never throws and always returns the expected type.
 */
export function safeJsonParse<T>(json: string | null | undefined, defaultValue: T): T {
  if (!json) return defaultValue;
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Extract a human-readable error message from an unknown error value.
 */
export function getErrorMessage(error: unknown, defaultMessage: string = 'Unknown error'): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return defaultMessage;
}

/**
 * Parse pagination query parameters with defaults.
 */
export function parsePaginationQuery(
  query: Record<string, unknown>,
  defaults: { limit: number; offset: number } = { limit: 25, offset: 0 }
): { limit: number; offset: number } {
  const limitStr = query.limit;
  const offsetStr = query.offset;
  return {
    limit: typeof limitStr === 'string' && limitStr ? parseInt(limitStr, 10) : defaults.limit,
    offset: typeof offsetStr === 'string' && offsetStr ? parseInt(offsetStr, 10) : defaults.offset,
  };
}

/**
 * Back-compat helper: flatten a ServiceDeployment's runtime fields onto its
 * Service template so legacy UI code reading `service.status`, `service.containerName`,
 * `service.healthStatus`, etc. keeps working.
 *
 * The 2.0 split moved per-server runtime fields off Service onto ServiceDeployment.
 * Several UI pages (Dashboard, Services list, ServerDetail) consume the old surface;
 * this helper builds it from a `(deployment & { service })` row.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function flattenDeploymentOntoService(deployment: any): any {
  const { service, ...d } = deployment;
  return {
    ...service,
    // The flattened object's `id` stays the Service template id (back-compat).
    // `deploymentId` exposes the underlying ServiceDeployment id so callers can
    // drive per-deployment endpoints (deploy, restart, health, logs) from the
    // flattened shape.
    deploymentId: d.id,
    // Runtime / per-server fields
    containerName: d.containerName,
    composePath: d.composePath,
    status: d.status,
    containerStatus: d.containerStatus,
    healthStatus: d.healthStatus,
    exposedPorts: d.exposedPorts,
    discoveryStatus: d.discoveryStatus,
    lastCheckedAt: d.lastCheckedAt,
    lastDiscoveredAt: d.lastDiscoveredAt,
    lastDeployedAt: d.lastDeployedAt,
    serverId: d.serverId,
    server: d.server,
    // Agent check fields
    agentHealthSuccess: d.agentHealthSuccess,
    agentHealthStatusCode: d.agentHealthStatusCode,
    agentHealthDurationMs: d.agentHealthDurationMs,
    agentHealthCheckedAt: d.agentHealthCheckedAt,
    agentTcpCheckResults: d.agentTcpCheckResults,
    agentTcpCheckedAt: d.agentTcpCheckedAt,
    agentCertCheckResults: d.agentCertCheckResults,
    agentCertCheckedAt: d.agentCertCheckedAt,
  };
}
