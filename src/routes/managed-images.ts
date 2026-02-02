import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, isPrismaNotFoundError } from '../lib/db.js';
import {
  createManagedImage,
  updateManagedImage,
  deleteManagedImage,
  getManagedImage,
  listManagedImages,
  linkServiceToManagedImage,
  unlinkServiceFromManagedImage,
  getTagHistory,
  findUnlinkedServicesByImageName,
} from '../services/image-management.js';
import { buildDeploymentPlan, executePlan } from '../services/orchestration.js';
import { logAudit } from '../services/audit.js';

const createManagedImageSchema = z.object({
  name: z.string().min(1),
  imageName: z.string().min(1),
  currentTag: z.string().min(1),
  registryConnectionId: z.string().nullable().optional(),
});

const updateManagedImageSchema = z.object({
  name: z.string().min(1).optional(),
  currentTag: z.string().min(1).optional(),
  registryConnectionId: z.string().nullable().optional(),
});

const deployImageSchema = z.object({
  imageTag: z.string().min(1),
  autoRollback: z.boolean().default(true),
});

export async function managedImageRoutes(fastify: FastifyInstance): Promise<void> {
  // List managed images for environment
  fastify.get(
    '/api/environments/:envId/managed-images',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { envId } = request.params as { envId: string };
      const images = await listManagedImages(envId);
      return { images };
    }
  );

  // Create managed image
  fastify.post(
    '/api/environments/:envId/managed-images',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { envId } = request.params as { envId: string };
      const body = createManagedImageSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const image = await createManagedImage({
          ...body.data,
          environmentId: envId,
          registryConnectionId: body.data.registryConnectionId ?? undefined,
        });

        await logAudit({
          action: 'create',
          resourceType: 'managed_image',
          resourceId: image.id,
          resourceName: image.name,
          details: { imageName: image.imageName, currentTag: image.currentTag },
          userId: request.authUser!.id,
          environmentId: envId,
        });

        return { image };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Unique constraint')) {
          return reply.code(409).send({ error: 'A managed image for this image name already exists' });
        }
        throw error;
      }
    }
  );

  // Get managed image
  fastify.get(
    '/api/managed-images/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const image = await getManagedImage(id);

      if (!image) {
        return reply.code(404).send({ error: 'Managed image not found' });
      }

      return { image };
    }
  );

  // Update managed image
  fastify.patch(
    '/api/managed-images/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateManagedImageSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      try {
        const existing = await prisma.managedImage.findUnique({ where: { id } });
        const image = await updateManagedImage(id, body.data);

        await logAudit({
          action: 'update',
          resourceType: 'managed_image',
          resourceId: image.id,
          resourceName: image.name,
          details: { changes: body.data },
          userId: request.authUser!.id,
          environmentId: existing?.environmentId,
        });

        return { image };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Managed image not found' });
        }
        throw error;
      }
    }
  );

  // Delete managed image
  fastify.delete(
    '/api/managed-images/:id',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const image = await prisma.managedImage.findUnique({ where: { id } });
        await deleteManagedImage(id);

        if (image) {
          await logAudit({
            action: 'delete',
            resourceType: 'managed_image',
            resourceId: id,
            resourceName: image.name,
            userId: request.authUser!.id,
            environmentId: image.environmentId,
          });
        }

        return { success: true };
      } catch (error) {
        if (isPrismaNotFoundError(error)) {
          return reply.code(404).send({ error: 'Managed image not found' });
        }
        throw error;
      }
    }
  );

  // Deploy managed image to all linked services
  fastify.post(
    '/api/managed-images/:id/deploy',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = deployImageSchema.safeParse(request.body);

      if (!body.success) {
        return reply.code(400).send({ error: 'Invalid input', details: body.error.issues });
      }

      const image = await getManagedImage(id);
      if (!image) {
        return reply.code(404).send({ error: 'Managed image not found' });
      }

      if (image.services.length === 0) {
        return reply.code(400).send({ error: 'No services linked to this image' });
      }

      try {
        // Build and start the deployment plan
        const plan = await buildDeploymentPlan({
          environmentId: image.environmentId,
          managedImageId: id,
          imageTag: body.data.imageTag,
          triggerType: 'manual',
          triggeredBy: request.authUser!.email,
          userId: request.authUser!.id,
          autoRollback: body.data.autoRollback,
        });

        await logAudit({
          action: 'deploy',
          resourceType: 'managed_image',
          resourceId: id,
          resourceName: image.name,
          details: {
            imageTag: body.data.imageTag,
            planId: plan.id,
            serviceCount: image.services.length,
          },
          userId: request.authUser!.id,
          environmentId: image.environmentId,
        });

        // Execute plan asynchronously
        executePlan(plan.id).catch((err) => {
          console.error(`[ManagedImage] Plan ${plan.id} execution failed:`, err);
        });

        return { plan };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Deployment failed';
        return reply.code(500).send({ error: message });
      }
    }
  );

  // Get tag history for managed image
  fastify.get(
    '/api/managed-images/:id/history',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { limit } = request.query as { limit?: string };

      const image = await prisma.managedImage.findUnique({ where: { id } });
      if (!image) {
        return reply.code(404).send({ error: 'Managed image not found' });
      }

      const history = await getTagHistory(id, limit ? parseInt(limit) : 20);
      return { history };
    }
  );

  // Link service to managed image
  fastify.post(
    '/api/managed-images/:id/link/:serviceId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id, serviceId } = request.params as { id: string; serviceId: string };

      const image = await prisma.managedImage.findUnique({ where: { id } });
      if (!image) {
        return reply.code(404).send({ error: 'Managed image not found' });
      }

      const service = await prisma.service.findUnique({
        where: { id: serviceId },
        include: { server: true },
      });
      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      // Verify service is in same environment
      if (service.server.environmentId !== image.environmentId) {
        return reply.code(400).send({ error: 'Service must be in the same environment as the managed image' });
      }

      const updatedService = await linkServiceToManagedImage(id, serviceId);

      await logAudit({
        action: 'update',
        resourceType: 'managed_image',
        resourceId: id,
        resourceName: image.name,
        details: { linkedService: service.name, serviceId },
        userId: request.authUser!.id,
        environmentId: image.environmentId,
      });

      return { service: updatedService };
    }
  );

  // Unlink service from managed image
  fastify.delete(
    '/api/managed-images/:id/link/:serviceId',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id, serviceId } = request.params as { id: string; serviceId: string };

      const image = await prisma.managedImage.findUnique({ where: { id } });
      if (!image) {
        return reply.code(404).send({ error: 'Managed image not found' });
      }

      const service = await prisma.service.findUnique({ where: { id: serviceId } });
      if (!service) {
        return reply.code(404).send({ error: 'Service not found' });
      }

      if (service.managedImageId !== id) {
        return reply.code(400).send({ error: 'Service is not linked to this managed image' });
      }

      const updatedService = await unlinkServiceFromManagedImage(serviceId);

      await logAudit({
        action: 'update',
        resourceType: 'managed_image',
        resourceId: id,
        resourceName: image.name,
        details: { unlinkedService: service.name, serviceId },
        userId: request.authUser!.id,
        environmentId: image.environmentId,
      });

      return { service: updatedService };
    }
  );

  // Get services that could be linked (same image name, not already linked)
  fastify.get(
    '/api/managed-images/:id/linkable-services',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const image = await prisma.managedImage.findUnique({ where: { id } });
      if (!image) {
        return reply.code(404).send({ error: 'Managed image not found' });
      }

      const services = await findUnlinkedServicesByImageName(image.environmentId, image.imageName);
      return { services };
    }
  );
}
