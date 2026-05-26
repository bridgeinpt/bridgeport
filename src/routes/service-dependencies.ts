import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, isPrismaNotFoundError } from '../lib/db.js';
import { logAudit, actorFrom } from '../services/audit.js';
import { resolveDependencyOrder } from '../services/orchestration.js';
import { validateBody, findOrNotFound, handleUniqueConstraint } from '../lib/helpers.js';

const createDependencySchema = z.object({
  dependsOnId: z.string().min(1),
  type: z.enum(['health_before', 'deploy_after']),
});

export async function serviceDependencyRoutes(fastify: FastifyInstance): Promise<void> {
  // Get dependencies for a service
  fastify.get(
    '/api/services/:id/dependencies',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await findOrNotFound(
        prisma.service.findUnique({
          where: { id },
          include: {
            dependencies: {
              include: {
                dependsOn: {
                  include: {
                    serviceDeployments: { include: { server: { select: { name: true } } } },
                  },
                },
              },
            },
            dependents: {
              include: {
                dependent: {
                  include: {
                    serviceDeployments: { include: { server: { select: { name: true } } } },
                  },
                },
              },
            },
          },
        }),
        'Service',
        reply
      );
      if (!service) return;

      return {
        dependencies: service.dependencies,
        dependents: service.dependents,
      };
    }
  );

  // Add dependency to a service
  fastify.post(
    '/api/services/:id/dependencies',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = validateBody(createDependencySchema, request, reply);
      if (!body) return;

      // Verify both services exist
      const [dependent, dependsOn] = await Promise.all([
        prisma.service.findUnique({ where: { id } }),
        prisma.service.findUnique({ where: { id: body.dependsOnId } }),
      ]);

      if (!dependent) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      if (!dependsOn) {
        return reply.code(404).send({ error: 'Dependency service not found' });
      }


      // Verify both services are in the same environment
      if (dependent.environmentId !== dependsOn.environmentId) {
        return reply.code(400).send({
          error: 'Dependencies can only be created between services in the same environment',
        });
      }

      // Check for self-dependency
      if (id === body.dependsOnId) {
        return reply.code(400).send({ error: 'A service cannot depend on itself' });
      }

      // Check for circular dependency
      try {
        // Temporarily add the dependency to check for cycles
        const allServices = await prisma.service.findMany({
          where: { environmentId: dependent.environmentId },
          include: {
            serviceDeployments: { include: { server: { select: { name: true, hostname: true } } } },
            dependencies: { include: { dependsOn: true } },
            dependents: { include: { dependent: true } },
          },
        });

        // Add the new dependency to the list for validation
        const tempService = allServices.find((s) => s.id === id);
        if (tempService) {
          const tempDependsOn = allServices.find((s) => s.id === body.dependsOnId);
          if (tempDependsOn) {
            tempService.dependencies.push({
              id: 'temp',
              type: body.type,
              dependentId: id,
              dependsOnId: body.dependsOnId,
              dependsOn: tempDependsOn,
            } as never);
          }
        }

        // This will throw if there's a cycle
        resolveDependencyOrder(allServices);
      } catch (error) {
        if (error instanceof Error && error.message.includes('Circular dependency')) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }

      try {
        const dependency = await prisma.serviceDependency.create({
          data: {
            dependentId: id,
            dependsOnId: body.dependsOnId,
            type: body.type,
          },
          include: {
            dependsOn: {
              include: {
                serviceDeployments: { include: { server: { select: { name: true } } } },
              },
            },
          },
        });

        await logAudit({
          action: 'create',
          resourceType: 'service_dependency',
          resourceId: dependency.id,
          resourceName: `${dependent.name} -> ${dependsOn.name}`,
          details: {
            dependentId: id,
            dependentName: dependent.name,
            dependsOnId: body.dependsOnId,
            dependsOnName: dependsOn.name,
            type: body.type,
          },
          ...actorFrom(request),
          environmentId: dependent.environmentId,
        });

        return { dependency };
      } catch (error) {
        if (handleUniqueConstraint(error, 'This dependency already exists', reply)) return;
        throw error;
      }
    }
  );

  // Delete dependency
  fastify.delete(
    '/api/dependencies/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const dependency = await findOrNotFound(
          prisma.serviceDependency.findUnique({
            where: { id },
            include: {
              dependent: true,
              dependsOn: true,
            },
          }),
          'Dependency',
          reply
        );
        if (!dependency) return;

        await prisma.serviceDependency.delete({ where: { id } });

        await logAudit({
          action: 'delete',
          resourceType: 'service_dependency',
          resourceId: id,
          resourceName: `${dependency.dependent.name} -> ${dependency.dependsOn.name}`,
          details: {
            dependentId: dependency.dependentId,
            dependentName: dependency.dependent.name,
            dependsOnId: dependency.dependsOnId,
            dependsOnName: dependency.dependsOn.name,
          },
          ...actorFrom(request),
          environmentId: dependency.dependent.environmentId,
        });

        return { success: true };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Dependency not found' });
        }
        throw error;
      }
    }
  );

  // Get dependency graph for environment
  fastify.get(
    '/api/environments/:envId/dependency-graph',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };

      // Get all services with their dependencies in this environment.
      // Since runtime status moved to ServiceDeployment, derive a rolled-up
      // "service-level" status (worst-case across deployments) for nodes.
      const services = await prisma.service.findMany({
        where: { environmentId: envId },
        include: {
          serviceDeployments: {
            select: { id: true, status: true, healthStatus: true, server: { select: { id: true, name: true } } },
          },
          dependencies: {
            include: { dependsOn: { select: { id: true, name: true } } },
          },
          dependents: {
            include: { dependent: { select: { id: true, name: true } } },
          },
          containerImage: { select: { id: true, name: true } },
        },
      });

      const rollupStatus = (deployments: { status: string }[]) => {
        if (deployments.length === 0) return 'unknown';
        if (deployments.some((d) => d.status === 'unhealthy')) return 'unhealthy';
        if (deployments.some((d) => d.status === 'stopped' || d.status === 'not_found')) return 'stopped';
        if (deployments.every((d) => d.status === 'healthy' || d.status === 'running')) return 'healthy';
        return 'unknown';
      };
      const rollupHealth = (deployments: { healthStatus: string }[]) => {
        if (deployments.some((d) => d.healthStatus === 'unhealthy')) return 'unhealthy';
        if (deployments.every((d) => d.healthStatus === 'healthy')) return 'healthy';
        return 'unknown';
      };

      const nodes = services.map((service) => ({
        id: service.id,
        name: service.name,
        servers: service.serviceDeployments.map((d) => d.server.name),
        containerImage: service.containerImage,
        status: rollupStatus(service.serviceDeployments),
        healthStatus: rollupHealth(service.serviceDeployments),
        dependencyCount: service.dependencies.length,
        dependentCount: service.dependents.length,
      }));

      const edges = services.flatMap((service) =>
        service.dependencies.map((dep) => ({
          id: dep.id,
          from: dep.dependsOnId,
          to: service.id,
          type: dep.type,
        }))
      );

      // Also compute the deployment order
      let deploymentOrder: string[][] = [];
      try {
        const servicesWithDeps = await prisma.service.findMany({
          where: { environmentId: envId },
          include: {
            serviceDeployments: { include: { server: { select: { name: true, hostname: true } } } },
            dependencies: { include: { dependsOn: true } },
            dependents: { include: { dependent: true } },
          },
        });

        const levels = resolveDependencyOrder(servicesWithDeps);
        deploymentOrder = levels.map((level) => level.map((s) => s.id));
      } catch (error) {
        // If there's a cycle, we can't compute the order
        console.error('Failed to compute deployment order:', error);
      }

      return { nodes, edges, deploymentOrder };
    }
  );

  // Get available services to depend on (same environment, not self)
  fastify.get(
    '/api/services/:id/available-dependencies',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const service = await findOrNotFound(
        prisma.service.findUnique({
          where: { id },
          include: { dependencies: true },
        }),
        'Service',
        reply
      );
      if (!service) return;

      const existingDependencyIds = new Set(service.dependencies.map((d) => d.dependsOnId));

      // Get all services in the same environment that are not this service and not already a dependency.
      const availableServices = await prisma.service.findMany({
        where: {
          environmentId: service.environmentId,
          id: {
            not: id,
            notIn: Array.from(existingDependencyIds),
          },
        },
        include: {
          serviceDeployments: { select: { server: { select: { name: true } } } },
        },
        orderBy: { name: 'asc' },
      });

      return { services: availableServices };
    }
  );
}
